import SwiftUI

// MARK: - Nova — the sentient ✦

struct NovaView: View {
    var t: Double

    var body: some View {
        FloatingPet(t: t, bobAmp: 9, bobFreq: 1.7, shadowWidth: 80) { t in
            let breathe = 1 + 0.045 * sin(t * 2.2)
            let spin = t * 14 // slow orbit for satellites

            ZStack {
                // Orbiting baby sparkles
                ForEach(0..<3, id: \.self) { i in
                    let a = spin * .pi / 180 + Double(i) * 2.1
                    SparkleShape()
                        .fill(Color(red: 1.0, green: 0.83, blue: 0.45))
                        .frame(width: 13, height: 13)
                        .opacity(0.45 + 0.55 * pulse(t, period: 2.2, width: 1.0, offset: Double(i) * 0.7))
                        .offset(x: cos(a) * 88, y: sin(a) * 62)
                }

                // Glow halo (rotates with the body so no spikes peek out)
                SparkleShape()
                    .fill(Color(red: 0.62, green: 0.45, blue: 1.0).opacity(0.35))
                    .frame(width: 168, height: 168)
                    .blur(radius: 18)
                    .scaleEffect(breathe)
                    .rotationEffect(.degrees(sin(t * 0.9) * 5))

                // Main star body
                SparkleShape()
                    .fill(LinearGradient(
                        colors: [Color(red: 0.78, green: 0.6, blue: 1.0),
                                 Color(red: 0.5, green: 0.36, blue: 0.95)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 150, height: 150)
                    .scaleEffect(breathe)
                    .rotationEffect(.degrees(sin(t * 0.9) * 5))

                // Inner shine
                SparkleShape()
                    .fill(Color.white.opacity(0.14))
                    .frame(width: 96, height: 96)
                    .offset(x: -4, y: -6)
                    .scaleEffect(breathe)
                    .rotationEffect(.degrees(sin(t * 0.9) * 5))

                // Face
                VStack(spacing: 4) {
                    CuteEyes(t: t, spacing: 26, size: 11, color: Color(red: 0.16, green: 0.1, blue: 0.3))
                    Smile(width: 15, color: Color(red: 0.16, green: 0.1, blue: 0.3))
                }
                Blush(spacing: 62, size: 13, color: Color(red: 1.0, green: 0.6, blue: 0.75)).offset(y: 8)
            }
        }
    }
}

// MARK: - Bolt — the tiny copilot bot

struct BoltView: View {
    var t: Double

    var body: some View {
        FloatingPet(t: t, bobAmp: 7, bobFreq: 2.1, shadowWidth: 86) { t in
            // Fake propeller spin by squashing X through a sine
            let propSquash = sin(t * 16)
            let antennaOn = (t.truncatingRemainder(dividingBy: 1.4)) < 0.7

            ZStack {
                let shell = Color(red: 0.88, green: 0.9, blue: 0.95)
                let shellDark = Color(red: 0.68, green: 0.72, blue: 0.82)

                // Thruster flame
                Ellipse()
                    .fill(LinearGradient(colors: [Color(red: 1.0, green: 0.82, blue: 0.35),
                                                  Color(red: 1.0, green: 0.5, blue: 0.2).opacity(0)],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: 20, height: 30 + CGFloat(sin(t * 11)) * 7)
                    .offset(y: 80)
                    .blur(radius: 1.5)

                // Body
                RoundedRectangle(cornerRadius: 22)
                    .fill(shell)
                    .frame(width: 76, height: 58)
                    .offset(y: 42)
                // Chest core: a little Saturn ring gauge
                Circle().fill(Color(red: 0.3, green: 0.32, blue: 0.42))
                    .frame(width: 28, height: 28).offset(y: 42)
                Circle().fill(Color(red: 1.0, green: 0.72, blue: 0.4))
                    .frame(width: 13, height: 13).offset(y: 42)
                Ellipse().stroke(Color(red: 0.72, green: 0.62, blue: 0.98), lineWidth: 2.5)
                    .frame(width: 26, height: 10)
                    .rotationEffect(.degrees(-18))
                    .offset(y: 42)

                // Arms — stubby, one waves occasionally
                Capsule().fill(shellDark).frame(width: 14, height: 34)
                    .rotationEffect(.degrees(20), anchor: .top).offset(x: -48, y: 44)
                Capsule().fill(shellDark).frame(width: 14, height: 34)
                    .rotationEffect(.degrees(-20 - pulse(t, period: 6, width: 1.4, offset: 1) * 120), anchor: .top)
                    .offset(x: 48, y: 44)

                // Head
                RoundedRectangle(cornerRadius: 26)
                    .fill(shell)
                    .frame(width: 108, height: 84)
                    .offset(y: -22)
                // Screen face
                RoundedRectangle(cornerRadius: 18)
                    .fill(Color(red: 0.13, green: 0.15, blue: 0.22))
                    .frame(width: 88, height: 62)
                    .offset(y: -22)

                // Pixel eyes (cyan, blink via squash)
                let blink = isBlinking(t) ? 0.12 : 1.0
                HStack(spacing: 26) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color(red: 0.4, green: 0.95, blue: 1.0))
                        .frame(width: 14, height: 20)
                        .scaleEffect(y: blink)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color(red: 0.4, green: 0.95, blue: 1.0))
                        .frame(width: 14, height: 20)
                        .scaleEffect(y: blink)
                }
                .offset(y: -26)
                // Pixel smile
                SmileArc()
                    .stroke(Color(red: 0.4, green: 0.95, blue: 1.0),
                            style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .frame(width: 18, height: 7)
                    .offset(y: -6)

                // Side ear bolts
                Circle().fill(shellDark).frame(width: 16).offset(x: -58, y: -22)
                Circle().fill(shellDark).frame(width: 16).offset(x: 58, y: -22)

                // Propeller cap
                Triangle().fill(Color(red: 0.95, green: 0.45, blue: 0.45))
                    .frame(width: 30, height: 18)
                    .rotationEffect(.degrees(180))
                    .offset(y: -70)
                Capsule()
                    .fill(Color(red: 0.45, green: 0.8, blue: 0.95))
                    .frame(width: 64, height: 10)
                    .scaleEffect(x: abs(propSquash) < 0.15 ? 0.15 : abs(propSquash))
                    .offset(y: -80)
                Circle().fill(Color(red: 0.95, green: 0.75, blue: 0.3))
                    .frame(width: 10).offset(y: -80)

                // Antenna blink
                Rectangle().fill(shellDark).frame(width: 3, height: 14).offset(x: 40, y: -70)
                Circle()
                    .fill(antennaOn ? Color(red: 1.0, green: 0.4, blue: 0.45) : shellDark)
                    .frame(width: 9)
                    .offset(x: 40, y: -79)
                    .shadow(color: antennaOn ? .red.opacity(0.8) : .clear, radius: 4)

                TwinkleSparkle(t: t, offset: 1.1, size: 12).offset(x: 76, y: -60)
            }
        }
    }
}

// MARK: - Mochi — the squishy ghost intern

struct MochiView: View {
    var t: Double

