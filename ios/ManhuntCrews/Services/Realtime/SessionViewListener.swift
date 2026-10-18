import Foundation
import FirebaseFirestore
import os

let realtimeLog = Logger(subsystem: "com.manhuntcrews", category: "realtime")

/// Subscribes to the caller's own sanitized read model
/// `sessions/{sessionId}/views/{uid}`. Firestore rules allow reading exactly
/// this document while the caller is an active member; nothing else.
final class SessionViewListener {
    private var registration: ListenerRegistration?

    struct Update {
        var view: SessionViewDoc?
        var fromCache: Bool
        var error: Error?
    }

    func start(sessionId: String, uid: String, onUpdate: @escaping @MainActor (Update) -> Void) {
        stop()
        let ref = Firestore.firestore().collection("sessions").document(sessionId).collection("views").document(uid)
        realtimeLog.info("listen start session=\(sessionId, privacy: .public)")
        registration = ref.addSnapshotListener(includeMetadataChanges: true) { snapshot, error in
            realtimeLog.info("snapshot exists=\(snapshot?.exists ?? false) cache=\(snapshot?.metadata.isFromCache ?? true) error=\(error?.localizedDescription ?? "-", privacy: .public)")
            if let error {
                Task { @MainActor in onUpdate(Update(view: nil, fromCache: true, error: error)) }
                return
            }
            guard let snapshot, let data = snapshot.data() else {
                Task { @MainActor in onUpdate(Update(view: nil, fromCache: snapshot?.metadata.isFromCache ?? true, error: nil)) }
                return
            }
            let fromCache = snapshot.metadata.isFromCache
            do {
                let json = try JSONSerialization.data(withJSONObject: Self.jsonSafe(data))
                let view = try JSONCoding.decoder.decode(SessionViewDoc.self, from: json)
                Task { @MainActor in onUpdate(Update(view: view, fromCache: fromCache, error: nil)) }
            } catch {
                realtimeLog.error("view decode failed: \(String(describing: error), privacy: .public)")
                Task { @MainActor in onUpdate(Update(view: nil, fromCache: fromCache, error: error)) }
            }
        }
    }

    func stop() {
        if registration != nil { realtimeLog.info("listen stop") }
        registration?.remove()
        registration = nil
    }

    /// Views only contain JSON-compatible values, but convert defensively.
    private static func jsonSafe(_ value: Any) -> Any {
        switch value {
        case let d as [String: Any]: return d.mapValues { jsonSafe($0) }
        case let a as [Any]: return a.map { jsonSafe($0) }
        case let t as Timestamp: return JSONCoding.format(t.dateValue())
        case is NSNull: return NSNull()
        default: return value
        }
    }
}
