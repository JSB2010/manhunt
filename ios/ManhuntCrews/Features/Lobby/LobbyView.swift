import SwiftUI
import CoreLocation

struct LobbyView: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView

    @State private var showConsent = false
    @State private var showCode = false
    @State private var showEdit = false
    @State private var confirmEndNight = false
    @State private var busy = false
    @State private var error: String?
    @State private var startWarnings: [String] = []
    @State private var blocking: [String] = []

    private var myTeam: TeamKey? { view.session.myTeam }
    private var me: OperatorView? { myTeam.flatMap { view.session.team($0)?.me } }
    private var myConsent: Bool { me?.consentGiven ?? false }
    /// My crew plays this round (it may sit out only when crews changed after setup).
    private var myRole: Role? { myTeam.flatMap { round.role(of: $0) } }
    private var crewReady: Bool { myTeam.map { round.isReady($0) } ?? false }
    private var allReady: Bool { round.teams.allSatisfy { round.isReady($0) } }
    private var crewWithoutPhone: Bool { round.teams.contains { !(view.session.team($0)?.hasPhone ?? false) } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    RoundHeader(view: view, round: round)
                }

                RoundSetupSection(view: view, round: round)

                Section("Crews") {
                    ForEach(view.session.teamKeys) { k in
                        if let team = view.session.team(k) {
                            CrewRow(team: team, role: round.role(of: k), ready: round.isReady(k))
                        }
                    }
                }

                if myConsent { PreflightSection() }

                RulesSection(rules: round.rules)

                if !view.previousRounds.isEmpty {
                    Section {
                        NavigationLink { NightSummaryView(sessionId: view.sessionId) } label: {
                            Label("Night So Far (\(view.previousRounds.count) \(view.previousRounds.count == 1 ? "round" : "rounds"))", systemImage: "list.number")
                        }
                    }
                }
            }
            .navigationTitle(view.session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { model.closeSession() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Night Code", systemImage: "qrcode") { showCode = true }
                        Button("Crews & Rules", systemImage: "person.3") { showEdit = true }
                        Divider()
                        Button("End Night", systemImage: "moon.zzz", role: .destructive) { confirmEndNight = true }
                    } label: {
                        Label("Night Options", systemImage: "ellipsis")
                    }
                    .accessibilityIdentifier("lobby.menu")
                }
            }
            .bottomActionBar { actionBar }
            .sheet(isPresented: $showConsent) { ConsentSheet(sessionId: view.sessionId) }
            .sheet(isPresented: $showCode) { NightCodeSheet(sessionId: view.sessionId, code: view.session.joinCode) }
            .sheet(isPresented: $showEdit) { EditNightSheet(view: view) }
            .sheet(isPresented: Binding(get: { !startWarnings.isEmpty || !blocking.isEmpty }, set: { if !$0 { startWarnings = []; blocking = [] } })) {
                StartWarningsSheet(warnings: startWarnings, blocking: blocking) { start(ack: true) }
                    .presentationDetents([.medium, .large])
            }
            .confirmationDialog("End the night?", isPresented: $confirmEndNight, titleVisibility: .visible) {
                Button("End Night", role: .destructive) { perform($busy, $error) { try await model.api.completeSession(view.sessionId) } }
            } message: {
                Text("Played rounds stay in history.")
            }
            .task(id: crewReady) { await lobbyHeartbeat() }
            .errorAlert($error)
        }
    }

    // MARK: Actions

    @ViewBuilder private var actionBar: some View {
        VStack(spacing: 10) {
            if !myConsent {
                Button { showConsent = true } label: { ActionLabel(title: "Review Tracking", systemImage: "doc.text.magnifyingglass") }
                    .floatingProminentButton()
                    .accessibilityIdentifier("lobby.consent")
            } else if crewWithoutPhone {
                Button { showCode = true } label: { ActionLabel(title: "Invite Phones", systemImage: "person.badge.plus") }
                    .floatingProminentButton()
                    .accessibilityIdentifier("lobby.invite")
            } else if myRole != nil {
                if let hint = statusHint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                GlassGroup(spacing: 12) {
                    HStack(spacing: 12) {
                        readyButton
                        Button { start(ack: false) } label: {
                            ActionLabel(title: "Start Round \(round.index)", systemImage: "flag.checkered", busy: busy && allReady)
                        }
                        .floatingButton(prominent: allReady)
                        .disabled(!allReady || busy)
                        .accessibilityIdentifier("lobby.start")
                    }
                }
            }
        }
        .controlSize(.large)
    }

    @ViewBuilder private var readyButton: some View {
        Button { toggleReady() } label: {
            ActionLabel(title: crewReady ? "Ready" : "We’re Ready", systemImage: crewReady ? "checkmark.circle.fill" : "figure.run", busy: busy && !allReady)
        }
        .floatingButton(prominent: !crewReady)
        .disabled(busy)
        .accessibilityIdentifier("lobby.ready")
        .accessibilityValue(crewReady ? "Your crew is ready. Double-tap to undo." : "Not ready")
    }

    private var statusHint: String? {
        guard !allReady else { return nil }
        let waiting = round.teams.filter { !round.isReady($0) }.map { view.session.name($0) }
        return crewReady ? "Waiting for \(waiting.formatted(.list(type: .and)))…" : nil
    }

    /// Keep readiness health fresh while waiting (feeds start preflight checks).
    private func lobbyHeartbeat() async {
        guard crewReady else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            guard crewReady, !Task.isCancelled else { return }
            try? await model.api.setReady(view.sessionId, ready: true, preflight: model.location.health())
        }
    }

    private func toggleReady() {
        guard let role = myRole else { return }
        perform($busy, $error) {
            if crewReady {
                try await model.api.setReady(view.sessionId, ready: false, preflight: model.location.health())
                await model.location.stop(flush: false)
                return
            }
            let status = await model.location.requestPermission()
            guard status == .authorizedWhenInUse || status == .authorizedAlways else {
                throw SimpleError("Location is needed to play. Turn it on in Settings › Manhunt Crews › Location.")
            }
            if !model.location.preciseLocation { await model.location.requestTemporaryPrecise() }
            if !model.notifications.authorized { await model.notifications.requestAuthorization() }
            // Foreground-initiated background session (keeps a pocketed phone tracking when the round starts).
            await model.location.beginPreflight(sessionId: view.sessionId, roundId: round.id, role: role)
            for _ in 0..<10 where model.location.lastFix == nil { try? await Task.sleep(nanoseconds: 500_000_000) }
            try await model.api.setReady(view.sessionId, ready: true, preflight: model.location.health())
        }
    }

    private func start(ack: Bool) {
        startWarnings = []
        blocking = []
        perform($busy, $error) {
            do {
                try await model.api.startRound(view.sessionId, round.id, acknowledgeWarnings: ack)
            } catch let e as APIError {
                if case let .server(_, code, _, details) = e, code == "GPS_UNAVAILABLE" || code == "PERMISSION_REQUIRED" {
                    blocking = details?.blocking ?? []
                    startWarnings = details?.warnings ?? []
                    if blocking.isEmpty && startWarnings.isEmpty { throw e }
                } else { throw e }
            }
        }
    }
}

