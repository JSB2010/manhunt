import SwiftUI
import CoreLocation

struct LobbyView: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView

    @State private var showConsent = false
    @State private var showInvite = false
    @State private var showSetup = false
    @State private var confirmEndNight = false
    @State private var busy = false
    @State private var error: String?
    @State private var startWarnings: [String] = []
    @State private var blocking: [String] = []

    private var myTeam: TeamKey? { view.session.myTeam }
    private var amReady: Bool { myTeam.map { round.isReady($0) } ?? false }
    private var bothReady: Bool { round.isReady(.A) && round.isReady(.B) }
    private var myConsent: Bool { myTeam.flatMap { view.session.team($0)?.consentGiven } ?? false }
    private var otherTeamMissing: Bool { TeamKey.allCases.contains { !(view.session.team($0)?.hasOperator ?? false) } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    RoundHeader(view: view, round: round)
                }

                Section("Crews") {
                    ForEach(TeamKey.allCases) { k in
                        if let team = view.session.team(k) {
                            CrewRow(team: team, role: k == round.hidingTeam ? .HIDING : .SEEKING, ready: round.isReady(k), opponentHealth: round.opponentHealth)
                        }
                    }
                }

                if round.index > 1 { RoleSwapChecklist(myRole: round.myRole) }

                if !myConsent {
                    Section {
                        InlineNotice(title: "Before You Play",
                                     message: "Review how tracking, pings, route sharing and photos work. Nothing is recorded until you accept and a round starts.",
                                     systemImage: "hand.raised.fill", tint: .accentColor)
                    }
                } else {
                    PreflightSection()
                }

                RulesSection(rules: round.rules)

                Section {
                    if !view.previousRounds.isEmpty {
                        NavigationLink { NightSummaryView(sessionId: view.sessionId) } label: {
                            Label("Night So Far (\(view.previousRounds.count) rounds)", systemImage: "list.number")
                        }
                    }
                } footer: {
                    Text("Exactly two tracking iPhones: one operator per crew. Seekers ride as passengers — the driver never uses the app.")
                }
            }
            .navigationTitle(view.session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CloseButton { model.closeSession() } }
                if view.session.isHost {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button("Edit Setup & Rules", systemImage: "slider.horizontal.3") { showSetup = true }
                            if otherTeamMissing { Button("Invite Operator", systemImage: "person.badge.plus") { showInvite = true } }
                            if !view.previousRounds.isEmpty {
                                Divider()
                                Button("End Night Now", systemImage: "moon.zzz", role: .destructive) { confirmEndNight = true }
                            }
                        } label: {
                            Label("Night Options", systemImage: "ellipsis")
                        }
                    }
                }
            }
            .bottomActionBar { actionBar }
            .sheet(isPresented: $showConsent) { ConsentSheet(sessionId: view.sessionId) }
            .sheet(isPresented: $showInvite) { InviteSheet(sessionId: view.sessionId) }
            .sheet(isPresented: $showSetup) { EditSetupSheet(view: view, round: round) }
            .sheet(isPresented: Binding(get: { !startWarnings.isEmpty || !blocking.isEmpty }, set: { if !$0 { startWarnings = []; blocking = [] } })) {
                StartWarningsSheet(warnings: startWarnings, blocking: blocking) { start(ack: true) }
                    .presentationDetents([.medium, .large])
            }
            .confirmationDialog("End the night now?", isPresented: $confirmEndNight, titleVisibility: .visible) {
                Button("End Night", role: .destructive) { perform($busy, $error) { try await model.api.completeSession(view.sessionId) } }
            } message: {
                Text("Played rounds are kept in history. No more rounds can be started tonight.")
            }
            .task(id: amReady) { await lobbyHeartbeat() }
            .errorAlert($error)
        }
    }

    // MARK: Actions

    @ViewBuilder private var actionBar: some View {
        let needsInvite = view.session.isHost && otherTeamMissing
        VStack(spacing: 10) {
            if needsInvite {
                Button { showInvite = true } label: { ActionLabel(title: "Invite the Other Operator", systemImage: "person.badge.plus") }
                    .floatingButton(prominent: myConsent)
                    .accessibilityIdentifier("lobby.invite")
            }
            if !myConsent {
                Button { showConsent = true } label: { ActionLabel(title: "Review Tracking Disclosure", systemImage: "doc.text.magnifyingglass") }
                    .floatingProminentButton()
                    .accessibilityIdentifier("lobby.consent")
            } else if !otherTeamMissing {
                if let hint = statusHint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                GlassGroup(spacing: 12) {
                    HStack(spacing: 12) {
                        readyButton
                        if view.session.isHost {
                            Button { start(ack: false) } label: {
                                ActionLabel(title: "Start Round \(round.index)", systemImage: "flag.checkered", busy: busy && bothReady)
                            }
                            .floatingProminentButton()
                            .disabled(!bothReady || busy)
                            .accessibilityIdentifier("lobby.start")
                        }
                    }
                }
            }
        }
        .controlSize(.large)
    }

    @ViewBuilder private var readyButton: some View {
        let button = Button { toggleReady() } label: {
            ActionLabel(title: amReady ? "Ready" : "I’m Ready", systemImage: amReady ? "checkmark.circle.fill" : "figure.run", busy: busy && !bothReady)
        }
        .disabled(otherTeamMissing || busy)
        .accessibilityIdentifier("lobby.ready")
        .accessibilityValue(amReady ? "Ready. Double-tap to undo." : "Not ready")
        // The guest’s only action is prominent; for the host, Start is the prominent action.
        button.floatingButton(prominent: !amReady && !view.session.isHost)
    }

    private var statusHint: String? {
        if !bothReady { return view.session.isHost ? "Both operators tap Ready. Rounds never start automatically." : (amReady ? "Waiting for the other operator…" : nil) }
        return view.session.isHost ? nil : "Waiting for the host to start the round…"
    }

    /// Keep readiness health fresh while waiting for the host (feeds start preflight checks).
    private func lobbyHeartbeat() async {
        guard amReady else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard amReady, !Task.isCancelled else { return }
            try? await model.api.setReady(view.sessionId, ready: true, preflight: model.location.health())
        }
    }

    private func toggleReady() {
        guard let role = round.myRole else { return }
        perform($busy, $error) {
            if amReady {
                try await model.api.setReady(view.sessionId, ready: false, preflight: model.location.health())
                await model.location.stop(flush: false)
                return
            }
            let status = await model.location.requestPermission()
            guard status == .authorizedWhenInUse || status == .authorizedAlways else {
                throw SimpleError("Location permission is required to play. Turn it on in Settings › Manhunt Crews › Location (While Using the App).")
            }
            if !model.location.preciseLocation { await model.location.requestTemporaryPrecise() }
            if !model.notifications.authorized { await model.notifications.requestAuthorization() }
            // Foreground-initiated background session (keeps a pocketed phone tracking when the host starts).
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

/// "Round 2 of 4 — Foxes hide, Night Owls seek".
private struct RoundHeader: View {
    let view: SessionViewDoc
    let round: RoundView

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Round \(round.index) of \(view.session.totalRounds)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            if let h = view.session.team(round.hidingTeam), let s = view.session.team(round.seekingTeam) {
                VStack(alignment: .leading, spacing: 6) { roles(h, s) }
                    .font(.title3.weight(.semibold))
            }
            if let o = round.roleOverride {
                Label("The host changed the suggested roles\(o.reason.map { ": \($0)" } ?? "")", systemImage: "arrow.left.arrow.right")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func roles(_ h: TeamView, _ s: TeamView) -> some View {
        Label { Text("\(h.name) hide") } icon: { Image(systemName: Role.HIDING.symbol).foregroundStyle(Theme.crew(h.key)) }
        Label { Text("\(s.name) seek") } icon: { Image(systemName: Role.SEEKING.symbol).foregroundStyle(Theme.crew(s.key)) }
    }
}

/// Between-rounds physical preparation (spec §3.1, screen 13). Local checklist only.
struct RoleSwapChecklist: View {
    let myRole: Role?
    @State private var checked: Set<String> = []

    private var items: [String] {
        myRole == .HIDING
            ? ["Your crew is together on foot at the agreed start point", "Phone charged and in a pocket — tracking runs with the screen locked", "The seekers’ car is out of sight", "Everyone knows the boundaries you agreed on (the app doesn’t enforce any)"]
            : ["Your crew is in the car; a passenger holds this phone", "The driver won’t touch the app", "You’re at the agreed waiting spot for the head start", "Phone charged or plugged in"]
    }

    var body: some View {
        Section {
            ForEach(items, id: \.self) { item in
                CheckRow(text: item, isOn: Binding(get: { checked.contains(item) }, set: { if $0 { checked.insert(item) } else { checked.remove(item) } }))
            }
        } header: {
            Text("Roles Switched — Get Ready")
        } footer: {
            Text("A reminder for your crew. Nothing here is sent anywhere.")
        }
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
        Section("Rules This Round") {
            LabeledContent("Head start", value: "\(rules.headStartSeconds / 60) min")
            LabeledContent("First ping", value: "When the head start ends")
            LabeledContent("Then every", value: "\(rules.pingIntervalSeconds / 60) min")
            LabeledContent("Visible pins", value: rules.visiblePingHistoryCount.map { "Last \($0)" } ?? "All")
            LabeledContent("Time limit", value: rules.maxChaseSeconds.map { "\($0 / 60) min" } ?? "None")
            LabeledContent("Catch confirmation", value: "\(rules.confirmationTimeoutSeconds) s")
        }
    }
}

struct ConsentSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    @State private var a = false
    @State private var b = false
    @State private var c = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("During Each Round") {
                    Text("Your phone records your crew’s GPS route — including with the screen locked — from the moment the round starts until it ends. You’ll see the system location indicator.")
                    Text("The other crew never sees your live route or current position. If you’re hiding, they get scheduled pings only (first at the end of the head start, then on the interval). If you’re seeking, your car’s route stays private too.")
                }
                Section("After Each Round") {
                    Text("Both operators can view both routes, pings, distances and the catch photo. Raw GPS is kept up to 30 days; simplified routes until deleted. You can delete your own data anytime.")
                }
                Section {
                    CheckRow(text: "I agree to route recording during rounds and post-round route sharing with the other operator.", isOn: $a)
                        .accessibilityIdentifier("consent.t1")
                    CheckRow(text: "My crew knows our operator phone’s location, the roster and photos are recorded and shown after rounds.", isOn: $b)
                        .accessibilityIdentifier("consent.t2")
                    CheckRow(text: "I understand GPS and notifications can be delayed; missing fixes are shown as missing.", isOn: $c)
                        .accessibilityIdentifier("consent.t3")
                } footer: {
                    Text("You can withdraw consent at any time; an active round is then aborted and tracking stops.")
                }
            }
            .navigationTitle("Tracking Disclosure")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } } }
            .bottomActionBar {
                Button {
                    perform($busy, $error) {
                        try await model.api.consent(sessionId, accepted: true)
                        dismiss()
                    }
                } label: {
                    ActionLabel(title: "Accept & Continue", systemImage: "checkmark.shield.fill", busy: busy)
                }
                .floatingProminentButton()
                .controlSize(.large)
                .disabled(!(a && b && c) || busy)
                .accessibilityIdentifier("consent.accept")
            }
            .errorAlert($error)
        }
    }
}

