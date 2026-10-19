import SwiftUI

// Shared components (docs/design-system.md). Two layers, as in Apple’s HIG:
// content (lists, photos, the map) uses system backgrounds and fills; only the
// functional layer that floats above it (map HUD, action bars, toasts) uses
// Liquid Glass — iOS 26+ — with a standard material on earlier systems.

// MARK: - Liquid Glass with fallbacks

extension View {
    /// Liquid Glass behind controls that float over the map, camera or photos.
    /// iOS 18–25: a standard material (both adapt to Reduce Transparency and Increase Contrast).
    @ViewBuilder
    func glassSurface(in shape: some Shape = Capsule(), interactive: Bool = false) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular.interactive(interactive), in: shape)
        } else {
            background(.regularMaterial, in: shape)
        }
    }

    /// The one prominent action in a floating control group.
    @ViewBuilder
    func floatingProminentButton() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent)
        } else {
            buttonStyle(.borderedProminent)
        }
    }

    /// Secondary actions in a floating control group.
    @ViewBuilder
    func floatingButton() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glass)
        } else {
            buttonStyle(MaterialButtonStyle())
        }
    }

    /// Glass button whose prominence depends on state (one prominent action at a time).
    @ViewBuilder
    func floatingButton(prominent: Bool) -> some View {
        if prominent {
            floatingProminentButton()
        } else {
            floatingButton()
        }
    }

    /// Pins a bar of actions to the bottom edge above scrolling content. iOS 26 uses a
    /// safe-area bar with the hard scroll edge effect Apple recommends behind pinned
    /// accessory views (no custom background); earlier systems get the standard bar material.
    @ViewBuilder
    func bottomActionBar(@ViewBuilder _ content: () -> some View) -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.hard, for: .bottom)
                .safeAreaBar(edge: .bottom) {
                    content().padding(.horizontal).padding(.bottom, 8)
                }
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) {
                content().padding(.horizontal).padding(.vertical, 10).frame(maxWidth: .infinity).background(.bar)
            }
        }
    }
}

/// Groups nearby glass controls so they share one sampling region and can morph together.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat?
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// Pre-iOS 26 stand-in for the glass button style: a material capsule with a primary label.
struct MaterialButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .fontWeight(.semibold)
            .foregroundStyle(isEnabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 44)
            .background(.regularMaterial, in: Capsule())
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

// MARK: - Standard toolbar buttons

/// Standard Close (✕): leaves without losing anything (HIG › Toolbars › Navigation).
struct CloseButton: View {
    let action: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            Button(role: .close, action: action)
        } else {
            Button(action: action) { Image(systemName: "xmark") }
                .accessibilityLabel("Close")
        }
    }
}

/// Standard Cancel: dismisses and discards edits.
struct CancelButton: View {
    let action: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            Button(role: .cancel, action: action)
        } else {
            Button("Cancel", role: .cancel, action: action)
        }
    }
}

/// The single prominent toolbar action (Create, Save, Add).
struct ConfirmButton: View {
    let title: String
    var busy = false
    let action: () -> Void

    var body: some View {
        if busy {
            ProgressView().accessibilityLabel("Working")
        } else if #available(iOS 26, *) {
            Button(title, role: .confirm, action: action)
        } else {
            Button(title, action: action).fontWeight(.semibold)
        }
    }
}

// MARK: - Content components

/// Full-width label for content-layer action buttons, with an inline spinner while busy.
/// Pair with `.buttonStyle(.borderedProminent)` / `.bordered` and `.controlSize(.large)`.
struct ActionLabel: View {
    let title: String
    var systemImage: String?
    var busy = false
    /// false for a secondary action that should hug its label next to a flexible primary.
    var expands = true
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 8) {
            if busy {
                ProgressView()
            } else if let systemImage {
                Image(systemName: systemImage)
            }
            Text(title)
        }
        .fontWeight(.semibold)
        // One line normally; wrap rather than truncate at accessibility text sizes.
        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
        .minimumScaleFactor(typeSize.isAccessibilitySize ? 1 : 0.85)
        .multilineTextAlignment(.center)
        .frame(maxWidth: expands ? .infinity : nil)
    }
}

/// Status in the content layer. The symbol carries colour and shape; the text stays
/// primary so it keeps full contrast (never colour alone).
struct StatusBadge: View {
    let text: String
    let systemImage: String
    var tint: Color = .secondary

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: systemImage).foregroundStyle(tint)
        }
        .labelStyle(.titleAndIcon)
        .font(.footnote.weight(.medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.fill.tertiary, in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// Crew identity mark. Decorative: the crew name is always shown next to it.
struct CrewDot: View {
    let key: TeamKey
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 10

    var body: some View {
        Circle()
            .fill(Theme.crew(key))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// "Hiding" / "Seeking" with its symbol, tinted with the crew’s colour.
struct RoleLabel: View {
    let role: Role
    var crew: TeamKey?

    var body: some View {
        Label {
            Text(role.label)
        } icon: {
            Image(systemName: role.symbol).foregroundStyle(crew.map(Theme.crew) ?? .secondary)
        }
        .labelStyle(.titleAndIcon)
    }
}

/// An inline notice inside content (preferred over alerts for non-blocking information).
struct InlineNotice: View {
    var title: String?
    let message: String
    var systemImage = "exclamationmark.triangle.fill"
    var tint: Color = Theme.warning
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
                .font(.body.weight(.semibold))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                if let title { Text(title).font(.headline) }
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(title == nil ? .primary : .secondary)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.borderless)
                        .padding(.top, 2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Explicit checkbox row for disclosures and checklists: VoiceOver announces it as a
/// selected/unselected button (more legible than a switch for an agreement).
struct CheckRow: View {
    let text: String
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .contentTransition(.symbolEffect(.replace))
                    .accessibilityHidden(true)
                Text(text)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
        .accessibilityValue(isOn ? "Checked" : "Not checked")
    }
}

/// Wraps chips onto new lines instead of truncating them at large text sizes.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, width: CGFloat = 0
        for subview in subviews {
            let size = fittedSize(subview, maxWidth: maxWidth)
            if x > 0, x + size.width > maxWidth {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            width = max(width, x - spacing)
        }
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = fittedSize(subview, maxWidth: bounds.width)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }

    private func fittedSize(_ subview: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let ideal = subview.sizeThatFits(.unspecified)
        return ideal.width <= maxWidth ? ideal : subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
    }
}

/// Transient confirmation shown at the top of the screen (functional layer).
struct ToastView: View {
    let text: String

    var body: some View {
        // No symbol: toasts carry both confirmations and notices, and a checkmark on
        // "Your session expired" would be misleading.
        Text(text)
            .font(.subheadline.weight(.semibold))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .glassSurface()
            .accessibilityAddTraits(.isStaticText)
    }
}
