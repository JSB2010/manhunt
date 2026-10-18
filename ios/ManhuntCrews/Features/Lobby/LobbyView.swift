import SwiftUI
import CoreLocation

struct LobbyView: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView

    @State private var showConsent = false
    @State private var showInvite = false
    @State private var showSetup = false
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
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Round \(round.index) of \(view.session.totalRounds)").font(.headline).foregroundStyle(.secondary)
                        if let h = view.session.team(round.hidingTeam), let s = view.session.team(round.seekingTeam) {
                            Text("\(h.name) hides · \(s.name) seeks").font(.title2.weight(.heavy))
                        }
                        if let o = round.roleOverride {
                            Label("Host changed the suggested roles\(o.reason.map { ": \($0)" } ?? "")", systemImage: "arrow.left.arrow.right").font(.footnote).foregroundStyle(.orange)
                        }
                    }

                    ForEach(TeamKey.allCases) { k in
                        if let team = view.session.team(k) {
                            CrewTile(team: team, role: k == round.hidingTeam ? .HIDING : .SEEKING, ready: round.isReady(k), opponentHealth: round.opponentHealth, inLobby: true)
                        }
                    }

                    if round.index > 1 { RoleSwapChecklist(myRole: round.myRole) }

                    if view.session.isHost && otherTeamMissing {
                        BigButton(title: "Invite the other operator", systemImage: "person.crop.circle.badge.plus", tint: Theme.hiding) { showInvite = true }
                            .accessibilityIdentifier("lobby.invite")
                    }

                    if !myConsent {
                        Card {
                            Label("Before playing", systemImage: "hand.raised.fill").font(.headline)
                            Text("Review how tracking, pings, route sharing and photos work. Nothing is recorded until you accept and a round starts.").font(.callout)
                            BigButton(title: "Review tracking disclosure", systemImage: "doc.text.magnifyingglass") { showConsent = true }
                                .accessibilityIdentifier("lobby.consent")
                        }
                    } else {
                        PreflightCard()
                        BigButton(title: amReady ? "Ready ✓ (tap to undo)" : "I'm ready", systemImage: amReady ? "checkmark.circle.fill" : "figure.run", tint: amReady ? Theme.ok : .accentColor, busy: busy) {
                            toggleReady()
                        }
                        .disabled(otherTeamMissing)
                        .accessibilityIdentifier("lobby.ready")
                    }

                    if view.session.isHost {
                        BigButton(title: "Start round \(round.index)", systemImage: "flag.checkered", tint: Theme.seeking, busy: busy) { start(ack: false) }
                            .disabled(!bothReady)
                            .accessibilityIdentifier("lobby.start")
                        if !bothReady { Text("Both operators must tap Ready. Rounds never start automatically.").font(.footnote).foregroundStyle(.secondary) }
                    } else if bothReady {
                        Label("Waiting for the host to start the round…", systemImage: "hourglass").font(.callout)
                    }

                    RulesSummary(rules: round.rules)

                    if !view.previousRounds.isEmpty {
                        NavigationLink { NightSummaryView(sessionId: view.sessionId) } label: {
                            Label("Night so far (\(view.previousRounds.count) rounds)", systemImage: "list.number")
                        }
                    }

                    Label("Exactly 2 tracking iPhones: one operator per crew. Seeker: passenger only — never the driver.", systemImage: "iphone.gen3.radiowaves.left.and.right")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding()
            }
            .navigationTitle(view.session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { model.closeSession() } }
                if view.session.isHost {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button("Edit setup & rules", systemImage: "slider.horizontal.3") { showSetup = true }
                            if otherTeamMissing { Button("Invite operator", systemImage: "person.badge.plus") { showInvite = true } }
                            if !view.previousRounds.isEmpty {
                                Button("End night now", systemImage: "moon.zzz") { perform($busy, $error) { try await model.api.completeSession(view.sessionId) } }
                            }
                        } label: { Image(systemName: "ellipsis.circle") }
                    }
                }
            }
            .sheet(isPresented: $showConsent) { ConsentSheet(sessionId: view.sessionId) }
            .sheet(isPresented: $showInvite) { InviteSheet(sessionId: view.sessionId) }
            .sheet(isPresented: $showSetup) { EditSetupSheet(view: view, round: round) }
            .sheet(isPresented: Binding(get: { !startWarnings.isEmpty || !blocking.isEmpty }, set: { if !$0 { startWarnings = []; blocking = [] } })) {
                StartWarningsSheet(warnings: startWarnings, blocking: blocking) { start(ack: true) }
                    .presentationDetents([.medium, .large])
            }
            .task(id: amReady) { await lobbyHeartbeat() }
            .errorAlert($error)
        }
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
                throw SimpleError("Location permission is required to play. Enable it in Settings → Manhunt Crews → Location (While Using).")
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

