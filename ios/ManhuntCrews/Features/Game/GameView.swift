import SwiftUI
import MapKit

/// Active round screen for both roles. The map shows (a) this phone's own live
/// trail and blue dot and (b) only *released* hider pins delivered in the
/// sanitized view. There is no code path that could draw the opponent's live
/// position: the client never receives it.
struct GameView: View {
    @Environment(AppModel.self) private var model
    let view: SessionViewDoc
    let round: RoundView

    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var showCapture = false
    @State private var busy = false
    @State private var error: String?
    @State private var confirmAbort = false
    @State private var confirmStopTracking = false
    @State private var pauseReason = ""
    @State private var showPausePrompt = false
    @State private var dismissedClaimOutcomeAt: Date?

    private var role: Role? { round.myRole }
    private var myColor: Color { role == .HIDING ? Theme.hiding : Theme.seeking }

    var body: some View {
        ZStack(alignment: .top) {
            map.ignoresSafeArea()
            VStack(spacing: 8) {
                PhaseBanner(view: view, round: round)
                banners
                Spacer()
                bottomPanel
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            if round.state == .PAUSED { PausedOverlay(view: view, round: round) }
        }
        .sheet(isPresented: $showCapture) {
            CaptureFlowView(sessionId: view.sessionId, roundId: round.id)
        }
        .sheet(item: Binding(get: { round.myRole == .HIDING ? round.captureRequest.map(IdentifiedRequest.init) : nil }, set: { _ in })) { req in
            HiderConfirmView(sessionId: view.sessionId, roundId: round.id, request: req.request, view: view)
                .interactiveDismissDisabled()
        }
        .confirmationDialog("Abort this round?", isPresented: $confirmAbort, titleVisibility: .visible) {
            Button("Abort for safety", role: .destructive) { act { try await model.api.abort(view.sessionId, round.id, reason: "Safety abort from the field", safety: true) } }
            Button("Abort (both crews agreed)", role: .destructive) { act { try await model.api.abort(view.sessionId, round.id, reason: "Aborted by agreement", safety: false) } }
            Button("Keep playing", role: .cancel) {}
        } message: { Text("The round is recorded as aborted, not caught. It won't count toward crew comparisons.") }
        .confirmationDialog("Stop tracking this phone?", isPresented: $confirmStopTracking, titleVisibility: .visible) {
            Button("Stop tracking & safety pause", role: .destructive) {
                act {
                    try await model.api.pause(view.sessionId, round.id, safety: true, reason: "Operator stopped location tracking")
                    await model.location.stop()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Both crews will see that tracking stopped. Pings can't be released while it's off — this affects fairness.") }
        .alert("Pause the round?", isPresented: $showPausePrompt) {
            TextField("Reason (optional)", text: $pauseReason)
            Button("Request pause") { act { try await model.api.pause(view.sessionId, round.id, safety: false, reason: pauseReason.isEmpty ? nil : pauseReason) } }
            Button("SAFETY pause now", role: .destructive) { act { try await model.api.pause(view.sessionId, round.id, safety: true, reason: pauseReason.isEmpty ? nil : pauseReason) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("A normal pause needs the other operator to confirm. A safety pause takes effect immediately for both crews.") }
        .errorAlert($error)
    }

    // MARK: Map

    private var map: some View {
        Map(position: $camera) {
            UserAnnotation()
            if model.location.ownTrail.count > 1 {
                MapPolyline(coordinates: model.location.ownTrail)
                    .stroke(myColor, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            ForEach(round.pins) { pin in
                let latest = pin.index == round.pins.last?.index
                if let acc = pin.accuracyMeters, acc > 0 {
                    MapCircle(center: pin.coordinate, radius: acc)
                        .foregroundStyle(Theme.hiding.opacity(latest ? 0.18 : 0.08))
                        .stroke(Theme.hiding.opacity(0.5), lineWidth: 1)
                }
                Annotation(role == .HIDING ? "Seen #\(pin.index)" : "Ping #\(pin.index)", coordinate: pin.coordinate, anchor: .bottom) {
                    PinMarker(pin: pin, latest: latest, ownPin: role == .HIDING)
                }
            }
        }
        .mapControls {
            MapUserLocationButton()
            MapCompass()
            MapScaleView()
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
    }

    // MARK: Banners

    @ViewBuilder private var banners: some View {
        if let notice = model.location.interruptedResumeNotice {
            BannerRow(text: notice, color: .orange, icon: "exclamationmark.triangle.fill") { model.location.dismissResumeNotice() }
        }
        if role != nil && model.location.mode != .tracking && round.state != .PAUSED {
            BannerRow(text: model.location.isAuthorized ? "Tracking stopped on this phone — tap to resume" : "Location permission is off — this phone isn't tracked", color: Theme.danger, icon: "location.slash.fill") {
                if let role, let start = round.roundStartAt {
                    Task { await model.location.beginTracking(sessionId: view.sessionId, roundId: round.id, role: role, roundStartAt: start) }
                }
            }
        }
        if let p = round.pendingPauseRequest {
            if p.mine {
                BannerRow(text: "Pause requested — waiting for the other operator", color: .orange, icon: "pause.circle")
            } else {
                HStack {
                    Label("\(view.session.team(p.byTeam)?.name ?? "Other crew") asked to pause\(p.reason.map { ": \($0)" } ?? "")", systemImage: "pause.circle.fill")
                        .font(.callout.weight(.semibold))
                    Spacer()
                    Button("Confirm") { act { try await model.api.pause(view.sessionId, round.id, safety: false, reason: p.reason) } }
                        .buttonStyle(.borderedProminent)
                }
                .padding(10)
                .background(.thickMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        if let o = round.lastClaimOutcome, o.status != "CONFIRMED", dismissedClaimOutcomeAt != o.at, ServerClock.shared.now().timeIntervalSince(o.at) < 180 {
            BannerRow(text: o.status == "REJECTED" ? "Catch rejected\(o.reason.map { ": \($0)" } ?? "") — round resumed" : "Catch claim expired — round resumed",
                      color: .orange, icon: "camera.badge.ellipsis") { dismissedClaimOutcomeAt = o.at }
        }
        if role == .SEEKING, let speed = model.location.lastFix?.speed, speed > 4.5 {
            BannerRow(text: "Car is moving — passenger only. The driver must never use this app.", color: .yellow, icon: "car.fill")
        }
    }

    // MARK: Bottom

    private var bottomPanel: some View {
        VStack(spacing: 10) {
            PingStatusRow(round: round)
            HealthStrip(round: round)
            if role == .SEEKING {
                Label("PASSENGER ONLY", systemImage: "person.fill.checkmark")
                    .font(.caption.weight(.heavy)).foregroundStyle(.yellow)
                BigButton(title: round.state == .CAPTURE_PENDING ? "Waiting for confirmation…" : "PHOTO CATCH", systemImage: "camera.fill", tint: Theme.seeking) {
                    showCapture = true
                }
                .disabled(round.state != .CHASE)
                .accessibilityIdentifier("game.photoCatch")
            } else if role == .HIDING {
                HStack {
                    Image(systemName: "dot.radiowaves.up.forward").symbolEffect(.pulse, isActive: model.location.mode == .tracking)
                    Text(model.location.mode == .tracking ? "Location sharing ACTIVE — exact route hidden; scheduled pings only" : "Location sharing OFF")
                        .font(.callout.weight(.bold))
                }
                .foregroundStyle(model.location.mode == .tracking ? Theme.hiding : Theme.danger)
                .padding(10)
                .frame(maxWidth: .infinity)
                .background(.thickMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
            HStack {
                Menu {
                    if round.rules.manualPausesEnabled { Button("Pause…", systemImage: "pause") { showPausePrompt = true } }
                    Button("Safety pause now", systemImage: "exclamationmark.octagon") { act { try await model.api.pause(view.sessionId, round.id, safety: true, reason: nil) } }
                    Button("Stop tracking this phone", systemImage: "location.slash") { confirmStopTracking = true }
                    Button("Abort round", systemImage: "xmark.octagon", role: .destructive) { confirmAbort = true }
                } label: {
                    Label("Round options", systemImage: "ellipsis.circle").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                Button { model.closeSession() } label: {
                    Label("Home", systemImage: "house").frame(minHeight: 44)
                }
                .buttonStyle(.bordered)
                .accessibilityHint("Tracking continues in the background while the round is active")
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }

    private func act(_ work: @escaping () async throws -> Void) { perform($busy, $error, work) }
}

private struct IdentifiedRequest: Identifiable {
    let request: CaptureRequestView
    var id: String { request.claimId }
}

struct BannerRow: View {
    let text: String
    let color: Color
    let icon: String
    var action: (() -> Void)?
    var body: some View {
        Button { action?() } label: {
            Label(text, systemImage: icon)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(color.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
                .background(.thickMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

/// Released hider ping marker: shape + label (not color alone) for colorblind safety.
struct PinMarker: View {
    let pin: PinView
    let latest: Bool
    let ownPin: Bool
    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { _ in
            let now = ServerClock.shared.now()
            VStack(spacing: 2) {
                Text(ownPin ? "Seekers saw you \(Fmt.ago(pin.scheduledAt, now: now))" : "Ping #\(pin.index) · \(Fmt.ago(pin.scheduledAt, now: now))")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(.thickMaterial, in: Capsule())
                ZStack {
                    Image(systemName: latest ? "diamond.fill" : "diamond")
                        .font(.system(size: latest ? 30 : 20, weight: .bold))
                        .foregroundStyle(Theme.hiding.opacity(latest ? 1 : 0.55))
                    Text("\(pin.index)").font(.system(size: latest ? 12 : 9, weight: .heavy)).foregroundStyle(latest ? .white : Theme.hiding)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Released hiding crew ping \(pin.index), \(Fmt.ago(pin.scheduledAt, now: now)), GPS sample age \(pin.ageSeconds ?? 0) seconds, accuracy \(Int(pin.accuracyMeters ?? 0)) meters")
        }
    }
}

struct PingStatusRow: View {
    let round: RoundView
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = ServerClock.shared.now()
            VStack(alignment: .leading, spacing: 4) {
                if let pin = round.pins.last {
                    Text("Last hider ping #\(pin.index) · \(Fmt.ago(pin.scheduledAt, now: now)) (GPS sample age \(pin.ageSeconds.map { "\($0)s" } ?? "—"), ±\(Int(pin.accuracyMeters ?? 0)) m\(pin.delayed ? ", released late" : ""))")
                        .font(.footnote.weight(.semibold))
                        .accessibilityIdentifier("game.lastPing")
                }
                if let last = round.pingLog.last, last.isMissing {
                    Label("Ping #\(last.index) unavailable — no fresh GPS fix from the hiding crew", systemImage: "location.slash")
                        .font(.footnote.weight(.semibold)).foregroundStyle(.orange)
                }
                if round.pingLog.isEmpty && round.state == .HEAD_START {
                    Text(round.myRole == .SEEKING ? "No pings yet — the first releases when the head start ends." : "Seekers get their first ping of you when the head start ends.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct HealthStrip: View {
    @Environment(AppModel.self) private var model
    let round: RoundView
    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            let loc = model.location
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if let age = loc.lastFixAge {
                        StatusPill(text: age > 60 ? "GPS stale \(Int(age))s" : "GPS \(Int(age))s · ±\(Int(loc.lastFix?.horizontalAccuracy ?? 0))m",
                                   color: age > 60 ? .orange : Theme.ok, systemImage: "location.fill")
                    } else {
                        StatusPill(text: "No GPS fix yet", color: .orange, systemImage: "location")
                    }
                    if !loc.preciseLocation { StatusPill(text: "Precise Location off", color: Theme.danger) }
                    StatusPill(text: loc.networkReachable ? "Online" : "No network", color: loc.networkReachable ? Theme.ok : Theme.danger, systemImage: "wifi")
                    if loc.queuedSamples > 0 { StatusPill(text: "\(loc.queuedSamples) unsent", color: .orange, systemImage: "tray.full") }
                    if let d = loc.lastDiagnostic { StatusPill(text: d, color: .orange) }
                    HealthIntegrityPill(health: round.opponentHealth)
                }
            }
        }
    }
}