/// "Round 2 — Foxes hide · Night Owls & Ravens seek (race)".
private struct RoundHeader: View {
    let view: SessionViewDoc
    let round: RoundView

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Round \(round.index)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 6) {
                Label { Text("\(view.session.name(round.hidingTeam)) hide") } icon: {
                    Image(systemName: Role.HIDING.symbol).foregroundStyle(Theme.crew(round.hidingTeam))
                }
                Label {
                    Text("\(round.seekingTeams.map { view.session.name($0) }.formatted(.list(type: .and))) seek\(round.seekingTeams.count > 1 ? (round.seekMode == .RACE ? " — race" : " together") : "")")
                } icon: {
                    Image(systemName: Role.SEEKING.symbol).foregroundStyle(round.seekingTeams.first.map(Theme.crew) ?? .secondary)
                }
            }
            .font(.title3.weight(.semibold))
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// Who hides this round and, with two seeking crews, whether they race. Any phone can change it before the start.
private struct RoundSetupSection: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Section {
            Picker("Hiding", selection: Binding(get: { round.hidingTeam }, set: { k in retarget(hidingTeam: k) })) {
                ForEach(view.session.teamKeys) { Text(view.session.name($0)).tag($0) }
            }
            .accessibilityIdentifier("lobby.hider")
            if round.seekingTeams.count > 1 {
                Picker("Seekers", selection: Binding(get: { round.seekMode }, set: { m in retarget(seekMode: m) })) {
                    ForEach(SeekMode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("lobby.seekMode")
            }
        } footer: {
            if round.seekingTeams.count > 1 {
                Text(round.seekMode == .RACE ? "The crew that makes the catch gets the credit." : "A catch counts for both seeking crews.")
            }
        }
        .disabled(busy)
        .errorAlert($error)
    }

