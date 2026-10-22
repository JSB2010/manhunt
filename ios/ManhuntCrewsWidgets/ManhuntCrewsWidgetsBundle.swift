import SwiftUI
import WidgetKit

/// Widget extension. It holds only the round's Live Activity (ADR 0017); there are no
/// Home Screen widgets, because a night has nothing to show between rounds.
@main
struct ManhuntCrewsWidgetsBundle: WidgetBundle {
    var body: some Widget {
        RoundLiveActivity()
    }
}
