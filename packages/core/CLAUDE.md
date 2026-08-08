# @darbar/core

Shared foundation: `config.ts` (ALL runtime values, driven by root .env — no
defaults elsewhere), `db.ts` (Mongo client, typed collections, indexes, capId +
atomic shortId counters), `types.ts` (Project/Task/FeedbackDoc/EventDoc + status
unions). Schema changes start here; keep collections typed — untyped `any` docs is
how operator-injection bugs stayed invisible pre-review. New indexes go in initDb.
