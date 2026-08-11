import SwiftUI

// The pet, carried over from coplanner-buddy with two additions: a board button in the hover pill,
// and a resting status pill under the pet's feet.
//
// Both are additions to what was already there rather than new patterns. The pill already had
// three buttons and already opened a second window (the picker popover), so the board is a fourth
// button opening the pet's second second-window. The status pill is the only genuinely new element,
// and it is the notch's compact slots relocated: same job, same constraint, same code path into
// Feed, so the two can never disagree.

struct RootView: View {
    @ObservedObject var state = AppState.shared
    @ObservedObject var feed: Feed
    /// render-mode only: draw the hover pill, since a PNG has no pointer
    var forceHover = false
    @State private var hoveringRaw = false
    @State private var bounce = false

    private var hovering: Bool { hoveringRaw || forceHover }

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                if hovering || state.pickerOpen {
                    ToolbarPill()
                        .transition(.scale(scale: 0.85, anchor: .bottom).combined(with: .opacity))
                        // Popover = its own window: escapes our panel, so the panel stays tiny
                        .popover(isPresented: $state.pickerOpen, arrowEdge: .top) {
                            AvatarPickerView()
                        }
                }
            }
            // Keep the pill snug above the pet's head at every size
            .offset(y: 110 * (DragHandle.sizes.last! - state.petScale))

            TimelineView(.animation) { ctx in
                let t = ctx.date.timeIntervalSinceReferenceDate
                state.selected.view(t: t)
            }
            .id(state.selected) // fresh pop-in per avatar
            .scaleEffect(state.petScale, anchor: .center) // resize breathes around the center
            // Slot is reserved at the LARGEST size: no layout shift when cycling,
            // the pill and buttons never move out from under the cursor.
            .frame(width: 200 * DragHandle.sizes.last!,
                   height: 220 * DragHandle.sizes.last!, alignment: .center)
            .transition(.scale(scale: 0.6).combined(with: .opacity))
            .scaleEffect(bounce ? 1.12 : 1.0)
            .animation(.spring(response: 0.28, dampingFraction: 0.45), value: bounce)
            .onTapGesture {
                hop()
                AppState.lastTapAt = Date().timeIntervalSinceReferenceDate
                if state.selected == .orbie {
                    AppState.orbieSaturn.toggle()
                    AppState.orbieToggleAt = AppState.lastTapAt
                }
            }
            .overlay(alignment: .bottom) { restingStatus }
        }
        .padding(.horizontal, 30)
        .padding(.bottom, 4)
        .onHover { h in
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { hoveringRaw = h }
            // pickerOpen stays: the popover is a separate window (hover leaves ours),
            // and it dismisses itself on outside clicks.
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.75), value: state.pickerOpen)
        .animation(.spring(response: 0.35, dampingFraction: 0.75), value: state.selected)
        // The pet is the thing the board comes out of, so it reacts when it does.
        .onChange(of: state.boardOpen) { _, open in if open { hop() } }
        // Bottom-anchored: the picker grows upward instead of pushing the pet down
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }

    /// Only rendered when the board has something to say. A pill reading "0" at all times is
    /// furniture, and the reason to put status on a pet is that the pet is quiet until it is not.
    @ViewBuilder
    private var restingStatus: some View {
        let status = RestingStatus(feed: feed)
        if status.hasSomethingToSay, !state.boardOpen {
            Button { state.boardOpen = true } label: { status }
                .buttonStyle(.plain)
                .offset(y: 4)
                .transition(.scale(scale: 0.7, anchor: .top).combined(with: .opacity))
                .animation(.spring(response: 0.4, dampingFraction: 0.7), value: status.hasSomethingToSay)
        }
    }

    private func hop() {
        bounce = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { bounce = false }
    }
}

struct ToolbarPill: View {
    @ObservedObject var state = AppState.shared

