import SwiftUI

// The 4 petals of the real CoPlanner logo, path data lifted verbatim from
// saturn-fe's animated-logo.tsx (viewBox 38×38, pivot at 19,19).

/// Set by the offline render modes so entrance animations show their settled state.
enum RenderMode {
    nonisolated(unsafe) static var snapshot = false
    /// Snapshot-only override: render entrances as if this many seconds since appear.
    nonisolated(unsafe) static var entranceAge: Double? = nil
}

let COPLANNER_PETALS = [
    "M4.17705 16.3481C6.42451 16.4072 9.42671 14.3877 11.1091 12.9612C13.5242 10.8916 15.7109 8.42005 17.0388 5.48852C17.8854 3.61958 18.5387 0.629281 15.6054 0.425303C13.1947 0.376897 9.84681 2.68149 8.10099 4.28044C5.45714 6.77347 2.41273 10.1345 2.00816 13.9206C1.85026 15.3983 2.74867 16.2891 4.17705 16.3481Z",
    "M34.1243 16.3999C34.1364 16.4028 34.1484 16.4056 34.1604 16.4085C35.5752 16.4603 36.6873 15.6337 36.6955 14.1104C36.7119 11.0754 34.3138 7.89484 32.381 5.78051C30.3876 3.59939 26.4457 0.475006 23.4104 0.376382C23.4058 0.375346 23.4013 0.37457 23.3968 0.373535C22.7713 0.334965 22.1166 0.50348 21.6279 0.894093C21.17 1.26011 20.8857 1.92874 20.8474 2.49485C20.6838 4.91515 22.6644 8.09752 24.1511 9.87094C25.92 11.9524 27.9207 13.8365 30.3264 15.1421C31.6303 15.8497 32.6471 16.2692 34.1243 16.3999Z",
    "M23.7262 36.3579C25.8459 36.4949 28.9325 34.3841 30.4612 33.0233C32.8436 30.9002 34.9357 28.3414 36.1289 25.3408C36.8997 23.403 37.3626 20.3626 34.4535 20.1702C29.3673 20.0402 21.6869 28.4916 21.3916 33.5936C21.297 35.228 22.061 36.2831 23.7262 36.3579Z",
    "M14.8388 36.3579C16.4549 36.4526 17.5262 35.282 17.5363 33.7102C17.5564 30.5797 15.3098 27.2169 13.3225 24.9763C11.3504 22.7529 7.85345 19.8596 4.81834 19.6952C3.19233 19.5609 2.06289 20.6878 2.04814 22.3085C2.01827 25.5911 4.28967 28.8958 6.38431 31.256C8.37674 33.501 11.7577 36.2187 14.8388 36.3579Z",
]

/// Minimal absolute-command SVG path shape (M / C / L / Z — all these paths need).
struct SVGPath: Shape {
    let d: String
    let viewBox: CGFloat

    func path(in rect: CGRect) -> Path {
        var p = Path()
        var cmd: Character = " "
        var nums: [CGFloat] = []
        var numStr = ""

        func flushNum() {
            if let v = Double(numStr) { nums.append(CGFloat(v)) }
            numStr = ""
        }
        func consume() {
            switch cmd {
            case "M" where nums.count >= 2:
                p.move(to: CGPoint(x: nums[0], y: nums[1])); nums.removeFirst(2)
            case "L" where nums.count >= 2:
                p.addLine(to: CGPoint(x: nums[0], y: nums[1])); nums.removeFirst(2)
            case "C" where nums.count >= 6:
                p.addCurve(to: CGPoint(x: nums[4], y: nums[5]),
                           control1: CGPoint(x: nums[0], y: nums[1]),
                           control2: CGPoint(x: nums[2], y: nums[3]))
                nums.removeFirst(6)
            default: break
            }
        }

        for ch in d {
            if ch.isLetter {
                flushNum(); consume()
                if ch == "Z" { p.closeSubpath() }
                cmd = ch; nums = []
            } else if ch == " " || ch == "," {
                flushNum(); consume()
            } else {
                numStr.append(ch)
            }
        }
        flushNum(); consume()

        let s = min(rect.width, rect.height) / viewBox
        return p.applying(CGAffineTransform(scaleX: s, y: s)
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY)))
    }
}

