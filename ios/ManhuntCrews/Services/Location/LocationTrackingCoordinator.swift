import Foundation
import CoreLocation
import Network
import Observation
import UIKit

/// Background GPS tracking for the active round (spec §5.2).
///
/// - Uses `CLLocationUpdate.liveUpdates` + `CLBackgroundActivitySession` (iOS 17+)
///   and `CLServiceSession` (iOS 18) so tracking continues with the screen
///   locked under "While Using" authorization, with the system's blue indicator.
/// - Starts only from an explicit foreground action (Ready / round start) and
///   stops at round end, consent withdrawal, logout or a manual safety stop.
/// - iOS may still suspend or delay delivery, and a force-quit stops it;
///   health reflects that honestly instead of pretending fixes are fresh.
@MainActor
@Observable
final class LocationTrackingCoordinator: NSObject, CLLocationManagerDelegate {
    enum Mode: Equatable { case idle, preflight, tracking }

    // Observable state for UI
    private(set) var mode: Mode = .idle
    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    private(set) var preciseLocation: Bool = true
    private(set) var lastFix: CLLocation?
    private(set) var lastDiagnostic: String?
    /// This phone's trail for the round being tracked (never the previous round's).
    private(set) var ownTrail = OwnTrail()
    private(set) var queuedSamples: Int = 0
    private(set) var networkReachable: Bool = true
    private(set) var lastUploadAt: Date?
    private(set) var lastUploadError: String?
    private(set) var interruptedResumeNotice: String?
    private(set) var role: Role?
    /// Unsent fixes are normal between batches (seekers upload every 90 s); they only
    /// matter while uploads are failing.
    var uploadsFailing: Bool { queuedSamples > 0 && consecutiveFailures > 0 }

    private let manager = CLLocationManager()
    private var updatesTask: Task<Void, Never>?
    private var uploadTask: Task<Void, Never>?
    private var backgroundSession: CLBackgroundActivitySession?
    private var serviceSession: CLServiceSession?
    private var filter = SampleFilter()
    private let pathMonitor = NWPathMonitor()
    private let queue: TelemetryQueue
    private var api: APIClient?
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private let persistedContextKey = "mh.tracking.context"

    // Upload pacing (ADR 0016): hiders upload often (their fixes become pings), seekers rarely
    // (their track only matters after the round). Failures back off; a reconnect flushes at once.
    private var uploading = false
    private var consecutiveFailures = 0
    private var lastAttemptAt = Date.distantPast
    private var lastHealthSent: HealthPayload?
    /// Server time of the next ping deadline, and whether a ping is waiting for the hiders' GPS.
    private var nextPingAt: Date?
    private var pingWaiting = false
    private var trailFetchedRoundId: String?
    /// Called when the network comes back (the app reconciles its view then).
    var onReconnect: (() -> Void)?

    static let hiderCadence: TimeInterval = 15
    static let seekerCadence: TimeInterval = 90
    /// Health-only batches at most this often when nothing changed.
    static let heartbeatInterval: TimeInterval = 60