struct InviteSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sessionId: String
    @State private var invite: InviteCreated?
    @State private var friends: [PublicProfile] = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let invite {
                        VStack(spacing: 12) {
                            Text(invite.code)
                                .font(.system(.largeTitle, design: .monospaced, weight: .bold))
                                .kerning(4)
                                .minimumScaleFactor(0.6)
                                .lineLimit(1)
                                .textSelection(.enabled)
                                .speechSpellsOutCharacters()
                                .accessibilityIdentifier("invite.code")
                            Text("Single use · expires \(Fmt.time(invite.expiresAt))")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            if let url = URL(string: invite.deepLink) {
                                ShareLink(item: url, message: Text("Join my Manhunt Crews night as the other crew’s operator. Code: \(invite.code)")) {
                                    ActionLabel(title: "Share Invite Link", systemImage: "square.and.arrow.up")
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.large)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    } else {
                        HStack { Spacer(); ProgressView("Creating a code…"); Spacer() }
                    }
                } header: {
                    Text("Invite Code")
                } footer: {
                    Text("The other operator enters this code under Play › Join with a Code.")
                }
                if !friends.isEmpty {
                    Section("Or Invite a Friend Directly") {
                        ForEach(friends) { f in
                            Button { generate(target: f.uid) } label: {
                                LabeledContent(f.displayName, value: "@\(f.handle ?? "")")
                                    .foregroundStyle(.primary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Invite Operator")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("invite.done")
                }
            }
            .task {
                if invite == nil { generate(target: nil) }
                friends = (try? await model.api.friends().friends) ?? []
            }
            .presentationDetents([.medium, .large])
            .errorAlert($error)
        }
    }

    private func generate(target: String?) {
        perform($busy, $error) {
            invite = try await model.api.createInvite(sessionId, targetUid: target)
            if target != nil { model.show("Invitation sent — it appears on their Play tab") }
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
                    Section {
                        ForEach(warnings, id: \.self) { w in
                            Label { Text(w.warningLabel) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning) }
                        }
                    } header: {
                        Text("Location Health Warnings")
                    } footer: {
                        Text("Starting anyway is recorded in the round history. Pings with no fresh, accurate fix are shown as unavailable — never as a stale point.")
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

struct EditSetupSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let view: SessionViewDoc
    let round: RoundView
    @State private var title = ""
    @State private var nameA = ""
    @State private var nameB = ""
    @State private var rosterA: [RosterEntryBody] = []
    @State private var rosterB: [RosterEntryBody] = []
    @State private var rules = Rules.defaults
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Night") { TextField("Title", text: $title) }
                Section("Crews") {
                    Label { TextField("Crew A name", text: $nameA) } icon: { CrewDot(key: .A) }
                    Label { TextField("Crew B name", text: $nameB) } icon: { CrewDot(key: .B) }
                }
                RosterEditor(title: "\(nameA) Roster", roster: $rosterA, excluded: Set(rosterB.compactMap(\.personId)))
                RosterEditor(title: "\(nameB) Roster", roster: $rosterB, excluded: Set(rosterA.compactMap(\.personId)))
                RulesEditor(rules: $rules, lockFirstHider: !view.previousRounds.isEmpty, teamNames: (nameA, nameB))
                Section {
                } footer: {
                    Text("Edits apply before the round starts. Both operators must tap Ready again. Changing rules mid-night marks crew comparisons as not directly comparable.")
                }
            }
            .navigationTitle("Edit Setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { CancelButton { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    ConfirmButton(title: "Save", busy: busy) {
                        perform($busy, $error) {
                            try await model.api.editSetup(view.sessionId, SetupPatchBody(
                                title: title,
                                rules: RulesPatch(rules),
                                teams: ["A": .init(name: nameA, roster: rosterA), "B": .init(name: nameB, roster: rosterB)]))
                            dismiss()
                        }
                    }
                }
            }
            .onAppear {
                title = view.session.title
                nameA = view.session.team(.A)?.name ?? "Crew A"
                nameB = view.session.team(.B)?.name ?? "Crew B"
                rosterA = view.session.team(.A)?.roster.map { .init(personId: $0.personId, displayName: $0.displayName) } ?? []
                rosterB = view.session.team(.B)?.roster.map { .init(personId: $0.personId, displayName: $0.displayName) } ?? []
                rules = view.session.rules
            }
            .errorAlert($error)
        }
    }
}
