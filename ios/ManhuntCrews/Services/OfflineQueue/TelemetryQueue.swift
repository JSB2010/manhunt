import Foundation

/// Durable, encrypted queue of private GPS samples for the active round.
/// Samples survive app suspension/termination and offline periods and are
/// uploaded in idempotent batches (pointId per sample, batchId per attempt).
/// Late uploads only improve post-round history: the server never reveals a
/// sample that arrived after a ping deadline.
actor TelemetryQueue {
    struct Context: Codable, Equatable, Sendable {
        var sessionId: String
        var roundId: String
        var role: Role
        var roundStartAt: Date?
    }

    private struct Persisted: Codable {
        var context: Context
        var samples: [SamplePayload]
        var inFlightBatchId: String?
        var inFlightPointIds: [String]
    }

    private var state: Persisted?
    private let maxBatch = 200
    private let maxQueued = 20_000
    private var lastPersist = Date.distantPast
    private var dirty = false

    init() {
        if let data = EncryptedStore.read(name: "telemetry.bin"), let p = try? JSONDecoder().decode(Persisted.self, from: data) {
            state = p
        }
    }

    var context: Context? { state?.context }
    var count: Int { state?.samples.count ?? 0 }

    /// Bind the queue to a round. Switching rounds keeps nothing from the old one
    /// unless it is still unsent (it is flushed first by the coordinator).
    func setContext(_ ctx: Context) {
        if state?.context.roundId == ctx.roundId {
            state?.context = ctx
        } else {
            state = Persisted(context: ctx, samples: [], inFlightBatchId: nil, inFlightPointIds: [])
        }
        persist(force: true)
    }

    func enqueue(_ sample: SamplePayload) {
        guard state != nil else { return }
        if let start = state?.context.roundStartAt, sample.recordedAt < start.addingTimeInterval(-5) { return }
        state!.samples.append(sample)
        if state!.samples.count > maxQueued { state!.samples.removeFirst(state!.samples.count - maxQueued) }
        dirty = true
        persist(force: false)
    }

    /// Next batch to send. Reuses the in-flight batch id if a previous attempt's
    /// outcome is unknown, so the server's idempotency replays it.
    func nextBatch() -> (Context, String, [SamplePayload])? {
        guard var s = state else { return nil }
        if let id = s.inFlightBatchId {
            let ids = Set(s.inFlightPointIds)
            let samples = s.samples.filter { ids.contains($0.pointId) }
            if !samples.isEmpty { return (s.context, id, samples) }
        }
        let samples = Array(s.samples.prefix(maxBatch))
        let id = UUID().uuidString
        s.inFlightBatchId = id
        s.inFlightPointIds = samples.map(\.pointId)
        state = s
        persist(force: true)
        return (s.context, id, samples)
    }

    func ack(batchId: String) {
        guard var s = state, s.inFlightBatchId == batchId else { return }
        let ids = Set(s.inFlightPointIds)
        s.samples.removeAll { ids.contains($0.pointId) }
        s.inFlightBatchId = nil
        s.inFlightPointIds = []
        state = s
        persist(force: true)
    }

    /// Server says the round no longer accepts samples: drop them.
    func discardAll() {
        state?.samples.removeAll()
        state?.inFlightBatchId = nil
        state?.inFlightPointIds = []
        persist(force: true)
    }

    func clear() {
        state = nil
        EncryptedStore.remove(name: "telemetry.bin")
    }

    func flushToDisk() { persist(force: true) }

    private func persist(force: Bool) {
        guard let s = state else { return }
        // Throttle disk writes to every few seconds while collecting; batches persist immediately.
        guard force || Date().timeIntervalSince(lastPersist) > 5 else { return }
        if let data = try? JSONEncoder().encode(s) {
            try? EncryptedStore.write(data, name: "telemetry.bin")
            lastPersist = Date()
            dirty = false
        }
    }
}