/// Between-rounds physical preparation (spec §3.1, screen 13). Local checklist only.
struct RoleSwapChecklist: View {
    let myRole: Role?
    @State private var checked: Set<Int> = []

    private var items: [String] {
        myRole == .HIDING
            ? ["Your crew is together on foot at the agreed start point", "Phone charged and in a pocket — tracking runs with the screen locked", "Seekers' car is out of sight", "Everyone knows the boundaries you agreed on (the app doesn't enforce any)"]
            : ["Your crew is in the car; a passenger holds this phone", "The driver will not touch the app", "You're at the agreed waiting spot for the head start", "Phone charged / plugged in"]
    }

    var body: some View {
        Card {
            Label("Roles switched — get ready", systemImage: "arrow.triangle.2.circlepath").font(.headline)
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                Button {
                    if checked.contains(i) { checked.remove(i) } else { checked.insert(i) }
                } label: {
                    Label(item, systemImage: checked.contains(i) ? "checkmark.square.fill" : "square")
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct PreflightCard: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        let loc = model.location
        Card {
            Text("This phone").font(.headline)
            HStack {
                StatusPill(text: loc.isAuthorized ? "Location: \(loc.authorization == .authorizedAlways ? "Always" : "While Using")" : "Location off",
                           color: loc.isAuthorized ? Theme.ok : Theme.danger, systemImage: "location.fill")
                StatusPill(text: loc.preciseLocation ? "Precise" : "Approximate", color: loc.preciseLocation ? Theme.ok : .orange)
            }
            HStack {
                StatusPill(text: model.notifications.authorized ? "Notifications on" : "Notifications off", color: model.notifications.authorized ? Theme.ok : .secondary, systemImage: "bell")
                StatusPill(text: loc.networkReachable ? "Online" : "No network", color: loc.networkReachable ? Theme.ok : Theme.danger, systemImage: "wifi")
                StatusPill(text: UIImagePickerController.isSourceTypeAvailable(.camera) ? "Camera ready" : "No camera", color: .secondary, systemImage: "camera")
            }
            if let fix = loc.lastFix {
                Text("Last GPS fix \(Fmt.ago(fix.timestamp, now: Date())) · ±\(Int(fix.horizontalAccuracy)) m").font(.caption).foregroundStyle(.secondary)
            }
            if ProcessInfo.processInfo.isLowPowerModeEnabled {
                Label("Low Power Mode can delay background GPS.", systemImage: "battery.25").font(.caption).foregroundStyle(.orange)
            }
        }
    }
}

struct RulesSummary: View {
    let rules: Rules
    var body: some View {
        Card {
            Text("Rules this round").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow { Text("Head start").foregroundStyle(.secondary); Text("\(rules.headStartSeconds / 60) min") }
                GridRow { Text("First ping").foregroundStyle(.secondary); Text("when head start ends") }
                GridRow { Text("Then every").foregroundStyle(.secondary); Text("\(rules.pingIntervalSeconds / 60) min") }
                GridRow { Text("Visible pins").foregroundStyle(.secondary); Text(rules.visiblePingHistoryCount.map { "last \($0)" } ?? "all") }
                GridRow { Text("Time limit").foregroundStyle(.secondary); Text(rules.maxChaseSeconds.map { "\($0 / 60) min" } ?? "none") }
                GridRow { Text("Confirm window").foregroundStyle(.secondary); Text("\(rules.confirmationTimeoutSeconds) s") }
            }
            .font(.callout)
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
                Section("During each round") {
                    Text("Your phone records your crew's GPS route — including with the screen locked — from the moment the round starts until it ends. You'll see the system location indicator.")
                    Text("The other crew never sees your live route or current position. If you're hiding, they get scheduled pings only (first at the end of the head start, then on the interval). If you're seeking, your car's route stays private too.")
                }
                Section("After each round") {
                    Text("Both operators can view both routes, pings, distances and the catch photo. Raw GPS is kept up to 30 days; simplified routes until deleted. You can delete your own data anytime.")
                }
                Section {
                    CheckRow(text: "I agree to route recording during rounds and post-round route sharing with the other operator.", isOn: $a)
                        .accessibilityIdentifier("consent.t1")
                    CheckRow(text: "My crew knows our operator phone's location, the roster and photos are recorded and shown after rounds.", isOn: $b)
                        .accessibilityIdentifier("consent.t2")
                    CheckRow(text: "I understand GPS and notifications can be delayed; missing fixes are shown as missing.", isOn: $c)
                        .accessibilityIdentifier("consent.t3")
                }
                Section {
                    BigButton(title: "Accept & continue", systemImage: "checkmark.shield", busy: busy) {
                        perform($busy, $error) {
                            try await model.api.consent(sessionId, accepted: true)
                            dismiss()
                        }
                    }
                    .disabled(!(a && b && c))
                    .accessibilityIdentifier("consent.accept")
                } footer: {
                    Text("You can withdraw consent at any time; an active round is then aborted and tracking stops.")
                }
            }
            .navigationTitle("Tracking disclosure")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Not now") { dismiss() } } }
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
                        VStack(spacing: 8) {
                            Text(invite.code).font(.system(size: 44, weight: .heavy, design: .monospaced)).kerning(4).textSelection(.enabled)
                                .accessibilityIdentifier("invite.code")
                            Text("Expires \(Fmt.time(invite.expiresAt)) · single use").font(.footnote).foregroundStyle(.secondary)
                            ShareLink(item: URL(string: invite.deepLink)!, message: Text("Join my Manhunt Crews night as the other crew's operator. Code: \(invite.code)")) {
                                Label("Share invite link", systemImage: "square.and.arrow.up")
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical)
                    } else {
                        Button("Generate code") { generate(target: nil) }
                    }
                } header: { Text("Invite code") }
                if !friends.isEmpty {
                    Section("Or invite a friend directly") {
                        ForEach(friends) { f in
                            Button {
                                generate(target: f.uid)
                            } label: {
                                HStack { Text(f.displayName); Spacer(); Text("@\(f.handle ?? "")").foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Invite operator")
            .toolbar { Button("Done") { dismiss() }.accessibilityIdentifier("invite.done") }
            .task {
                if invite == nil { generate(target: nil) }
                friends = (try? await model.api.friends().friends) ?? []
            }
            .errorAlert($error)
        }
    }

    private func generate(target: String?) {
        perform($busy, $error) {
            invite = try await model.api.createInvite(sessionId, targetUid: target)
            if target != nil { model.show("Invitation sent — it appears on their Home screen") }
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
                    Section("Must be fixed") { ForEach(blocking, id: \.self) { Label($0.warningLabel, systemImage: "xmark.octagon.fill").foregroundStyle(Theme.danger) } }
                }
                if !warnings.isEmpty {
                    Section {
                        ForEach(warnings, id: \.self) { Label($0.warningLabel, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                    } header: { Text("Location health warnings") } footer: {
                        Text("Starting anyway is recorded in the round history. Pings with no fresh, accurate fix are shown as unavailable — never as a stale point.")
                    }
                }
                if blocking.isEmpty {
                    Button("Start anyway", role: .destructive) { dismiss(); onStartAnyway() }
                        .accessibilityIdentifier("warnings.startAnyway")
                }
            }
            .navigationTitle("Can't start cleanly")
            .toolbar { Button("Back") { dismiss() } }
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
                    TextField("Crew A", text: $nameA)
                    TextField("Crew B", text: $nameB)
                }
                RosterEditor(title: "\(nameA) roster", roster: $rosterA, excluded: Set(rosterB.compactMap(\.personId)))
                RosterEditor(title: "\(nameB) roster", roster: $rosterB, excluded: Set(rosterA.compactMap(\.personId)))
                RulesEditor(rules: $rules, lockFirstHider: !view.previousRounds.isEmpty, teamNames: (nameA, nameB))
                Section {
                    Text("Edits apply before the round starts. Both operators must tap Ready again. Changing rules mid-night marks crew comparisons as not directly comparable.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Edit setup")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        perform($busy, $error) {
                            try await model.api.editSetup(view.sessionId, SetupPatchBody(
                                title: title,
                                rules: RulesPatch(rules),
                                teams: ["A": .init(name: nameA, roster: rosterA), "B": .init(name: nameB, roster: rosterB)]))
                            dismiss()
                        }
                    }
                    .disabled(busy)
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
