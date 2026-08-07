// SSE subscriber registry, keyed by project capId ('*' = all projects)
type Sub = { send: (data: string) => void; close: () => void };

const subs = new Map<string, Set<Sub>>();

export function subscribe(key: string, sub: Sub): () => void {
  if (!subs.has(key)) subs.set(key, new Set());
  subs.get(key)!.add(sub);
  return () => subs.get(key)?.delete(sub);
}

export function emit(capIdOrStar: string, event: { kind: string; [k: string]: unknown }) {
  const payload = JSON.stringify(event);
  for (const key of [capIdOrStar, '*']) {
    for (const sub of subs.get(key) ?? []) {
      try {
        sub.send(payload);
      } catch {
        subs.get(key)?.delete(sub);
      }
    }
  }
}