    private func retarget(hidingTeam: TeamKey? = nil, seekMode: SeekMode? = nil) {
        perform($busy, $error) { _ = try await model.api.nextRound(view.sessionId, hidingTeam: hidingTeam, seekMode: seekMode) }
    }
}

/// This phone’s readiness, as plain rows with a status symbol each.
struct PreflightSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let loc = model.location
        Section {
            StatusRow(title: "Location",
                      value: loc.isAuthorized ? (loc.authorization == .authorizedAlways ? "Always" : "While Using") : "Off",
                      state: loc.isAuthorized ? .ok : .problem)
            StatusRow(title: "Precise Location", value: loc.preciseLocation ? "On" : "Approximate", state: loc.preciseLocation ? .ok : .warning)
            StatusRow(title: "Notifications", value: model.notifications.authorized ? "On" : "Off", state: model.notifications.authorized ? .ok : .neutral)
            StatusRow(title: "Network", value: loc.networkReachable ? "Online" : "Offline", state: loc.networkReachable ? .ok : .problem)
            if let fix = loc.lastFix {
                StatusRow(title: "Last GPS Fix", value: "\(Fmt.ago(fix.timestamp, now: Date())) · ±\(Int(fix.horizontalAccuracy)) m", state: .neutral)
            }
        } header: {
            Text("This Phone")
        } footer: {
            if ProcessInfo.processInfo.isLowPowerModeEnabled {
                Label("Low Power Mode can delay background GPS.", systemImage: "battery.25percent")
            }
        }
    }
}

/// A labeled row whose state is shown by symbol shape and colour, plus the value text.
struct StatusRow: View {
    enum State { case ok, warning, problem, neutral }
    let title: String
    let value: String
    let state: State

    var body: some View {
        LabeledContent {
            HStack(spacing: 6) {
                Text(value)
                Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true)
            }
        } label: {
            Text(title)
        }
    }

    private var symbol: String { Self.symbol(for: state) }
    private var tint: Color { Self.tint(for: state) }

    static func symbol(for state: State) -> String {
        switch state {
        case .ok: "checkmark.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .problem: "xmark.octagon.fill"
        case .neutral: "minus.circle"
        }
    }

    static func tint(for state: State) -> Color {
        switch state {
        case .ok: Theme.ok
        case .warning: Theme.warning
        case .problem: Theme.danger
        case .neutral: .secondary
        }
    }
}

struct RulesSection: View {
    let rules: Rules
    var body: some View {
        Section("Rules") {
            LabeledContent("Head start", value: "\(rules.headStartSeconds / 60) min")
            LabeledContent("Pings", value: "every \(rules.pingIntervalSeconds / 60) min")
            LabeledContent("Visible pins", value: rules.visiblePingHistoryCount.map { "Last \($0)" } ?? "All")
            LabeledContent("Time limit", value: rules.maxChaseSeconds.map { "\($0 / 60) min" } ?? "None")
        }
    }
}

