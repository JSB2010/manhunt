import SwiftUI
import MapKit

/// Active round screen for both roles. The map shows (a) this phone’s own live
/// trail and blue dot and (b) only *released* hider pins delivered in the
/// sanitized view. There is no code path that could draw the opponent’s live
/// position: the client never receives it.
///
/// Layout (HIG › Materials): the map is the content layer; the phase HUD, banners
/// and controls float above it on Liquid Glass, inset so the map’s own controls
/// and the Apple Maps legal link stay visible.
struct GameView: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView

    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var showCapture = false
    @State private var showStatus = false
    @State private var busy = false
    @State private var error: String?
    @State private var confirmAbort = false
    @State private var confirmStopTracking = false
    @State private var pauseReason = ""
    @State private var showPausePrompt = false
    @State private var dismissedClaimOutcomeAt: Date?
    /// Lets the map’s own controls live in the floating layer, clear of the HUD.
    @Namespace private var mapScope

    private var role: Role? { round.myRole }
    private var myColor: Color { view.session.myTeam.map(Theme.crew) ?? .accentColor }
    private var hiderColor: Color { Theme.crew(round.hidingTeam) }
    private var carMoving: Bool { role == .SEEKING && (model.location.lastFix?.speed ?? 0) > 4.5 }

    var body: some View {
        map
            .ignoresSafeArea()
            .safeAreaInset(edge: .top, spacing: 8) {
                VStack(spacing: 8) {
                    PhaseBanner(view: view, round: round)
                    banners
                    HStack(alignment: .top) {
                        MapScaleView(scope: mapScope)
                        Spacer()
                        VStack(spacing: 8) {
                            MapUserLocationButton(scope: mapScope)
                                .frame(width: 44, height: 44)
                                .glassSurface(in: Circle(), interactive: true)
                            MapCompass(scope: mapScope)
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal)
            }
            .safeAreaInset(edge: .bottom, spacing: 8) {
                controls
                    .padding(.horizontal)
                    .padding(.bottom, 4)
            }
            .mapScope(mapScope)
            .overlay {
                if round.state == .PAUSED { PausedOverlay(view: view, round: round) }
            }
            .sheet(isPresented: $showCapture) {
                CaptureFlowView(sessionId: view.sessionId, roundId: round.id)
            }
            .sheet(isPresented: $showStatus) {
                PhoneStatusSheet(round: round)
                    .presentationDetents([.medium, .large])
            }
            .sheet(item: Binding(get: { round.myRole == .HIDING ? round.captureRequest.map(IdentifiedRequest.init) : nil }, set: { _ in })) { req in
                HiderConfirmView(sessionId: view.sessionId, roundId: round.id, request: req.request, view: view)
                    .interactiveDismissDisabled()
            }
            .confirmationDialog("Abort this round?", isPresented: $confirmAbort, titleVisibility: .visible) {
                Button("Abort for Safety", role: .destructive) { act { try await model.api.abort(view.sessionId, round.id, reason: "Safety abort from the field", safety: true) } }
                Button("Abort (Everyone Agreed)", role: .destructive) { act { try await model.api.abort(view.sessionId, round.id, reason: "Aborted by agreement", safety: false) } }
                Button("Keep Playing", role: .cancel) {}
            } message: { Text("An aborted round doesn’t count.") }
            .confirmationDialog("Stop tracking this phone?", isPresented: $confirmStopTracking, titleVisibility: .visible) {
                Button("Stop Tracking & Safety Pause", role: .destructive) {
                    act {
                        try await model.api.pause(view.sessionId, round.id, safety: true, reason: "Operator stopped location tracking")
                        await model.location.stop()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Everyone sees that tracking stopped.") }
            .alert("Pause the round?", isPresented: $showPausePrompt) {
                TextField("Reason (optional)", text: $pauseReason)
                Button("Request Pause") { act { try await model.api.pause(view.sessionId, round.id, safety: false, reason: pauseReason.isEmpty ? nil : pauseReason) } }
                Button("Safety Pause Now", role: .destructive) { act { try await model.api.pause(view.sessionId, round.id, safety: true, reason: pauseReason.isEmpty ? nil : pauseReason) } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("A pause starts when the other side confirms; a safety pause starts now.") }
            .errorAlert($error)
    }

    // MARK: Map (content layer)

    private var map: some View {
        Map(position: $camera, scope: mapScope) {
            UserAnnotation()
            if model.location.ownTrail.count > 1 {
                MapPolyline(coordinates: model.location.ownTrail)
                    .stroke(myColor, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            ForEach(round.pins) { pin in
                let latest = pin.index == round.pins.last?.index
                if let acc = pin.accuracyMeters, acc > 0 {
                    MapCircle(center: pin.coordinate, radius: acc)
                        .foregroundStyle(hiderColor.opacity(latest ? 0.18 : 0.08))
                        .stroke(hiderColor.opacity(0.6), lineWidth: 1)
                }
                Annotation(role == .HIDING ? "Seen at ping \(pin.index)" : "Ping \(pin.index)", coordinate: pin.coordinate, anchor: .bottom) {
                    PinMarker(pin: pin, latest: latest, ownPin: role == .HIDING, color: hiderColor)
                        .contextMenu {
                            if role == .SEEKING {
                                Button("Directions", systemImage: "arrow.triangle.turn.up.right.diamond.fill") { Directions.open(to: pin) }
                            }
                        }
                }
                .annotationTitles(.hidden)
            }
        }
        .mapControls { }  // placed in the floating layer instead (see body)
        // Muted emphasis lets released pins and trails stand out (HIG › Maps).
        .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
    }

    // MARK: Banners (functional layer)

    @ViewBuilder private var banners: some View {
        if let notice = model.location.interruptedResumeNotice {
            MapBanner(text: notice, systemImage: "exclamationmark.triangle.fill", tint: Theme.warning, actionTitle: "Dismiss") {
                model.location.dismissResumeNotice()
            }
        }
        if role != nil && model.location.mode != .tracking && round.state != .PAUSED {
            if model.location.isAuthorized {
                MapBanner(text: "Tracking stopped on this phone", systemImage: "location.slash.fill", tint: Theme.danger, actionTitle: "Resume") {
                    if let role, let start = round.roundStartAt {
                        Task { await model.location.beginTracking(sessionId: view.sessionId, roundId: round.id, role: role, roundStartAt: start) }
                    }
                }
            } else {
                MapBanner(text: "Location permission is off — this phone isn’t tracked", systemImage: "location.slash.fill", tint: Theme.danger)
            }
        }
        if role == .HIDING, round.waitingPing != nil {
            MapBanner(text: "Seekers are waiting on your ping. Get signal.", systemImage: "antenna.radiowaves.left.and.right.slash", tint: Theme.warning)
        }
        if let p = round.pendingPauseRequest, role != nil {
            if p.mine {
                MapBanner(text: "Pause requested — waiting for the \(p.bySide == .HIDERS ? "seekers" : "hiders")", systemImage: "pause.circle.fill", tint: Theme.warning)
            } else {
                MapBanner(text: "\(view.session.name(p.byTeam)) asked to pause\(p.reason.map { ": \($0)" } ?? "")",
                          systemImage: "pause.circle.fill", tint: Theme.warning, actionTitle: "Confirm") {
                    act { try await model.api.pause(view.sessionId, round.id, safety: false, reason: p.reason) }
                }
            }
        }
        if role == nil {
            MapBanner(text: "You joined after this round started — watching only.", systemImage: "eye", tint: .secondary)
        }
        if let o = round.lastClaimOutcome, o.status != "CONFIRMED", dismissedClaimOutcomeAt != o.at, ServerClock.shared.now().timeIntervalSince(o.at) < 180 {
            MapBanner(text: o.status == "REJECTED" ? "Catch rejected\(o.reason.map { ": \($0)" } ?? "") — round resumed" : "Catch claim expired — round resumed",
                      systemImage: "camera.badge.ellipsis", tint: Theme.warning, actionTitle: "Dismiss") { dismissedClaimOutcomeAt = o.at }
        }
        if carMoving {
            MapBanner(text: "Car is moving — passenger only.", systemImage: "car.fill", tint: Theme.warning)
        }
    }

    // MARK: Controls (functional layer)

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(alignment: .bottom, spacing: 8) {
                PingChip(round: round)
                Spacer(minLength: 0)
                HealthChip(round: round) { showStatus = true }
                    .layoutPriority(1)
            }
            GlassGroup(spacing: 12) {
                HStack(spacing: 12) {
                    Menu {
                        if round.rules.manualPausesEnabled && role != nil { Button("Pause…", systemImage: "pause") { showPausePrompt = true } }
                        Button("Safety Pause Now", systemImage: "exclamationmark.octagon") { act { try await model.api.pause(view.sessionId, round.id, safety: true, reason: nil) } }
                        Button("Phone Status", systemImage: "antenna.radiowaves.left.and.right") { showStatus = true }
                        Divider()
                        Button("Stop Tracking This Phone", systemImage: "location.slash") { confirmStopTracking = true }
                        Button("Abort Round", systemImage: "xmark.octagon", role: .destructive) { confirmAbort = true }
                    } label: {
                        Label("Round Options", systemImage: "ellipsis")
                            .labelStyle(.iconOnly)
                            .frame(minWidth: 24, minHeight: 24)
                    }
                    .floatingButton()
                    .buttonBorderShape(.circle)

                    primaryControl

                    if role == .SEEKING, let pin = round.pins.last {
                        Button { Directions.open(to: pin) } label: {
                            Label("Directions", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                                .labelStyle(.iconOnly)
                                .frame(minWidth: 24, minHeight: 24)
                        }
                        .floatingButton()
                        .buttonBorderShape(.circle)
                        .accessibilityLabel("Directions to ping \(pin.index)")
                        .accessibilityHint("Opens driving directions in Maps")
                        .accessibilityIdentifier("game.directions")
                    }

                    Button { model.closeSession() } label: {
                        Label("Home", systemImage: "house.fill")
                            .labelStyle(.iconOnly)
                            .frame(minWidth: 24, minHeight: 24)
                    }
                    .floatingButton()
                    .buttonBorderShape(.circle)
                    .accessibilityHint("Tracking continues in the background while the round is active")
                }
            }
            .controlSize(.large)
        }
    }

    @ViewBuilder private var primaryControl: some View {
        if role == .SEEKING {
            Button { showCapture = true } label: {
                ActionLabel(title: round.state == .CAPTURE_PENDING ? pendingTitle : "Photo Catch", systemImage: "camera.fill")
            }
            .floatingProminentButton()
            .disabled(round.state != .CHASE)
            .accessibilityIdentifier("game.photoCatch")
        } else if role == .HIDING {
            SharingStatus(active: model.location.mode == .tracking)
        } else {
            Spacer()
        }
    }

    /// While a claim is reviewed: "Awaiting confirmation" for the claiming crew, who claimed for everyone else.
    private var pendingTitle: String {
        if round.myClaim != nil { return "Awaiting Confirmation" }
        return round.claimByTeam.map { "\(view.session.name($0)) Claimed" } ?? "Catch Under Review"
    }

    private func act(_ work: @escaping () async throws -> Void) { perform($busy, $error, work) }
}

/// One-tap driving directions to a released ping in Apple Maps.
enum Directions {
    @MainActor
    static func open(to pin: PinView) {
        let item: MKMapItem
        if #available(iOS 26.0, *) {
            item = MKMapItem(location: CLLocation(latitude: pin.latitude, longitude: pin.longitude), address: nil)
        } else {
            item = MKMapItem(placemark: MKPlacemark(coordinate: pin.coordinate))
        }
        item.name = "Ping #\(pin.index) · \(Fmt.ago(pin.scheduledAt, now: ServerClock.shared.now()))"
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}

private struct IdentifiedRequest: Identifiable {
    let request: CaptureRequestView
    var id: String { request.claimId }
}

/// Status line floating over the map: symbol carries colour and shape; text stays primary.
struct MapBanner: View {
    let text: String
    let systemImage: String
    let tint: Color
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
                .font(.body.weight(.semibold))
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.semibold))
                    .floatingButton()
                    .controlSize(.small)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, actionTitle == nil ? 14 : 6)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .glassSurface(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Hiding operator’s sharing indicator, in place of the seeker’s Photo Catch button.
private struct SharingStatus: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Label {
            Text(active ? "Sharing scheduled pings only" : "Location sharing off")
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        } icon: {
            Image(systemName: active ? "dot.radiowaves.left.and.right" : "location.slash.fill")
                .foregroundStyle(active ? Theme.ok : Theme.danger)
                .symbolEffect(.pulse, isActive: active && !reduceMotion)
        }
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity, minHeight: 44)
        .padding(.horizontal, 12)
        .glassSurface()
        .accessibilityElement(children: .combine)
        .accessibilityHint(active ? "Your exact route stays hidden. The other crew only sees scheduled pings." : "")
    }
}

/// Released hider ping marker: diamond shape + index (not colour alone).
struct PinMarker: View {
    let pin: PinView
    let latest: Bool
    let ownPin: Bool
    let color: Color
    @ScaledMetric(relativeTo: .title) private var latestSize: CGFloat = 34
    @ScaledMetric(relativeTo: .body) private var olderSize: CGFloat = 22

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { _ in
            let now = ServerClock.shared.now()
            let size = latest ? latestSize : olderSize
            VStack(spacing: 4) {
                if latest {
                    Text(ownPin ? "Seen \(Fmt.ago(pin.scheduledAt, now: now))" : "Ping \(pin.index) · \(Fmt.ago(pin.scheduledAt, now: now))")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.regularMaterial, in: Capsule())
                }
                ZStack {
                    Image(systemName: "diamond.fill")
                        .font(.system(size: size, weight: .bold))
                        .foregroundStyle(color.opacity(latest ? 1 : 0.65))
                    Image(systemName: "diamond")
                        .font(.system(size: size, weight: .bold))
                        .foregroundStyle(.white.opacity(0.9))
                    Text("\(pin.index)")
                        .font(.system(size: size * 0.38, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                }
                .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(ownPin ? "Ping the seekers saw" : "Hiding crew ping") \(pin.index), \(Fmt.ago(pin.scheduledAt, now: now)), GPS sample \(pin.ageSeconds ?? 0) seconds old, accurate to \(Int(pin.accuracyMeters ?? 0)) meters")
        }
    }
}

/// The most recent ping (or why there isn’t one) as a compact glass chip.
struct PingChip: View {
    let round: RoundView

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = ServerClock.shared.now()
            Group {
                if let w = round.waitingPing {
                    chip(symbol: "antenna.radiowaves.left.and.right", tint: Theme.warning,
                         text: "Ping \(w.index): waiting for GPS · \(Fmt.clock(max(0, now.timeIntervalSince(w.since))))")
                        .symbolEffect(.pulse)
                        .accessibilityLabel("Ping \(w.index) is waiting for the hiders’ GPS. It goes out as soon as it arrives.")
                        .accessibilityIdentifier("game.waitingPing")
                } else if let last = round.pingLog.last, last.isMissing {
                    chip(symbol: "location.slash.fill", tint: Theme.warning, text: "Ping \(last.index): no fresh GPS")
                        .accessibilityLabel("Ping \(last.index) unavailable — the hiding crew had no fresh GPS fix")
                } else if let pin = round.pins.last {
                    let mine = round.myRole == .HIDING
                    chip(symbol: "diamond.fill", tint: Theme.crew(round.hidingTeam),
                         text: "\(mine ? "Seen at ping" : "Ping") #\(pin.index) · \(Fmt.ago(pin.scheduledAt, now: now))\(pin.delayed ? " · late" : "")")
                        .accessibilityLabel("Last hider ping #\(pin.index), \(Fmt.ago(pin.scheduledAt, now: now)). GPS sample \(pin.ageSeconds.map { "\($0) seconds" } ?? "age unknown") old, accurate to \(Int(pin.accuracyMeters ?? 0)) meters\(pin.delayed ? ", released late" : "")")
                        .accessibilityIdentifier("game.lastPing")
                }
            }
        }
    }

    private func chip(symbol: String, tint: Color, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true)
            Text(text).lineLimit(2)
        }
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(minHeight: 36)
        .glassSurface()
        .accessibilityElement(children: .combine)
    }
}

