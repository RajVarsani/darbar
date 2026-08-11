import SwiftUI

// MARK: - Orbie — the Saturn planet buddy

struct OrbieView: View {
    var t: Double
    @State private var bornAt: Double? = nil

    // One continuous transform language for entrance AND idle cycle:
    // petals spin faster and faster and BEND (true vertex morph) into a face-on
    // circle (planet materializing inside it) → circle 3D-tilts into the orbit.
    // morphM: 0 = petals, 1 = fully a ring.
    /// The ONE transform sequence, parameterized by progress time p ∈ [0, 3.5]:
    /// p<1.4 petals spinning up → 1.4-2.5 bend+blur into ring (planet pops 1.9-2.6,
    /// sparkle burst 2.4-3.05) → 2.6-3.4 3D tilt into orbit. Clicks replay this
    /// exact sequence forward (mark→Saturn) or backward (Saturn→mark) — nothing cut.
    static func seq(_ p: Double, t: Double)
        -> (faceOn: Double, morphM: Double, planetIn: Double, spin: Double, burst: Double) {
        let morphM = smoothstep(p, 1.4, 2.5)
        let faceOn = 1 - smoothstep(p, 2.6, 3.4)
        let planetIn = smoothstep(p, 1.9, 2.6)
        let spin = 360 * easeOutQuint(min(1, p / 1.3))
                 + 520 * pow(max(0, p - 0.9), 2.4)
                 + t * 8
        let burst = smoothstep(p, 2.4, 3.05)
        return (faceOn, morphM, planetIn, spin, burst)
    }

    static func phases(t: Double, et: Double)
        -> (inEntrance: Bool, faceOn: Double, morphM: Double,
            extraSpin: Double, planetIn: Double, burst: Double) {
        if et < 3.5 {
            let s = Self.seq(et, t: t)
            return (true, s.faceOn, s.morphM, s.spin, s.planetIn, s.burst)
        }
        // No auto-loop: clicks replay the full sequence in either direction.
        // Toggle joins at p=1.0 (petals already assembled), 2.5s per direction.
        let tt = t - AppState.orbieToggleAt
        let p = AppState.orbieSaturn ? min(3.5, tt + 1.0) : max(1.0, 3.5 - tt)
        let s = Self.seq(p, t: t)
        return (false, s.faceOn, s.morphM, s.spin, s.planetIn, s.burst)
    }

    // Per-petal assembly anchors (each petal's own centroid within the 190 frame)
    static let petalAnchors: [UnitPoint] = [
        UnitPoint(x: 0.310, y: 0.271), UnitPoint(x: 0.709, y: 0.271),
        UnitPoint(x: 0.723, y: 0.701), UnitPoint(x: 0.301, y: 0.694),
    ]