    var body: some View {
        FloatingPet(t: t, bobAmp: 11, bobFreq: 1.3, shadowWidth: 88) { t in
            let squish = 1 + 0.05 * sin(t * 2.6)
            let wandWave = pulse(t, period: 4.6, width: 1.5) * 18

            ZStack {
                let bodyColor = Color(red: 0.85, green: 0.95, blue: 0.92)

                // Body
                BlobShape(waveT: t)
                    .fill(LinearGradient(colors: [.white, bodyColor],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: 124, height: 138)
                    .scaleEffect(x: 2 - squish, y: squish)
                BlobShape(waveT: t)
                    .stroke(Color(red: 0.55, green: 0.75, blue: 0.7).opacity(0.5), lineWidth: 2)
                    .frame(width: 124, height: 138)
                    .scaleEffect(x: 2 - squish, y: squish)

                // Stubby left arm
                Ellipse().fill(bodyColor).frame(width: 26, height: 18)
                    .rotationEffect(.degrees(-20))
                    .offset(x: -62, y: 18)

                // Right arm holds a sparkle wand (arm + wand + star pivot together)
                ZStack {
                    Ellipse().fill(bodyColor).frame(width: 26, height: 18)
                        .offset(y: 44)
                    Capsule().fill(Color(red: 0.95, green: 0.72, blue: 0.4))
                        .frame(width: 5, height: 46)
                        .offset(y: 16)
                    SparkleShape()
                        .fill(Color(red: 1.0, green: 0.8, blue: 0.35))
                        .frame(width: 22, height: 22)
                        .rotationEffect(.degrees(sin(t * 2) * 15))
                        .offset(y: -14)
                        .shadow(color: .yellow.opacity(0.6), radius: 5)
                }
                .rotationEffect(.degrees(14 + wandWave), anchor: .bottom)
                .offset(x: 62, y: -14)

                // Face
                CuteEyes(t: t, spacing: 34, size: 12,
                         color: Color(red: 0.25, green: 0.32, blue: 0.35)).offset(y: -22)
                OpenSmile(width: 13).offset(y: -6)
                Blush(spacing: 72, size: 14).offset(y: -10)

                TwinkleSparkle(t: t, offset: 0.3, size: 13).offset(x: -76, y: -58)
                TwinkleSparkle(t: t, offset: 1.9, size: 10).offset(x: 66, y: 62)
            }
        }
    }
}

/// Ghost blob with a gently waving scalloped bottom.
struct BlobShape: Shape {
    var waveT: Double
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let w = rect.width, h = rect.height
        let waveAmp = h * 0.035
        let bottomY = h * 0.9