/// One-glance health summary (worst issue first). Tapping opens Phone Status.
struct HealthChip: View {
    @Environment(AppModel.self) private var model
    let round: RoundView
    let open: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            let s = summary
            Button(action: open) {
                HStack(spacing: 6) {
                    Image(systemName: s.symbol).foregroundStyle(s.tint).accessibilityHidden(true)
                    Text(s.text).lineLimit(2).multilineTextAlignment(.leading)
                }
                .font(.footnote.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(minHeight: 36)
                .glassSurface(interactive: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Phone status: \(s.text)")
            .accessibilityHint("Shows GPS, network and the other crew’s tracking status")
        }
    }

    private var summary: (text: String, symbol: String, tint: Color) {
        let loc = model.location
        if !loc.networkReachable { return ("Offline", "wifi.slash", Theme.danger) }
        if !loc.preciseLocation { return ("Precise Location off", "location.slash.fill", Theme.danger) }
        // Worst other crew first: e.g. "Hiders: no signal".
        let others = round.teams.filter { $0 != round.myTeam }.compactMap { k in round.status(k).map { (k, HealthPresentation(status: $0)) } }
        let worst = others.max { rank($0.1.state) < rank($1.1.state) }
        let label = { (k: TeamKey) in round.role(of: k) == .HIDING ? "Hiders" : "Seekers" }
        if let (k, p) = worst, p.state == .problem { return ("\(label(k)): \(p.text.lowercased())", p.symbol, p.tint) }
        guard let age = loc.lastFixAge else { return ("No GPS fix yet", "location", Theme.warning) }
        if age > 60 { return ("GPS stale \(Int(age))s", "exclamationmark.triangle.fill", Theme.warning) }
        if let (k, p) = worst, p.isProblem { return ("\(label(k)): \(p.text.lowercased())", p.symbol, p.tint) }
        if loc.uploadsFailing { return ("\(loc.queuedSamples) unsent", "tray.full.fill", Theme.warning) }
        return ("GPS ±\(Int(loc.lastFix?.horizontalAccuracy ?? 0)) m", "location.fill", Theme.ok)
    }

    private func rank(_ s: StatusRow.State) -> Int {
        switch s {
        case .problem: 3
        case .warning: 2
        case .neutral: 1
        case .ok: 0
        }
    }
}

/// Full health detail for both phones (coarse status only for the other phone).
struct PhoneStatusSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let round: RoundView

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 2)) { _ in
                let loc = model.location
                List {
                    Section("This Phone") {
                        if let age = loc.lastFixAge {
                            StatusRow(title: "GPS fix", value: "\(Int(age))s ago · ±\(Int(loc.lastFix?.horizontalAccuracy ?? 0)) m", state: age > 60 ? .warning : .ok)
                        } else {
                            StatusRow(title: "GPS fix", value: "None yet", state: .warning)
                        }
                        StatusRow(title: "Precise Location", value: loc.preciseLocation ? "On" : "Off", state: loc.preciseLocation ? .ok : .problem)
                        StatusRow(title: "Network", value: loc.networkReachable ? "Online" : "Offline", state: loc.networkReachable ? .ok : .problem)
                        StatusRow(title: "Unsent samples", value: "\(loc.queuedSamples)", state: loc.queuedSamples > 0 ? .warning : .ok)
                        if let d = loc.lastDiagnostic { StatusRow(title: "Diagnostic", value: d, state: .warning) }
                    }
                    ForEach(round.teams, id: \.self) { k in
                        if let st = round.status(k) {
                            Section(k == round.myTeam ? "Your Crew" : round.role(of: k) == .HIDING ? "Hiders" : "Seekers") {
                                let p = HealthPresentation(status: st)
                                StatusRow(title: "Phones", value: p.text, state: p.state)
                                ForEach(HealthPresentation.extraIssues(st), id: \.self) { issue in
                                    StatusRow(title: "Note", value: issue, state: .warning)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Phone Status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { CloseButton { dismiss() } } }
        }
    }
}