/// One agreement covering tracking and post-round sharing for this phone.
struct ConsentSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    bullet("location.fill", "During a round this phone records its route, even when locked.")
                    bullet("eye.slash.fill", "Other crews only ever see scheduled pings of the hiders — never a live position.")
                    bullet("map.fill", "After each round, phones in it see every crew’s route, pings and the catch photo. Raw GPS is deleted after 30 days.")
                } footer: {
                    Text("Tell your crew: everyone on it is shown by this phone’s route.")
                }
            }
            .navigationTitle("Tracking")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } } }
            .bottomActionBar {
                Button {
                    perform($busy, $error) {
                        try await model.api.consent(sessionId, accepted: true)
                        dismiss()
                    }
                } label: {
                    ActionLabel(title: "I Agree", systemImage: "checkmark.shield.fill", busy: busy)
                }
                .floatingProminentButton()
                .controlSize(.large)
                .disabled(busy)
                .accessibilityIdentifier("consent.accept")
            }
            .presentationDetents([.medium, .large])
            .errorAlert($error)
        }
    }

    private func bullet(_ symbol: String, _ text: String) -> some View {
        Label { Text(text) } icon: { Image(systemName: symbol).foregroundStyle(.tint) }
    }
}

/// The night's reusable code: anyone on a crew can show it; joiners pick their crew.
struct NightCodeSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    /// The code from the view; fetched (never re-created) if missing.
    var code: String?
    @State private var invite: InviteCreated?
    @State private var friends: [PublicProfile] = []
    @State private var busy = false
    @State private var error: String?

    private var shownCode: String? { invite?.code ?? code }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let shownCode {
                        VStack(spacing: 12) {
                            Text(shownCode)
                                .font(.system(.largeTitle, design: .monospaced, weight: .bold))
                                .kerning(4)
                                .minimumScaleFactor(0.6)
                                .lineLimit(1)
                                .textSelection(.enabled)
                                .speechSpellsOutCharacters()
                                .accessibilityIdentifier("invite.code")
                            if let url = URL(string: "manhuntcrews://join?code=\(shownCode)") {
                                ShareLink(item: url, message: Text("Join my Manhunt night. Code: \(shownCode)")) {
                                    ActionLabel(title: "Share", systemImage: "square.and.arrow.up")
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.large)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    } else {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    }
                } footer: {
                    Text("Works for every crew until the night ends.")
                }
                Section {
                    Button("New Code", systemImage: "arrow.clockwise") { fetch(regenerate: true) }
                        .disabled(busy)
                }
                if !friends.isEmpty {
                    Section("Invite a Friend") {
                        ForEach(friends) { f in
                            Button { invite(f) } label: {
                                LabeledContent(f.displayName, value: f.handle.map { "@\($0)" } ?? "")
                                    .foregroundStyle(.primary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Night Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("invite.done")
                }
            }
            .task {
                if code == nil { fetch(regenerate: false) }
                friends = (try? await model.api.friends().friends) ?? []
            }
            .presentationDetents([.medium, .large])
            .errorAlert($error)
        }
    }

    private func fetch(regenerate: Bool) {
        perform($busy, $error) { invite = try await model.api.nightCode(sessionId, regenerate: regenerate) }
    }

    private func invite(_ friend: PublicProfile) {
        perform($busy, $error) {
            invite = try await model.api.nightCode(sessionId, targetUid: friend.uid)
            model.show("Invited \(friend.displayName)")
        }
    }
}

struct StartWarningsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let warnings: [String]
    let blocking: [String]
    let onStartAnyway: () -> Void

    var body: some View {
        NavigationStack {
            List {
                if !blocking.isEmpty {
                    Section("Must Be Fixed") {
                        ForEach(blocking, id: \.self) { w in
                            Label { Text(w.warningLabel) } icon: { Image(systemName: "xmark.octagon.fill").foregroundStyle(Theme.danger) }
                        }
                    }
                }
                if !warnings.isEmpty {
                    Section("Location Warnings") {
                        ForEach(warnings, id: \.self) { w in
                            Label { Text(w.warningLabel) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning) }
                        }
                    }
                }
            }
            .navigationTitle("Can’t Start Cleanly")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } } }
            .bottomActionBar {
                if blocking.isEmpty {
                    Button(role: .destructive) { dismiss(); onStartAnyway() } label: {
                        ActionLabel(title: "Start Anyway", systemImage: "flag.checkered")
                    }
                    .floatingButton()
                    .controlSize(.large)
                    .accessibilityIdentifier("warnings.startAnyway")
                }
            }
        }
    }
}