    init(queue: TelemetryQueue = TelemetryQueue()) {
        self.queue = queue
        super.init()
        manager.delegate = self
        authorization = manager.authorizationStatus
        preciseLocation = manager.accuracyAuthorization == .fullAccuracy
        UIDevice.current.isBatteryMonitoringEnabled = true
        pathMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let wasReachable = self.networkReachable
                self.networkReachable = path.status == .satisfied
                if !wasReachable && self.networkReachable { self.reconnected() }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "mh.path"))
    }

    func attach(api: APIClient) { self.api = api }

    // MARK: Permission

    var isAuthorized: Bool { authorization == .authorizedWhenInUse || authorization == .authorizedAlways }

    var permissionString: String {
        switch authorization {
        case .authorizedAlways: "ALWAYS"
        case .authorizedWhenInUse: "WHEN_IN_USE"
        case .denied: "DENIED"
        case .restricted: "RESTRICTED"
        default: "NOT_DETERMINED"
        }
    }

    /// Ask for While-Using authorization (enough for background tracking with a
    /// background activity session). Returns the resulting status.
    func requestPermission() async -> CLAuthorizationStatus {
        if authorization != .notDetermined { return authorization }
        return await withCheckedContinuation { cont in
            authContinuation = cont
            manager.requestWhenInUseAuthorization()
        }
    }

    func requestTemporaryPrecise() async {
        guard manager.accuracyAuthorization != .fullAccuracy else { return }
        try? await manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "RoundTracking")
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        let precise = manager.accuracyAuthorization == .fullAccuracy
        Task { @MainActor in
            self.authorization = status
            self.preciseLocation = precise
            if status != .notDetermined, let c = self.authContinuation {
                self.authContinuation = nil
                c.resume(returning: status)
            }
        }
    }

    // MARK: Health

    func health(lastFixFallback: CLLocation? = nil) -> HealthPayload {
        let fix = lastFix ?? lastFixFallback
        let battery = UIDevice.current.batteryLevel
        return HealthPayload(
            permission: permissionString,
            preciseLocation: preciseLocation,
            trackingActive: mode != .idle,
            backgroundSessionActive: backgroundSession != nil,
            lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
            batteryLevel: battery >= 0 ? Double(battery) : nil,
            networkReachable: networkReachable,
            appVersion: AppEnvironment.current.appVersion,
            queuedSamples: queuedSamples,
            lastFixAgeSeconds: fix.map { max(0, Date().timeIntervalSince($0.timestamp)) },
            lastFixAccuracyMeters: fix.map { $0.horizontalAccuracy })
    }

    /// Age of the newest fix (device clock), for "GPS sample age" displays.
    var lastFixAge: TimeInterval? { lastFix.map { Date().timeIntervalSince($0.timestamp) } }

    // MARK: Lifecycle

    /// Foreground-initiated preflight when the operator taps Ready: begins the
    /// background-capable session so a pocketed phone keeps running when the
    /// host starts the round. Samples are not uploaded until the round starts.
    func beginPreflight(sessionId: String, roundId: String, role: Role) async {
        guard isAuthorized else { return }
        await queue.setContext(.init(sessionId: sessionId, roundId: roundId, role: role, roundStartAt: nil))
        startUpdates(role: role)
        if mode == .idle { mode = .preflight }
        persistContext(sessionId: sessionId, roundId: roundId, role: role, roundStartAt: nil)
    }

    /// Round is live (HEAD_START or later): record and upload private samples.
    func beginTracking(sessionId: String, roundId: String, role: Role, roundStartAt: Date) async {
        guard isAuthorized else {
            lastDiagnostic = "Location permission is off — tracking cannot run."
            return
        }
        let ctx = TelemetryQueue.Context(sessionId: sessionId, roundId: roundId, role: role, roundStartAt: roundStartAt)
        // Ready already set this round's queue context, so the trail checks its own round.
        ownTrail = ownTrail.continuing(roundId)
        if await queue.context != ctx { await queue.setContext(ctx) }
        if self.role != role || updatesTask == nil { startUpdates(role: role) }
        mode = .tracking
        persistContext(sessionId: sessionId, roundId: roundId, role: role, roundStartAt: roundStartAt)
        startUploadLoop()
        // Restore this phone's own trail once per round (after a relaunch), not on every view update.
        if ownTrail.isEmpty, trailFetchedRoundId != roundId, let api {
            trailFetchedRoundId = roundId
            if let track = try? await api.myTrack(sessionId, roundId), ownTrail.roundId == roundId {
                ownTrail.merge(track.points.map { .init(coordinate: .init(latitude: $0.latitude, longitude: $0.longitude), at: $0.recordedAt) })
            }
        }
    }

    /// The round's ping schedule as the server sees it (from the view). Hider phones use it
    /// to put a fresh fix on the server just before each deadline, and right away while a ping waits.
    func setPingSchedule(nextPingAt: Date?, waiting: Bool) {
        self.nextPingAt = nextPingAt
        let startedWaiting = waiting && !pingWaiting
        pingWaiting = waiting
        if startedWaiting && role == .HIDING && mode == .tracking { Task { await uploadOnce() } }
    }

    /// Stop everything (round over, consent withdrawn, logout, manual stop).
    func stop(flush: Bool = true) async {
        updatesTask?.cancel()
        updatesTask = nil
        backgroundSession?.invalidate()
        backgroundSession = nil
        serviceSession?.invalidate()
        serviceSession = nil
        mode = .idle
        role = nil
        filter.reset()
        UserDefaults.standard.removeObject(forKey: persistedContextKey)
        if flush { await uploadOnce() }
        uploadTask?.cancel()
        uploadTask = nil
    }

    func purgeLocalData() async {
        await stop(flush: false)
        await queue.clear()
        ownTrail = OwnTrail()
        queuedSamples = 0
    }

    /// Called at launch: if the system relaunched us (or the user reopened)
    /// while a round was being tracked, resume only after local authorization
    /// checks; the server then confirms the round is still active.
    func resumeIfNeeded() async -> (sessionId: String, roundId: String)? {
        guard let data = UserDefaults.standard.data(forKey: persistedContextKey),
              let ctx = try? JSONDecoder().decode(PersistedContext.self, from: data) else { return nil }
        guard isAuthorized, Date().timeIntervalSince(ctx.savedAt) < 8 * 3600 else {
            UserDefaults.standard.removeObject(forKey: persistedContextKey)
            return nil
        }
        interruptedResumeNotice = "Tracking was interrupted (the app was closed or restarted). It resumed at \(Date().formatted(date: .omitted, time: .shortened)); fixes during the gap are missing, not estimated."
        if let start = ctx.roundStartAt {
            await beginTracking(sessionId: ctx.sessionId, roundId: ctx.roundId, role: ctx.role, roundStartAt: start)
        } else {
            await beginPreflight(sessionId: ctx.sessionId, roundId: ctx.roundId, role: ctx.role)
        }
        return (ctx.sessionId, ctx.roundId)
    }

    func dismissResumeNotice() { interruptedResumeNotice = nil }

    private struct PersistedContext: Codable {
        var sessionId: String
        var roundId: String
        var role: Role
        var roundStartAt: Date?
        var savedAt: Date
    }

    private func persistContext(sessionId: String, roundId: String, role: Role, roundStartAt: Date?) {
        let ctx = PersistedContext(sessionId: sessionId, roundId: roundId, role: role, roundStartAt: roundStartAt, savedAt: Date())
        if let data = try? JSONEncoder().encode(ctx) { UserDefaults.standard.set(data, forKey: persistedContextKey) }
    }

    // MARK: Updates

    private func startUpdates(role: Role) {
        updatesTask?.cancel()
        self.role = role
        if backgroundSession == nil { backgroundSession = CLBackgroundActivitySession() }
        if serviceSession == nil { serviceSession = CLServiceSession(authorization: .whenInUse, fullAccuracyPurposeKey: "RoundTracking") }
        filter.reset()
        // Walking crew vs. passenger in a car.
        let config: CLLocationUpdate.LiveConfiguration = role == .HIDING ? .fitness : .automotiveNavigation
        updatesTask = Task { [weak self] in
            do {
                for try await update in CLLocationUpdate.liveUpdates(config) {
                    if Task.isCancelled { break }
                    await self?.handle(update)
                }
            } catch {
                await MainActor.run { self?.lastDiagnostic = "Location updates stopped: \(error.localizedDescription)" }
            }
        }
    }

    private func handle(_ update: CLLocationUpdate) async {
        if update.authorizationDenied || update.authorizationDeniedGlobally { lastDiagnostic = "Location permission denied" }
        else if update.accuracyLimited { lastDiagnostic = "Precise Location is off" }
        else if update.locationUnavailable { lastDiagnostic = "GPS unavailable" }
        else if update.insufficientlyInUse { lastDiagnostic = "Open the app to continue tracking" }
        else { lastDiagnostic = nil }
        preciseLocation = manager.accuracyAuthorization == .fullAccuracy
        guard let loc = update.location else { return }
        lastFix = loc
        guard mode == .tracking else { return } // preflight: health only, nothing recorded
        if !filter.shouldKeep(timestamp: loc.timestamp, coordinate: loc.coordinate, horizontalAccuracy: loc.horizontalAccuracy, stationary: update.stationary) { return }
        let sample = SamplePayload(
            pointId: UUID().uuidString.lowercased(),
            recordedAt: loc.timestamp,
            latitude: loc.coordinate.latitude,
            longitude: loc.coordinate.longitude,
            horizontalAccuracyMeters: loc.horizontalAccuracy,
            speedMetersPerSecond: loc.speed >= 0 ? loc.speed : nil,
            courseDegrees: loc.course >= 0 ? loc.course : nil,
            altitudeMeters: loc.verticalAccuracy >= 0 ? loc.altitude : nil)
        await queue.enqueue(sample)
        queuedSamples = await queue.count
        if loc.horizontalAccuracy <= 65 { ownTrail.append(loc.coordinate, at: loc.timestamp) }
        // Location callbacks keep arriving in the background, so deadline-driven uploads work in a pocket.
        if role == .HIDING, shouldUploadForPing() { Task { await uploadOnce() } }
    }

    /// A hider fix should reach the server now: a ping is waiting for it, or a deadline is under 25 s away
    /// and nothing was uploaded in that window yet.
    private func shouldUploadForPing() -> Bool {
        let sinceAttempt = Date().timeIntervalSince(lastAttemptAt)
        if pingWaiting { return sinceAttempt > 5 }
        guard let deadline = nextPingAt else { return false }
        let toDeadline = deadline.timeIntervalSince(ServerClock.shared.now())
        return toDeadline > 3 && toDeadline <= 25 && sinceAttempt > 25 - toDeadline + 1
    }

    private func reconnected() {
        guard mode == .tracking else { onReconnect?(); return }
        Task {
            // Newest fix first, then the backlog.
            for _ in 0..<10 {
                await uploadOnce(newestFirst: true)
                if consecutiveFailures > 0 || queuedSamples == 0 { break }
            }
            onReconnect?()
        }
    }

    // MARK: Upload

    private func startUploadLoop() {
        guard uploadTask == nil else { return }
        uploadTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.uploadOnce()
                try? await Task.sleep(nanoseconds: UInt64(await self.nextUploadDelay() * 1_000_000_000))
            }
        }
    }

    /// Seconds until the next routine upload: role cadence, a fast drain for a big backlog,
    /// or exponential backoff (capped at 30 s) after failures.
    private func nextUploadDelay() async -> TimeInterval {
        let cadence = role == .HIDING ? Self.hiderCadence : Self.seekerCadence
        if consecutiveFailures > 0 { return min(cadence, min(30, pow(2, Double(consecutiveFailures))) * Double.random(in: 0.8...1.2)) }
        return await queue.count > 200 ? 3 : cadence
    }

    /// Upload one batch (or a health heartbeat). Never runs twice at once.
    func uploadOnce(newestFirst: Bool = false) async {
        guard let api, !uploading else { return }
        uploading = true
        defer { uploading = false }
        guard let (ctx, batchId, samples) = await queue.nextBatch(newestFirst: newestFirst) else { return }
        guard ctx.roundStartAt != nil else { return } // never upload preflight
        let health = health()
        // Nothing new: send health only when it changed or once a minute.
        if samples.isEmpty, let last = lastHealthSent, !health.differsMeaningfully(from: last),
           let at = lastUploadAt, Date().timeIntervalSince(at) < Self.heartbeatInterval {
            return
        }
        lastAttemptAt = Date()
        let body = LocationBatchBody(batchId: batchId, sentAt: Date(), samples: samples, health: health)
        do {
            let res = try await api.uploadLocations(ctx.sessionId, ctx.roundId, body)
            await queue.ack(batchId: batchId)
            lastUploadAt = Date()
            lastHealthSent = health
            consecutiveFailures = 0
            lastUploadError = res.rejected.isEmpty ? nil : "\(res.rejected.count) samples rejected"
        } catch let e as APIError {
            switch e.code {
            case "GAME_CLOSED", "NOT_FOUND", "OPERATOR_NOT_AUTHORIZED":
                // The round no longer accepts samples from this phone.
                await queue.discardAll()
                consecutiveFailures = 0
            case "VALIDATION_FAILED", "PAYLOAD_TOO_LARGE":
                // This batch can never succeed; drop it rather than block the queue behind it.
                await queue.dropInFlight()
                consecutiveFailures = 0
            default:
                consecutiveFailures += 1 // keep queued; retry with backoff
            }
            lastUploadError = e.localizedDescription
        } catch {
            consecutiveFailures += 1
            lastUploadError = error.localizedDescription
        }
        queuedSamples = await queue.count
    }
}

extension HealthPayload {
    /// Changes other phones would notice (coarse status), ignoring fix age and battery drift.
    func differsMeaningfully(from o: HealthPayload) -> Bool {
        permission != o.permission || preciseLocation != o.preciseLocation || trackingActive != o.trackingActive
            || backgroundSessionActive != o.backgroundSessionActive || lowPowerMode != o.lowPowerMode || networkReachable != o.networkReachable
    }
}
