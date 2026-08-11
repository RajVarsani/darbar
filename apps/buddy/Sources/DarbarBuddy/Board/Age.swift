import Foundation

// Word-for-word the board's age vocabulary (apps/server/web/board.html: ageShort / relTime).
// Two surfaces describing the same decaying claim have to describe it the same way, or the notch
// quietly becomes a second opinion about whether a builder is alive.

/// compact age for a badge: "<1m", "7m", "3h", "2d"
func ageShort(_ seconds: TimeInterval) -> String {
    let s = max(0, seconds)
    if s < 60 { return "<1m" }
    if s < 3600 { return "\(Int(s / 60))m" }
    if s < 86_400 { return "\(Int(s / 3600))h" }
    return "\(Int(s / 86_400))d"
}

func ageShort(_ date: Date, now: Date) -> String { ageShort(now.timeIntervalSince(date)) }

/// prose age for a tooltip: "just now", "7m ago", "3h ago", "2d ago"
func relTime(_ date: Date, now: Date) -> String {
    let s = max(0, now.timeIntervalSince(date))
    if s < 60 { return "just now" }
    if s < 3600 { return "\(Int(s / 60))m ago" }
    if s < 86_400 { return "\(Int(s / 3600))h ago" }
    if s < 86_400 * 7 { return "\(Int(s / 86_400))d ago" }
    let f = DateFormatter()
    f.dateFormat = "d MMM"
    return f.string(from: date)
}

/// The board's dispatch tooltip, unchanged. A late dispatch says the builder may be dead, because
/// that is the only reading of a hand-off nobody has picked up in fifteen minutes.
func dispatchWhy(_ date: Date, now: Date, late: Bool) -> String {
    late
        ? "dispatched \(relTime(date, now: now)) and still no in_progress report. The builder may have died: re-dispatch it or mark it blocked"
        : "dispatched \(relTime(date, now: now)), waiting for the builder to report in_progress itself"
}
