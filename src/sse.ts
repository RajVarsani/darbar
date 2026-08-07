// SSE subscriber registry, keyed by project capId ('*' = all projects)
type Sub = { send: (data: string) => void };

const subs = new Map<string, Set<Sub>>();

export function subscribe(key: string, sub: Sub): () => void {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key)!.add(sub);
  return () => {
    const set = subs.get(key);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) subs.delete(key);
  };
}

export function emit(capIdOrStar: string, event: { kind: string; [k: string]: unknown }) {
  const payload = JSON.stringify(event);
  for (const key of [capIdOrStar, '*']) {
    const set = subs.get(key);
    if (!set) continue;
    for (const sub of set) {
      try {
        sub.send(payload);
      } catch {
        set.delete(sub);
      }
    }
    if (set.size === 0) subs.delete(key);
  }
}