        p.move(to: CGPoint(x: 0, y: h * 0.45))
        // Left side up and over the dome
        p.addQuadCurve(to: CGPoint(x: w * 0.5, y: 0),
                       control: CGPoint(x: 0, y: -h * 0.05))
        p.addQuadCurve(to: CGPoint(x: w, y: h * 0.45),
                       control: CGPoint(x: w, y: -h * 0.05))
        // Right side down
        p.addLine(to: CGPoint(x: w, y: bottomY - waveAmp))
        // Scalloped bottom (3 waves), animated subtly
        let scallops = 3
        for i in 0..<scallops {
            let x0 = w - w * CGFloat(i) / CGFloat(scallops)
            let x1 = w - w * CGFloat(i + 1) / CGFloat(scallops)
            let mid = (x0 + x1) / 2
            let lift = CGFloat(sin(waveT * 2.4 + Double(i) * 1.3)) * waveAmp
            p.addQuadCurve(to: CGPoint(x: x1, y: bottomY - waveAmp),
                           control: CGPoint(x: mid, y: bottomY + waveAmp * 2 + lift))
        }
        p.closeSubpath()
        return p
    }
}

// MARK: - Ringo — the cat who stole Saturn's ring

struct RingoView: View {
    var t: Double

    var body: some View {
        FloatingPet(t: t, bobAmp: 4, bobFreq: 1.4, shadowWidth: 100) { t in
            let tailWag = sin(t * 2.2) * 14
            let earTwitch = pulse(t, period: 6.5, width: 0.5, offset: 3) * 12

            ZStack {
                let coat = Color(red: 0.42, green: 0.45, blue: 0.55)
                let coatLight = Color(red: 0.55, green: 0.58, blue: 0.68)

                // Tail (behind body): capsule + cream tip rotate together from the base
                ZStack {
                    Capsule().fill(coat).frame(width: 15, height: 70)
                    Circle().fill(Color(red: 0.93, green: 0.88, blue: 0.8))
                        .frame(width: 17)
                        .offset(y: -30)
                }
                .rotationEffect(.degrees(38 + tailWag), anchor: .bottom)
                .offset(x: 50, y: 26)

                // Body (sitting loaf)
                Ellipse().fill(coat).frame(width: 104, height: 96).offset(y: 34)
                // Chest patch
                Ellipse().fill(Color(red: 0.93, green: 0.88, blue: 0.8))
                    .frame(width: 52, height: 58).offset(y: 46)

                // Front paws
                Ellipse().fill(coatLight).frame(width: 26, height: 16).offset(x: -20, y: 78)
                Ellipse().fill(coatLight).frame(width: 26, height: 16).offset(x: 20, y: 78)

                // The stolen ring — worn as a collar, glowing faintly
                Ellipse()
                    .stroke(LinearGradient(colors: [Color(red: 0.85, green: 0.72, blue: 1.0),
                                                    Color(red: 0.6, green: 0.5, blue: 0.95)],
                                           startPoint: .leading, endPoint: .trailing),
                            style: StrokeStyle(lineWidth: 8, lineCap: .round))
                    .frame(width: 96, height: 30)
                    .rotationEffect(.degrees(-6))
                    .offset(y: 4)
                    .shadow(color: Color(red: 0.7, green: 0.55, blue: 1.0).opacity(0.5 + 0.3 * sin(t * 2)), radius: 6)

                // Head
                Circle().fill(coat).frame(width: 92, height: 92).offset(y: -38)

                // Ears
                Triangle().fill(coat).frame(width: 32, height: 30)
                    .rotationEffect(.degrees(-12 - earTwitch)).offset(x: -32, y: -84)
                Triangle().fill(Color(red: 0.95, green: 0.7, blue: 0.75)).frame(width: 16, height: 16)
                    .rotationEffect(.degrees(-12 - earTwitch)).offset(x: -31, y: -79)
                Triangle().fill(coat).frame(width: 32, height: 30)
                    .rotationEffect(.degrees(12)).offset(x: 32, y: -84)
                Triangle().fill(Color(red: 0.95, green: 0.7, blue: 0.75)).frame(width: 16, height: 16)
                    .rotationEffect(.degrees(12)).offset(x: 31, y: -79)

                // Face
                CuteEyes(t: t, spacing: 36, size: 11).offset(y: -42)
                // Nose + cat mouth
                Triangle().fill(Color(red: 0.95, green: 0.6, blue: 0.65))
                    .frame(width: 10, height: 8)
                    .rotationEffect(.degrees(180)).offset(y: -28)
                // "ω" cat mouth: two little smiles meeting under the nose
                SmileArc()
                    .stroke(Color(red: 0.2, green: 0.15, blue: 0.15), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 9, height: 5).offset(x: -4.5, y: -20)
                SmileArc()
                    .stroke(Color(red: 0.2, green: 0.15, blue: 0.15), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .frame(width: 9, height: 5).offset(x: 4.5, y: -20)
                Blush(spacing: 66, size: 13).offset(y: -30)

                // Whiskers
                ForEach(0..<2, id: \.self) { i in
                    let y = CGFloat(i) * 7 - 32
                    Rectangle().fill(Color.white.opacity(0.7)).frame(width: 20, height: 1.5)
                        .rotationEffect(.degrees(Double(i) * 8 - 4)).offset(x: -56, y: y)
                    Rectangle().fill(Color.white.opacity(0.7)).frame(width: 20, height: 1.5)
                        .rotationEffect(.degrees(Double(i) * -8 + 4)).offset(x: 56, y: y)
                }

                TwinkleSparkle(t: t, offset: 0.6, size: 12).offset(x: -74, y: -66)
                TwinkleSparkle(t: t, offset: 2.4, size: 10).offset(x: 80, y: -20)
            }
        }
    }
}