    var body: some View {
        HStack(spacing: 10) {
            DragHandle()

            PillButton(icon: "square.stack.3d.up.fill", size: 14, on: state.boardOpen) {
                state.boardOpen.toggle()
            }
            .help("Show me the board")

            PillButton(icon: "circle.grid.2x2.fill", size: 14) { state.pickerOpen = true }
                .help("Switch buddy")

            PillButton(icon: "xmark", size: 13) { NSApp.terminate(nil) }
                .help("Quit")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            Capsule().fill(Color(red: 0.16, green: 0.16, blue: 0.18).opacity(0.92))
                .shadow(color: .black.opacity(0.3), radius: 8, y: 2)
        )
    }
}

/// Typibara-style resize: each click cycles S → M → L → S.
struct DragHandle: View {
    static let sizes: [CGFloat] = [0.85, 1.0, 1.2]
    @State private var hover = false

    var body: some View {
        Button {
            let cur = AppState.shared.petScale
            // nearest preset, then step to the next (wrapping)
            let idx = Self.sizes.enumerated().min(by: { abs($0.1 - cur) < abs($1.1 - cur) })!.0
            let next = Self.sizes[(idx + 1) % Self.sizes.count]
            withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                AppState.shared.petScale = next
            }
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(hover ? 1 : 0.7))
                .frame(width: 30, height: 30)
                .background(Circle().fill(.white.opacity(hover ? 0.18 : 0)))
                .scaleEffect(hover ? 1.12 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(.spring(response: 0.22, dampingFraction: 0.7)) { hover = h }
        }
        .help("Click to cycle my size")
    }
}

struct PillButton: View {
    var icon: String
    var size: CGFloat
    /// latched buttons (the board) stay lit while their surface is up
    var on: Bool = false
    var action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(.white.opacity(on || hover ? 1 : 0.7))
                .frame(width: 30, height: 30)
                .background(Circle().fill(.white.opacity(on ? 0.22 : (hover ? 0.18 : 0))))
                .scaleEffect(hover ? 1.12 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(.spring(response: 0.22, dampingFraction: 0.7)) { hover = h }
        }
    }
}

struct AvatarPickerView: View {
    @ObservedObject var state = AppState.shared

    private let columns = [GridItem(.adaptive(minimum: 54), spacing: 6)]

    var body: some View {
        VStack(spacing: 4) {
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(AvatarID.active) { avatar in
                    AvatarCell(avatar: avatar, selected: avatar == state.selected) {
                        state.selected = avatar
                        state.pickerOpen = false
                    }
                }
            }
            Text("\(state.selected.name) — \(state.selected.tagline)")
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.6))
                .padding(.bottom, 2)
        }
        .padding(10)
        .frame(width: 252)
        .background(
            RoundedRectangle(cornerRadius: 18)
                .fill(Color(red: 0.14, green: 0.14, blue: 0.17).opacity(0.94))
                .shadow(color: .black.opacity(0.35), radius: 10, y: 3)
        )
    }
}

struct AvatarCell: View {
    var avatar: AvatarID
    var selected: Bool
    var action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                TimelineView(.animation) { ctx in
                    avatar.view(t: ctx.date.timeIntervalSinceReferenceDate)
                        .scaleEffect(0.22)         // 200×220 art → 44×48.4, fits uncropped
                        .frame(width: 50, height: 50)
                }
                Text(avatar.name)
                    .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(selected ? 1 : 0.55))
            }
            .padding(.vertical, 3)
            .frame(width: 54)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(selected ? Color.white.opacity(0.16) : (hover ? Color.white.opacity(0.08) : .clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(selected ? Color(red: 0.72, green: 0.62, blue: 0.98) : .clear, lineWidth: 1.5)
            )
            .scaleEffect(hover ? 1.06 : 1.0)
        }
        .buttonStyle(.plain)
        .onHover { h in
            withAnimation(.spring(response: 0.25, dampingFraction: 0.7)) { hover = h }
        }
    }
}