    @ViewBuilder
    static func morphPetals(et: Double, morphM: Double, inEntrance: Bool) -> some View {
        // Color rides the bend: CoPlanner orange as petals, Saturn-ring lavender
        // by the time they close into the ring (fully lavender before the handoff).
        let c = smoothstep(morphM, 0.15, 0.85)
        let topColor = Color(red: 1.0 + (0.87 - 1.0) * c,
                             green: 0.48 + (0.44 - 0.48) * c,
                             blue: 0.16 + (0.18 - 0.16) * c)
        let botColor = Color(red: 1.0 + (0.7 - 1.0) * c,
                             green: 0.36 + (0.32 - 0.36) * c,
                             blue: 0.0 + (0.12 - 0.0) * c)
        ForEach(0..<4, id: \.self) { i in
            let entry = inEntrance
                ? easeOutBack(min(1, max(0, (et - Double(i) * 0.2) / 0.5))) : 1
            MorphPetalShape(i: i, morph: morphM)
                .fill(LinearGradient(colors: [topColor, botColor],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 190, height: 190)
                .scaleEffect(max(0.001, entry), anchor: petalAnchors[i])
        }
    }

    var body: some View {
        FloatingPet(t: t, bobAmp: 8, bobFreq: 1.4, shadowWidth: 100) { t in
            let ringTilt = -16 + sin(t * 0.8) * 5
            // Seconds since appearing — drives the home-screen assembly entrance.
            // Snapshot renders (no onAppear) fall back to "long since assembled".
            let et = t - (bornAt ?? t - 10)

            // ONE continuous transform, entrance and idle cycle speaking the same
            // language: petals spin faster and faster → squeeze → blur into a
            // face-on circle (propeller-disc) while the planet materializes
            // inside it → the circle 3D-tilts down into Saturn's orbit. The idle
            // cycle then runs the same transform backwards and forwards forever.
            let ph = Self.phases(t: t, et: et)
            let inEntrance = ph.inEntrance
            let morphM = ph.morphM
            let extraSpin = ph.extraSpin
            let planetIn = ph.planetIn
            // Real ring arcs take over only for the last 15% of the morph,
            // when the bent petals already form a near-perfect circle.
            let ringOp = smoothstep(morphM, 0.85, 1.0)
            let ringW = 180.0 - 26.0 * ph.faceOn              // → 154 circle diameter
            let ringH = 62.0 + (154.0 - 62.0) * ph.faceOn     // ellipse opens into a circle
            let tiltNow = ringTilt * (1 - ph.faceOn)
            let ghost = min(1, morphM * (1 - morphM) * 4)     // spin-blur ghost mid-morph
            let burst = ph.burst

            ZStack {
                ZStack {
                    // Back half of the ring — as the ellipse opens to a circle, this
                    // half shows around the planet's silhouette (free 3D occlusion)
                    RingArc(front: false)
                        .stroke(
                            LinearGradient(
                                colors: [Color(red: 0.78, green: 0.36, blue: 0.15),
                                         Color(red: 0.66, green: 0.29, blue: 0.11)],
                                startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: 13, lineCap: .round))
                        .frame(width: ringW, height: ringH)
                        .rotationEffect(.degrees(tiltNow))
                        .opacity(ringOp)

                    // Planet body — the original peach Orbie; the ring is lavender,
                    // so the CoPlanner orange lives only in the petal form.
                    Group {
                        Circle()
                            .fill(
                                LinearGradient(
                                    colors: [Color(red: 0.97, green: 0.85, blue: 0.47),
                                             Color(red: 0.94, green: 0.74, blue: 0.3)],
                                    startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 124, height: 124)

                        // Soft banding + craters
                        Ellipse()
                            .fill(Color(red: 0.93, green: 0.62, blue: 0.22).opacity(0.75))
                            .frame(width: 52, height: 22)
                            .offset(x: -30, y: -38)
                        Circle().fill(Color(red: 0.93, green: 0.62, blue: 0.22).opacity(0.8))
                            .frame(width: 13, height: 13).offset(x: 42, y: -20)
                        Circle().fill(Color(red: 0.93, green: 0.62, blue: 0.22).opacity(0.7))
                            .frame(width: 8, height: 8).offset(x: 34, y: 32)
                    }
                    .scaleEffect(max(0.001, easeOutBack(planetIn)))
                    .opacity(min(1, planetIn * 2.5))

                    // Front half of the ring
                    RingArc(front: true)
                        .stroke(
                            LinearGradient(
                                colors: [Color(red: 0.89, green: 0.46, blue: 0.2),
                                         Color(red: 0.76, green: 0.36, blue: 0.14)],
                                startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: 13, lineCap: .round))
                        .frame(width: ringW, height: ringH)
                        .rotationEffect(.degrees(tiltNow))
                        .opacity(ringOp)

                    // Face — eyes follow the user's cursor
                    Group {
                        VStack(spacing: 4) {
                            CuteEyes(t: t, spacing: 30, size: 12, followCursor: true)
                            Smile(width: 18)
                        }
                        .offset(y: -4)
                        Blush(spacing: 74, size: 16).offset(y: 6)
                    }
                    .opacity(min(1, planetIn * 2.5))

                    // The four petals — spinning up and literally BENDING into the
                    // ring (vertex morph). Ghost copy sells the propeller-disc blur.
                    if morphM < 0.995 {
                        ZStack { Self.morphPetals(et: et, morphM: morphM, inEntrance: inEntrance) }
                            .rotationEffect(.degrees(extraSpin))
                        ZStack { Self.morphPetals(et: et, morphM: morphM, inEntrance: inEntrance) }
                            .rotationEffect(.degrees(extraSpin + 30))
                            .opacity(ghost * 0.35)
                    }

                    TwinkleSparkle(t: t, offset: 0.4, size: 15).offset(x: -82, y: -55)
                    TwinkleSparkle(t: t, offset: 1.7, size: 11).offset(x: 84, y: 30)
                }

                // Sparkle burst as the ring snaps into being
                if burst > 0 && burst < 1 {
                    ForEach(0..<8, id: \.self) { i in
                        let a = Double(i) * .pi / 4 + 0.4
                        let r = 40 + 66 * easeOutQuint(burst)
                        SparkleShape()
                            .fill(i % 2 == 0 ? Color(red: 1.0, green: 0.85, blue: 0.4) : .white)
                            .frame(width: i % 3 == 0 ? 13 : 8, height: i % 3 == 0 ? 13 : 8)
                            .rotationEffect(.degrees(burst * 220 + Double(i) * 45))
                            .offset(x: cos(a) * r, y: sin(a) * r)
                            .opacity(1 - burst * burst)
                    }
                }
            }
            // Anchor the entrance to the timeline's own clock (snapshots skip it
            // unless an entrance age is explicitly requested for offline review)
            .onAppear { bornAt = RenderMode.snapshot ? t - (RenderMode.entranceAge ?? 10) : t }
        }
    }
}

/// Elliptical ring arc: `front` = the half that passes in front of the planet.
struct RingArc: Shape {
    var front: Bool
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        // Parametric ellipse; front half = the lower sweep (angles 0→π in screen coords).
        let steps = 40
        let (from, to): (Double, Double) = front ? (0, .pi) : (.pi, 2 * .pi)
        for i in 0...steps {
            let a = from + (to - from) * Double(i) / Double(steps)
            let pt = CGPoint(x: c.x + cos(a) * rect.width / 2,
                             y: c.y + sin(a) * rect.height / 2)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        return p
    }
}

// MARK: - Cappy — the capybara analyst (Typibara homage)

struct CappyView: View {
    var t: Double

    var body: some View {
        FloatingPet(t: t, bobAmp: 4, bobFreq: 1.8, shadowWidth: 110) { t in
            let typeL = sin(t * 7) > 0
            let breathe = 1 + 0.012 * sin(t * 1.8)

            ZStack {
                let fur = Color(red: 0.71, green: 0.5, blue: 0.35)
                let furDark = Color(red: 0.55, green: 0.38, blue: 0.26)

                // Body (sitting blob)
                UnevenRoundedRectangle(topLeadingRadius: 56, bottomLeadingRadius: 40,
                                       bottomTrailingRadius: 40, topTrailingRadius: 56)
                    .fill(fur)
                    .frame(width: 116, height: 84)
                    .offset(y: 44)

                // Head — capybaras are gloriously rectangular
                UnevenRoundedRectangle(topLeadingRadius: 44, bottomLeadingRadius: 34,
                                       bottomTrailingRadius: 34, topTrailingRadius: 44)
                    .fill(fur)
                    .frame(width: 128, height: 96)
                    .offset(y: -18)
                    .scaleEffect(breathe)

                // Ears
                Circle().fill(furDark).frame(width: 22, height: 22).offset(x: -48, y: -60)
                Circle().fill(fur).frame(width: 15, height: 15).offset(x: -47, y: -58)
                Circle().fill(furDark).frame(width: 22, height: 22).offset(x: 48, y: -60)
                Circle().fill(fur).frame(width: 15, height: 15).offset(x: 47, y: -58)

                // Muzzle
                UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: 26,
                                       bottomTrailingRadius: 26, topTrailingRadius: 22)
                    .fill(Color(red: 0.62, green: 0.43, blue: 0.3))
                    .frame(width: 58, height: 40)
                    .offset(y: 4)
                // Nose
                Ellipse().fill(Color(red: 0.25, green: 0.17, blue: 0.13))
                    .frame(width: 14, height: 9).offset(y: -6)
                SmileArc()
                    .stroke(Color(red: 0.25, green: 0.17, blue: 0.13),
                            style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 12, height: 5).offset(y: 8)

                // Eyes + blush
                CuteEyes(t: t, spacing: 74, size: 10).offset(y: -18)
                Blush(spacing: 104, size: 14).offset(y: -6)

                // Round advisor glasses
                Group {
                    Circle().stroke(Color(red: 0.2, green: 0.15, blue: 0.12).opacity(0.85), lineWidth: 2.5)
                        .frame(width: 30, height: 30).offset(x: -37, y: -18)
                    Circle().stroke(Color(red: 0.2, green: 0.15, blue: 0.12).opacity(0.85), lineWidth: 2.5)
                        .frame(width: 30, height: 30).offset(x: 37, y: -18)
                    Rectangle().fill(Color(red: 0.2, green: 0.15, blue: 0.12).opacity(0.85))
                        .frame(width: 16, height: 2.5).offset(y: -22)
                }

                // Tiny keyboard
                RoundedRectangle(cornerRadius: 7)
                    .fill(Color(red: 0.16, green: 0.16, blue: 0.2))
                    .frame(width: 104, height: 26)
                    .rotationEffect(.degrees(-4))
                    .offset(y: 84)
                // RGB glow strip
                RoundedRectangle(cornerRadius: 3)
                    .fill(LinearGradient(colors: [.pink, .purple, .cyan, .green], startPoint: .leading, endPoint: .trailing))
                    .frame(width: 100, height: 4)
                    .rotationEffect(.degrees(-4))
                    .offset(y: 95)
                    .opacity(0.6 + 0.4 * sin(t * 3))
                // Keys
                HStack(spacing: 3) {
                    ForEach(0..<8, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color(red: 0.3, green: 0.3, blue: 0.36))
                            .frame(width: 9, height: 9)
                    }
                }
                .rotationEffect(.degrees(-4))
                .offset(y: 81)

                // Typing paws
                Ellipse().fill(furDark).frame(width: 24, height: 18)
                    .offset(x: -30, y: typeL ? 66 : 72)
                Ellipse().fill(furDark).frame(width: 24, height: 18)
                    .offset(x: 30, y: typeL ? 72 : 66)

                TwinkleSparkle(t: t, offset: 0.9, size: 13).offset(x: 78, y: 60)
                TwinkleSparkle(t: t, offset: 2.1, size: 10).offset(x: -80, y: -70)
            }
        }
    }
}