func smoothstep(_ x: Double, _ a: Double, _ b: Double) -> Double {
    let u = min(1, max(0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)
}

/// One CoPlanner petal, re-centered on its own centroid so it can orbit and
/// spin around itself (the raw paths sit in the logo's corner coordinates).
struct OrbitPetal: View {
    let i: Int
    var spin: Double

    static let centers: [(CGFloat, CGFloat)] = [(10.2, 8.4), (28.7, 8.4), (29.3, 28.3), (9.8, 28.0)]

    var body: some View {
        let s: CGFloat = 60.0 / 38.0
        let c = Self.centers[i]
        SVGPath(d: COPLANNER_PETALS[i], viewBox: 38)
            .fill(LinearGradient(
                colors: [Color(red: 1.0, green: 0.48, blue: 0.16),
                         Color(red: 1.0, green: 0.36, blue: 0.0)],
                startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 60, height: 60)
            .offset(x: (19 - c.0) * s, y: (19 - c.1) * s)
            .rotationEffect(.degrees(spin))
    }
}

// MARK: - True petal → ring-arc morphing

/// Samples a petal's outline into evenly-many points (38-viewBox space, centered on 19,19).
func samplePetal(_ d: String, samples: Int) -> [CGPoint] {
    // Parse into segments first (M/L/C absolute — same grammar as SVGPath)
    var pts: [CGPoint] = []
    var cmd: Character = " "
    var nums: [CGFloat] = []
    var numStr = ""
    var cur = CGPoint.zero

    func emitCubic(_ c1: CGPoint, _ c2: CGPoint, _ to: CGPoint) {
        let k = 10
        for s in 1...k {
            let u = CGFloat(s) / CGFloat(k)
            let v = 1 - u
            let x = v*v*v*cur.x + 3*v*v*u*c1.x + 3*v*u*u*c2.x + u*u*u*to.x
            let y = v*v*v*cur.y + 3*v*v*u*c1.y + 3*v*u*u*c2.y + u*u*u*to.y
            pts.append(CGPoint(x: x, y: y))
        }
        cur = to
    }
    func flushNum() { if let v = Double(numStr) { nums.append(CGFloat(v)) }; numStr = "" }
    func consume() {
        switch cmd {
        case "M" where nums.count >= 2:
            cur = CGPoint(x: nums[0], y: nums[1]); pts.append(cur); nums.removeFirst(2)
        case "L" where nums.count >= 2:
            cur = CGPoint(x: nums[0], y: nums[1]); pts.append(cur); nums.removeFirst(2)
        case "C" where nums.count >= 6:
            emitCubic(CGPoint(x: nums[0], y: nums[1]), CGPoint(x: nums[2], y: nums[3]),
                      CGPoint(x: nums[4], y: nums[5]))
            nums.removeFirst(6)
        default: break
        }
    }
    for ch in d {
        if ch.isLetter { flushNum(); consume(); cmd = ch; nums = [] }
        else if ch == " " || ch == "," { flushNum(); consume() }
        else { numStr.append(ch) }
    }
    flushNum(); consume()

    // Resample to exactly `samples` points by arc length
    var lengths: [CGFloat] = [0]
    for i in 1..<pts.count {
        lengths.append(lengths[i-1] + hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y))
    }
    let total = lengths.last ?? 1
    var out: [CGPoint] = []
    var j = 0
    for s in 0..<samples {
        let target = total * CGFloat(s) / CGFloat(samples)
        while j < pts.count - 2 && lengths[j+1] < target { j += 1 }
        let seg = max(lengths[j+1] - lengths[j], 0.0001)
        let u = (target - lengths[j]) / seg
        out.append(CGPoint(x: pts[j].x + (pts[j+1].x - pts[j].x) * u,
                           y: pts[j].y + (pts[j+1].y - pts[j].y) * u))
    }
    return out.map { CGPoint(x: $0.x - 19, y: $0.y - 19) } // center on the mark's pivot
}

/// One petal that literally BENDS into a quarter-arc of the ring.
/// morph: 0 = petal, 1 = 90° annular arc segment (r 70.5–83.5 at unit scale 1 = pt).
struct MorphPetalShape: Shape {
    let i: Int
    var morph: Double

    static let samples = 72
    static let petalPts: [[CGPoint]] = COPLANNER_PETALS.map { samplePetal($0, samples: samples) }
    // Target arc centre angles per petal (screen coords, y down), from the mark's corners
    static let arcCenter: [Double] = [225, 315, 45, 135].map { $0 * .pi / 180 }

    var animatableData: Double {
        get { morph }
        set { morph = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let scale = min(rect.width, rect.height) / 190.0 // petal space → view space
        let src = Self.petalPts[i]
        let n = Self.samples
        let a0 = Self.arcCenter[i] - .pi / 4 + 0.03
        let a1 = Self.arcCenter[i] + .pi / 4 - 0.03
        let rOut: CGFloat = 83.5, rIn: CGFloat = 70.5

        // Target outline: outer arc forward, inner arc back — same point count
        var dst: [CGPoint] = []
        let half = n / 2
        for k in 0..<half {
            let a = a0 + (a1 - a0) * Double(k) / Double(half - 1)
            dst.append(CGPoint(x: cos(a) * rOut, y: sin(a) * rOut))
        }
        for k in 0..<(n - half) {
            let a = a1 - (a1 - a0) * Double(k) / Double(n - half - 1)
            dst.append(CGPoint(x: cos(a) * rIn, y: sin(a) * rIn))
        }

        // Rotate src start index so start aligns with the target's start direction
        var best = 0
        var bestD = CGFloat.greatestFiniteMagnitude
        let srcScale: CGFloat = 156.0 / 38.0 // mark rendered at 156 in a 190 space
        for k in 0..<n {
            let p = CGPoint(x: src[k].x * srcScale, y: src[k].y * srcScale)
            let d = hypot(p.x - dst[0].x, p.y - dst[0].y)
            if d < bestD { bestD = d; best = k }
        }

        var path = Path()
        let m = CGFloat(min(1, max(0, morph)))
        for k in 0..<n {
            let sp = src[(k + best) % n]
            let s = CGPoint(x: sp.x * srcScale, y: sp.y * srcScale)
            let dpt = dst[k]
            let x = c.x + (s.x + (dpt.x - s.x) * m) * scale
            let y = c.y + (s.y + (dpt.y - s.y) * m) * scale
            if k == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
        }
        path.closeSubpath()
        return path
    }
}

func easeOutBack(_ x: Double) -> Double {
    let c1 = 1.70158, c3 = c1 + 1
    let t = x - 1
    return 1 + c3 * t * t * t + c1 * t * t
}

func easeOutQuint(_ x: Double) -> Double { 1 - pow(1 - x, 5) }

/// The CoPlanner mark with the home-screen assembly animation:
/// petals scale 0→1 staggered (easeOutBack overshoot) while the whole
/// mark spins one turn (easeOutQuint) — then breathes and occasionally
/// does a flourish spin. `et` = seconds since the view appeared.
struct PetalLogoView: View {
    var t: Double
    var et: Double
    var size: CGFloat
    var extraSpin: Double = 0 // additional rotation, degrees (entrance wind-up)
    var colors: [Color] = [Color(red: 1.0, green: 0.48, blue: 0.16),
                           Color(red: 1.0, green: 0.36, blue: 0.0)] // #FF5C00 family

    private let stagger = 0.2
    private let scaleDur = 0.5
    private let spinDur = 1.3

    var body: some View {
        // Entrance spin + occasional idle flourish (360° ≡ 0°, so the jump is invisible)
        let entranceSpin = 360 * easeOutQuint(min(1, max(0, et / spinDur)))
        let flourish = 360 * easeOutQuint(min(1, max(0, ((t + 3).truncatingRemainder(dividingBy: 13)) / 1.6)))

        ZStack {
            ForEach(0..<4, id: \.self) { i in
                let enter = easeOutBack(min(1, max(0, (et - Double(i) * stagger) / scaleDur)))
                let breathe = 1 + 0.03 * sin(t * 2.1 + Double(i) * 1.6)
                SVGPath(d: COPLANNER_PETALS[i], viewBox: 38)
                    .fill(LinearGradient(colors: colors,
                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: size, height: size)
                    .scaleEffect(enter * breathe) // anchored at frame center == viewBox center
            }
        }
        .rotationEffect(.degrees(entranceSpin + flourish + extraSpin))
    }
}
