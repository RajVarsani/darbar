// bun run ctxwatch:optout <threadId> [off]   ("off" turns the opt-out back off)
import { initDb, CtxWatch } from '@darbar/core';
const [id, flag] = process.argv.slice(2);
if (!id) { console.error('usage: ctxwatch:optout <threadId> [off]'); process.exit(2); }
await initDb();
await CtxWatch.updateOne({ threadId: id }, { $set: { optOut: flag !== 'off', updatedAt: new Date() }, $setOnInsert: { phase: 'idle' } }, { upsert: true });
console.log(`${id}: opt-out ${flag === 'off' ? 'off' : 'on'}`);
process.exit(0);