// MARK: - Pip — the letter that learned to fly

struct PipView: View {
    var t: Double

    var body: some View {
        FloatingPet(t: t, bobAmp: 10, bobFreq: 1.9, shadowWidth: 84) { t in
            let bank = sin(t * 1.1) * 7

            ZStack {
                // Motion trail
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color(red: 0.65, green: 0.75, blue: 1.0).opacity(0.5 - Double(i) * 0.15))
                        .frame(width: 10 - CGFloat(i) * 2.5)
                        .offset(x: -70 - CGFloat(i) * 18,
                                y: 30 + CGFloat(sin(t * 1.9 - Double(i) * 0.7)) * 10)
                }

                Group {
                    // Paper plane: main wing
                    PlaneShape()
                        .fill(LinearGradient(colors: [.white, Color(red: 0.88, green: 0.91, blue: 1.0)],
                                             startPoint: .top, endPoint: .bottom))
                        .frame(width: 150, height: 110)
                    PlaneShape()
                        .stroke(Color(red: 0.55, green: 0.6, blue: 0.85), lineWidth: 2.5)
                        .frame(width: 150, height: 110)
                    // Fold shadow
                    PlaneFold()
                        .fill(Color(red: 0.75, green: 0.8, blue: 0.98).opacity(0.8))
                        .frame(width: 150, height: 110)

                    // Wax seal (it's a letter, after all)
                    Circle().fill(Color(red: 0.9, green: 0.36, blue: 0.4))
                        .frame(width: 17, height: 17).offset(x: 30, y: 15)
                    SparkleShape().fill(.white.opacity(0.85))
                        .frame(width: 9, height: 9).offset(x: 30, y: 15)

                    // Face on the nose
                    CuteEyes(t: t, spacing: 16, size: 9).offset(x: -42, y: -4)
                    Smile(width: 12).offset(x: -42, y: 10)
                    Blush(spacing: 42, size: 10).offset(x: -42, y: 5)
                }
                .rotationEffect(.degrees(bank))

                TwinkleSparkle(t: t, offset: 0.2, size: 14).offset(x: 74, y: -52)
                TwinkleSparkle(t: t, offset: 1.4, size: 10).offset(x: 60, y: 48)
            }
        }
    }
}

