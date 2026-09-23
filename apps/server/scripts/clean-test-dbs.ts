// One-off (and reusable) cleanup for darbar_test_<pid> databases left behind by `bun test` runs
// from before apps/server/src/test-harness.ts's teardown() actually dropped its scratch db on
// every afterAll (DAR-298). Safe to run any time the harness is not mid-run: it only ever touches
// names matching /^darbar_test_/, asserted below, and never mission_control, area51, mars,
// mercury, jupiter_db_v4, admin, config or local — those are excluded by the pattern itself, not
// by a denylist, so a typo'd new db name can't slip through as a false match.
//
// Usage (from repo root): bun run clean-test-dbs          # lists what it would drop
//                          bun run clean-test-dbs -- --yes # actually drops
// (or `cd apps/server && bun scripts/clean-test-dbs.ts [--yes]` directly)
//
// Lives under apps/server, not the repo root: it's the one workspace member that already has
// @darbar/core as a real dependency, and pulling MongoClient off @darbar/core's own `db` export
// (rather than importing the `mongodb` package directly, which is only a packages/core
// dependency, not this script's) means no new dependency anywhere for a one-off. `db.client` is
// the real driver Client the Db instance carries at runtime (undocumented in @darbar/core's own
// exports, but the same trick apps/server/src/test-harness.ts already relies on).
import { db, config } from '@darbar/core';

type AnyDb = { admin(): { listDatabases(): Promise<{ databases: { name: string }[] }> }; dropDatabase(): Promise<unknown> };
type AnyClient = { db(name: string): AnyDb; close(): Promise<unknown> };
const client = (db as unknown as { client: AnyClient }).client;
const MONGO_URI = process.env.MONGO_URI ?? config.mongoUri;
const PATTERN = /^darbar_test_/;
const PROTECTED = new Set(['mission_control', 'area51', 'mars', 'mercury', 'jupiter_db_v4', 'admin', 'config', 'local']);

try {
  const { databases } = await client.db('admin').admin().listDatabases();
  const names = databases.map((d) => d.name);
  const targets = names.filter((n) => PATTERN.test(n));

  for (const n of targets) {
    if (PROTECTED.has(n)) throw new Error(`refusing: ${n} matched the drop pattern but is protected`);
    if (!PATTERN.test(n)) throw new Error(`refusing: ${n} does not match /^darbar_test_/`);
  }

  console.log(`MONGO_URI: ${MONGO_URI}`);
  console.log(`${targets.length} database(s) match /^darbar_test_/:`);
  for (const n of targets) console.log(`  ${n}`);

  if (!process.argv.includes('--yes')) {
    console.log('\nDry run only — pass --yes to actually drop these.');
  } else {
    for (const n of targets) {
      await client.db(n).dropDatabase();
      console.log(`dropped ${n}`);
    }
    console.log(`\ndropped ${targets.length} database(s).`);
  }
} finally {
  await client.close();
}
