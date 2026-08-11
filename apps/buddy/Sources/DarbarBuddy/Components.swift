import SwiftUI

// Shared cartoon vocabulary: every avatar uses the same eye/blush/mouth language
// so the set feels like one family, driven by a single time value `t`.

func isBlinking(_ t: Double, period: Double = 3.7, offset: Double = 0) -> Bool {
    let phase = (t + offset).truncatingRemainder(dividingBy: period)
    return phase < 0.13
}

/// Smooth 0→1→0 pulse that fires once per `period`, lasting `width` seconds.
func pulse(_ t: Double, period: Double, width: Double, offset: Double = 0) -> Double {
    let phase = (t + offset).truncatingRemainder(dividingBy: period)
    guard phase < width else { return 0 }
    return sin((phase / width) * .pi)
}

/// Direction from the pet's window to the mouse, unit-clamped. (0,0) if unknown.
func cursorGazeVector() -> CGSize {
    guard let win = NSApp?.windows.first(where: { $0.isVisible }) else { return .zero }
    let mouse = NSEvent.mouseLocation
    let center = CGPoint(x: win.frame.midX, y: win.frame.midY)
    let dx = mouse.x - center.x
    let dy = -(mouse.y - center.y) // screen is bottom-left origin; views are y-down
    let len = max(1, hypot(dx, dy))
    // Ease in: full deflection only once the cursor is a bit away from the pet
    let strength = min(1, len / 160)
    return CGSize(width: dx / len * strength, height: dy / len * strength)
}

struct CuteEyes: View {
    var t: Double
    var blinkOffset: Double = 0
    var spacing: CGFloat = 34
    var size: CGFloat = 11
    var color: Color = Color(red: 0.18, green: 0.13, blue: 0.11)
    var followCursor: Bool = false

    var body: some View {
        let closed = isBlinking(t, offset: blinkOffset)
        let gaze = followCursor ? cursorGazeVector() : .zero
        HStack(spacing: spacing) {
            eye(closed: closed, gaze: gaze)
            eye(closed: closed, gaze: gaze)
        }
    }

    @ViewBuilder
    private func eye(closed: Bool, gaze: CGSize) -> some View {
        if closed {
            Capsule()
                .fill(color)
                .frame(width: size * 1.15, height: size * 0.22)
        } else {
            Ellipse()
                .fill(color)
                .frame(width: size, height: size * 1.25)
                .overlay(
                    Circle()
                        .fill(.white.opacity(0.9))
                        .frame(width: size * 0.32, height: size * 0.32)
                        .offset(x: -size * 0.16, y: -size * 0.3)
                )
                // Pupil tracks the cursor within the eye's whites
                .offset(x: gaze.width * size * 0.28, y: gaze.height * size * 0.32)
        }
    }
}

struct Blush: View {
    var spacing: CGFloat = 64
    var size: CGFloat = 14
    var color: Color = Color(red: 1.0, green: 0.55, blue: 0.55)

    var body: some View {
        HStack(spacing: spacing) {
            Ellipse().fill(color.opacity(0.4)).frame(width: size, height: size * 0.62)
            Ellipse().fill(color.opacity(0.4)).frame(width: size, height: size * 0.62)
        }
    }
}

/// Small "w"-less cat smile: a simple downward arc.
struct SmileArc: Shape {
    var upsideDown = false
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: upsideDown ? rect.maxY : rect.minY))
        p.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: upsideDown ? rect.maxY : rect.minY),
            control: CGPoint(x: rect.midX, y: upsideDown ? rect.minY : rect.maxY)
        )
        return p
    }
}

struct Smile: View {
    var width: CGFloat = 16
    var color: Color = Color(red: 0.18, green: 0.13, blue: 0.11)
    var body: some View {
        SmileArc()
            .stroke(color, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
            .frame(width: width, height: width * 0.45)
    }
}

/// Open happy mouth (little rounded triangle-ish blob).
struct OpenSmile: View {
    var width: CGFloat = 14
    var body: some View {
        Circle()
            .trim(from: 0, to: 0.5)
            .fill(Color(red: 0.35, green: 0.17, blue: 0.16))
            .frame(width: width, height: width)
            .rotationEffect(.degrees(0))
    }
}

/// Four-point sparkle (the AI ✦ shape) built from quad curves.
struct SparkleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let rx = rect.width / 2, ry = rect.height / 2
        let pinch: CGFloat = 0.18
        var p = Path()
        p.move(to: CGPoint(x: c.x, y: c.y - ry))
        p.addQuadCurve(to: CGPoint(x: c.x + rx, y: c.y), control: CGPoint(x: c.x + rx * pinch, y: c.y - ry * pinch))
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y + ry), control: CGPoint(x: c.x + rx * pinch, y: c.y + ry * pinch))
        p.addQuadCurve(to: CGPoint(x: c.x - rx, y: c.y), control: CGPoint(x: c.x - rx * pinch, y: c.y + ry * pinch))
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y - ry), control: CGPoint(x: c.x - rx * pinch, y: c.y - ry * pinch))
        p.closeSubpath()
        return p
    }
}

struct TwinkleSparkle: View {
    var t: Double
    var period: Double = 2.6
    var offset: Double = 0
    var size: CGFloat = 14
    var color: Color = Color(red: 1.0, green: 0.85, blue: 0.4)

    var body: some View {
        let a = 0.25 + 0.75 * pulse(t, period: period, width: 1.1, offset: offset)
        SparkleShape()
            .fill(color)
            .frame(width: size, height: size)
            .scaleEffect(0.7 + 0.3 * a)
            .opacity(a)
    }
}

/// Soft ellipse shadow under a hovering pet; shrinks as the pet bobs up.
struct GroundShadow: View {
    var bob: Double // -1...1, 1 = highest
    var width: CGFloat = 90
    var body: some View {
        Ellipse()
            .fill(Color.black.opacity(0.18 - 0.06 * bob))
            .frame(width: width * (1 - 0.12 * bob), height: width * 0.16)
            .blur(radius: 3)
    }
}

/// Wraps avatar art with the shared hover-bob + ground shadow, inside a 200×220 canvas.
struct FloatingPet<Content: View>: View {
    var t: Double
    var bobAmp: CGFloat = 7
    var bobFreq: Double = 1.6
    var shadowWidth: CGFloat = 92
    @ViewBuilder var content: (Double) -> Content

    var body: some View {
        let bob = sin(t * bobFreq)
        ZStack {
            GroundShadow(bob: bob, width: shadowWidth)
                .offset(y: 96)
            content(t)
                .offset(y: CGFloat(bob) * -bobAmp)
        }
        .frame(width: 200, height: 220)
    }
}
