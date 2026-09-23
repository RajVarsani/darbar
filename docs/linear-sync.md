# Linear mirror (DAR-266)

Agents write only to darbar. For a project with `linearUrl` set and not archived, the server mirrors rows to Linear and pulls colleagues' changes back. Code: `apps/server/src/linear.ts` (GraphQL client), `apps/server/src/linear-sync.ts` (the sync and its design notes), tests in `linear-sync.test.ts` (stubbed client).

| Topic | Behaviour |
|---|---|
| Off switch | No `LINEAR_API_KEY` in `.env`: one boot log line (`linear sync off: …`) and every hook does nothing |
| Team | Taken from `linearUrl`: `/team/<KEY>/…` gives the team, `/project/<slug>` gives the Linear project and its single team (new issues are put in that project). Cached on the project as `linearSync`. Setting, changing or clearing `linearUrl` drops it, so the next run starts fresh |
| Label | Child of the `darbar` group (8aee3bbe…) whose Linear name is the project prefix (e.g. `ONB`). Created when missing |
| What gets mirrored | Rows with `type != review` and no parent. Review children and sub-rows are not mirrored. Feedback rows never become issues |
| Outbound | Create makes a labelled issue. Title, description and status are pushed. Notes changes (only the appended text; a rewrite posts the new text once), `addCommit` and feedback promotions (`resolvedTaskRef`) are posted as comments |
| Status map | backlog→backlog, todo→"Todo" (else the first unstarted state that isn't Blocked), in_progress→started state named "…progress…", in_review/qa→started state named "…review…" (else the first started state), blocked→state named "…block…" (left alone if the team has none), done→completed, cancelled→canceled. Inbound reverses it: Blocked→blocked, Review→in_review, other started states→in_progress, duplicate→cancelled, triage→backlog |
| Inbound | Polls in-process every `LINEAR_POLL_MS` (120s) for labelled issues updated since the cursor. The first run backfills every labelled issue |
| Inbound status | Goes through the same transition as `PATCH /tasks/:ref` (`transitionTask` in api.ts). Linear Review spawns the review lanes. Linear Done is refused while review children or feedback are open: the row stays put, `row.linear.held` records what Linear says and why, and Linear is not moved back. A pulled change is written only if the row has not changed since the pass read it |
| Scope guard | The server reads the issue before each update or comment and refuses to write if the issue doesn't carry the project's label (the row records the error). Inbound checks the label on each issue as well as filtering by it |
| Idempotency | The issue and comment UUIDs are stored on the row before the call and sent as the Linear id. A retry looks the id up first and adopts it if it already exists |
| Conflicts | Three-way merge against the last-synced values on each side. A field changed on one side goes to the other side. A field changed on both sides goes to the newer side (`row.updatedAt` vs `issue.updatedAt`) |
| Failure | A darbar write never fails because of Linear. The error goes on `row.linear.error`. The poll retries with backoff (1, 2, 4, 8 min) and gives up after 5 failures (`row.linear.gaveUp`, error kept). A darbar edit to the row always retries |
| Backfill matching | An issue with no linked row links to an unlinked row whose origin is `linear:<ID>` or that carries `mirrored as <ID>` / `linear: <ID>`, or failing that to the single row filed before the project's sync started with the same title (case-insensitive). Ambiguous matches link nothing. Otherwise it becomes a new row (`origin: linear:<ID>`). Unlinked issues wait in `linearSync.pending` and are retried every poll. Rows filed before the project's sync first ran are never pushed out |

Turning it on: create a personal Linear API key, add `LINEAR_API_KEY=<key>` to `~/fafo/darbar/.env`, restart the server, and look for `linear sync on` in the log.