struct PlaneShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let nose = CGPoint(x: rect.minX, y: rect.midY - rect.height * 0.05)
        p.move(to: nose)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))                       // top wing tip
        p.addLine(to: CGPoint(x: rect.midX + rect.width * 0.1, y: rect.midY + rect.height * 0.12)) // wing root
        p.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.15, y: rect.maxY))   // lower wing tip
        p.closeSubpath()
        return p
    }
}

struct PlaneFold: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let nose = CGPoint(x: rect.minX, y: rect.midY - rect.height * 0.05)
        p.move(to: nose)
        p.addLine(to: CGPoint(x: rect.midX + rect.width * 0.1, y: rect.midY + rect.height * 0.12))
        p.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.15, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}

// MARK: - Sage — the owl who has read every fund factsheet

struct SageView: View {
    var t: Double

    var body: some View {
        FloatingPet(t: t, bobAmp: 5, bobFreq: 1.5, shadowWidth: 96) { t in
            let headTilt = pulse(t, period: 5.2, width: 1.6) * 6
            let wingLift = pulse(t, period: 7.0, width: 1.2, offset: 2.0)

            ZStack {
                let feather = Color(red: 0.52, green: 0.44, blue: 0.62)
                let featherDark = Color(red: 0.4, green: 0.33, blue: 0.5)

                // Body
                Ellipse().fill(feather).frame(width: 108, height: 128).offset(y: 14)
                // Belly
                Ellipse().fill(Color(red: 0.93, green: 0.88, blue: 0.98))
                    .frame(width: 72, height: 84).offset(y: 34)
                // Belly feather flecks (staggered so they never form a face)
                SmileArc()
                    .stroke(feather.opacity(0.4), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 12, height: 5).offset(x: -18, y: 32)
                SmileArc()
                    .stroke(feather.opacity(0.4), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 12, height: 5).offset(x: 12, y: 54)

                // Wings
                Ellipse().fill(featherDark).frame(width: 34, height: 74)
                    .rotationEffect(.degrees(18 + wingLift * -30), anchor: .top)
                    .offset(x: -52, y: 16)
                Ellipse().fill(featherDark).frame(width: 34, height: 74)
                    .rotationEffect(.degrees(-18), anchor: .top)
                    .offset(x: 52, y: 16)

                // Head group (tilts)
                ZStack {
                    // Ear tufts
                    Triangle().fill(featherDark).frame(width: 22, height: 26)
                        .rotationEffect(.degrees(-14)).offset(x: -36, y: -88)
                    Triangle().fill(featherDark).frame(width: 22, height: 26)
                        .rotationEffect(.degrees(14)).offset(x: 36, y: -88)

                    Circle().fill(feather).frame(width: 104, height: 104).offset(y: -46)

                    // Giant scholar glasses
                    Circle().fill(.white).frame(width: 38, height: 38).offset(x: -24, y: -48)
                    Circle().fill(.white).frame(width: 38, height: 38).offset(x: 24, y: -48)
                    Circle().stroke(Color(red: 0.85, green: 0.65, blue: 0.3), lineWidth: 3.5)
                        .frame(width: 38, height: 38).offset(x: -24, y: -48)
                    Circle().stroke(Color(red: 0.85, green: 0.65, blue: 0.3), lineWidth: 3.5)
                        .frame(width: 38, height: 38).offset(x: 24, y: -48)
                    Rectangle().fill(Color(red: 0.85, green: 0.65, blue: 0.3))
                        .frame(width: 12, height: 3).offset(y: -52)

                    CuteEyes(t: t, spacing: 32, size: 12).offset(y: -48)

                    // Beak
                    Triangle().fill(Color(red: 0.95, green: 0.72, blue: 0.35))
                        .frame(width: 16, height: 14)
                        .rotationEffect(.degrees(180))
                        .offset(y: -22)
                    Blush(spacing: 92, size: 13, color: Color(red: 1.0, green: 0.75, blue: 0.82)).offset(y: -32)
                }
                .rotationEffect(.degrees(headTilt), anchor: .bottom)

                // Pencil tucked under right wing
                Capsule().fill(Color(red: 0.98, green: 0.75, blue: 0.3))
                    .frame(width: 46, height: 9)
                    .rotationEffect(.degrees(-40)).offset(x: 62, y: 40)
                Triangle().fill(Color(red: 0.93, green: 0.85, blue: 0.72))
                    .frame(width: 10, height: 10)
                    .rotationEffect(.degrees(130)).offset(x: 76, y: 25)

                TwinkleSparkle(t: t, offset: 0.7, size: 12).offset(x: -78, y: -70)
            }
        }
    }
}

struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}
