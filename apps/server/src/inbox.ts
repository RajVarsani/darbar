// ---------- the doorbell on the orchestrator's inbox ----------
//
// DAR-245. Gabbar files a pending feedback row and nothing tells the orchestrator. Teammate C's idea
// sat in the queue until Raj typed "process the feedbacks"; a held report promoted only because Raj
// happened to add him as a stakeholder and that triggered the sweep by luck. The pending queue IS
// the orchestrator's inbox and nothing rang it.
//
// WHAT ACTUALLY WAKES A CLAUDE SESSION, since that is the part everything else hangs off.
// A session sitting idle at the prompt cannot be reached by any external process: there is no stdin
// injection, no socket, no signal. `claude --resume` starts a SECOND process against the saved
// transcript, it does not resume the live one. What the harness DOES have is a task-notification: a
// message delivered to the session that re-invokes the model when it is idle, and is queued behind
// the current turn when it is not. A background bash command (`run_in_background`) emits exactly one
// of those WHEN THE PROCESS EXITS, and a background shell started by the main session has no
// lifetime cap. So the wake carrier is a process exit, and this file exists to hold that process
// open until there is a reason to let it exit.
//
// Hence the shape of the route in api.ts: a chunked HTTP response that writes a keepalive byte
// often enough to survive Bun's idleTimeout, then writes the inbox and CLOSES. `curl` exits when the
// server closes, the harness sees the process exit, and the session wakes with the payload already
// in hand. Nothing here polls, and no token is spent while the queue is empty.
//
// This module is the in-process half: the thing that tells an armed waiter the inbox just changed.
// It is deliberately the same shape as sse.ts next door (a registry keyed by a string, a fire that
// hands off to everyone listening) rather than a second, cleverer mechanism.
//
// LEVEL-TRIGGERED, NOT EDGE-TRIGGERED, and that is the property that makes the whole thing safe to
// lose. A nudge that lands while nobody is armed is dropped on the floor and costs nothing, because
// the route re-evaluates the actual queue every time it is armed: whatever was missed is simply
// there on the next arm. Delivery is therefore best-effort by design, which is why there is no
// buffer, no sequence number and nothing to replay.

/** resolve callbacks for the waiters currently armed, keyed by project id hex */
const waiters = new Map<string, Set<() => void>>();

/**
 * Something landed in this project's inbox. Called from the write paths that can CREATE inbox work
 * (a feedback row filed, a row reopened to pending) and from nowhere else — see the note on
 * self-wakes in api.ts's inbox route.
 *
 * Never throws and never awaits: a doorbell must not be able to fail a write.
 */
export function nudge(projectIdHex: string): void {
  const set = waiters.get(projectIdHex);
  if (!set) return;
  // copied before firing: a waiter re-arms from its own resolve, and mutating the live set mid-loop
  // would either skip one or spin
  const fire = [...set];
  set.clear();
  waiters.delete(projectIdHex);
  for (const f of fire) {
    try { f(); } catch { /* a dead waiter must not stop the others */ }
  }
}

/**
 * Block until this project is nudged or `ms` elapses, whichever is first.
 * Resolves true for a nudge and false for the timeout, so the caller can tell "something changed,
 * go look" from "nothing happened, tick".
 *
 * Always deregisters, on both paths: an armed waiter that outlives its request would keep a closure
 * (and the response it writes to) alive for as long as the server runs.
 */
export function waitForNudge(projectIdHex: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const off = () => {
      const set = waiters.get(projectIdHex);
      if (!set) return;
      set.delete(wake);
      if (set.size === 0) waiters.delete(projectIdHex);
    };
    const wake = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      resolve(false);
    }, ms);
    // unref so an armed waiter can never be the reason this process refuses to exit on shutdown
    timer.unref?.();
    if (!waiters.has(projectIdHex)) waiters.set(projectIdHex, new Set());
    waiters.get(projectIdHex)!.add(wake);
  });
}

/** how many waiters are armed on a project. For tests and for the snapshot route's own diagnostics. */
export function armedCount(projectIdHex: string): number {
  return waiters.get(projectIdHex)?.size ?? 0;
}
