// DAR-398: open-in-T3 links for board rows.
import fs from 'node:fs';
import { config } from '@darbar/core';

/** http://127.0.0.1:3773/<envId>/<url-encoded threadId>; null when T3's environment id is unreadable */
export function t3LinkFor(threadId: string): string | null {
  try {
    const envId = fs.readFileSync(`${config.t3Home}/userdata/environment-id`, 'utf8').trim();
    return envId ? `${config.t3Origin}/${envId}/${encodeURIComponent(threadId)}` : null;
  } catch {
    return null;
  }
}
