# Darbar Buddy

A desktop pet that is also the Darbar board. It floats always-on-top in a corner, bobs and blinks,
and hangs a two-level board off its head when you ask for one.

```bash
./scripts/build-app.sh --run     # builds dist/Darbar Buddy.app and launches it
```

No dock icon (LSUIElement). Drag the pet anywhere; position and chosen avatar persist. Quit from
the ✕ in the hover pill or the menu bar item.

## Where it came from

Two parents, both of which were told to be carried over rather than rewritten.

**`~/all-things-saturn/coplanner-buddy`** is the pet. It is 542MB on disk, and almost none of that
is the app: 511MB is `.build`, 22MB is `dist`, and the sources are 9.3MB. What crossed:

| Came across | Why |
|---|---|
| `Components.swift`, `CoPlannerLogo.swift`, `AvatarsA/B.swift` | the eight vector avatars and the shared face/blink/bob vocabulary. Pure SwiftUI paths, zero bytes of art on disk |
| `RootView.swift` | pet, hover pill, avatar picker |
| the NSPanel host and the `build-app.sh` recipe | borderless non-activating floating panel, hand-assembled bundle, ad-hoc signature |
| the vector art QA loop (`--avatars`, `--filmstrip`, `--gif`) | the loop for the art that came across |

What stayed behind, and why:

- **`.build` (511MB) and `dist` (22MB)** are build products. `swift build` and `build-app.sh`
  reproduce both.
- **`make-dmg.sh`** is the ship-to-colleagues path. This copy is not shipped to anyone.
- **Stache** — `AvatarsC.swift`, `StacheBodies.swift`, and `Resources/` — is a photographic cutout
  of a colleague plus a 120-frame flipbook of him laughing and the audio track to go with it. It is
  9.1MB of the 9.3MB of art, it is the only thing in the package that needs a resource bundle, and
  it is a real person's likeness made for one app and one team. Leaving it behind took the repo cost
  to zero binary assets and the app back to a single executable.
- **The Vision art pipeline** — `--cutout`, `--head`, `--videoframes`, `--headframes`, `--toon`,
  `--measure`, `--bodies` — existed only to produce Stache. With no subject left it went too, and
  with it the `AVFoundation` and `Vision` imports.

Net: ~50KB of Swift, no resources, no package dependencies, nothing fetched at build time.

**`apps/notch`** is the board. `Board/Model.swift`, `Board/Age.swift` and `Board/Feed.swift` are
byte-for-byte that app's files; `Board/BoardView.swift` is its `NotchView.swift` with the host-shaped
parts changed. The honesty work is the reason and it is unchanged:

- `ageShort` / `relTime` / the 15-minute dispatch threshold are ports of `apps/server/web/board.html`,
  not reimplementations, so the two surfaces cannot become second opinions about whether a builder
  is alive.
- A `DISPATCHED` badge is never drawn without its age, and goes red past 15 minutes.
- On a failed poll the old snapshot stays but `lastSyncedAt` does not move, so the card dims, the
  dot goes red, and a banner says what darbar last said and when.
- Paging follows `nextOffset` until `truncated` is false, and says "read N of M" if it stops early.

## The surface

**Projects is home.** There is no global running list; running work is reached through a project,
because a running row means nothing without knowing whose board it is on. The one thing the old
Running tab answered that a project list does not — is anything on fire anywhere — is the header
chip, and trouble wins it: an overdue dispatch outranks a running count.

**The distribution per project changes resolution, not chart.** While the tasks are countable
(n ≤ 12) it draws one pip per task, coloured by state, so at n=4 you read it exactly: three green,
one red, no estimation and no legend. Above 12 the pips fuse into one proportional bar, because
proportion is the only thing left worth showing. Same colours, same slot, same width, same
left-to-right urgency order, so it never reads as two widgets. A ring was asked for and is the wrong
instrument: at n=3 every slice of a donut is 120° and the eye reads "a third" when the fact is "one
task".

**Hover a project row** reveals two actions in a slot that is reserved whether they are showing or
not, so hover reveals and never shoves: open the board in a browser, or drill in here. The browser
link is the loopback board, not the `boardUrl` on the payload, because that one is built from
`BASE_URL` and dies whenever the tunnel is down; the payload URL is the fallback.

**No layout jump between levels.** One width, one header height, and one fixed body height that both
levels reserve (`Metrics.bodyH`, computed from the caps so it cannot silently start clipping). The
header stays put and demotes the wordmark to a breadcrumb crumb, so "where am I" is answered by
weight and colour rather than by the row moving.

**The reveal** is the pet's own gesture, not a third pattern. The pet already had two ways of showing
more of itself — the hover pill, and the avatar picker in its own window — and the card is the
second of those: a separate panel, child window of the pet's, anchored at the pet's head with a tail
pointing at it. It pours up out of the head over a spring with one soft overshoot (response 0.42,
damping 0.72), settles, and only then do the rows arrive one behind the next, 32ms apart. The pet
hops as it opens. Closing is faster and critically damped, because an exit that bounces looks
indecisive.

**Escape is a bonus, not the affordance.** The panel asks for key focus and never activates the app,
so it cannot steal typing — and for the same reason it does not reliably receive keystrokes. Checked
live: with the app inactive the card opens with `isKeyWindow` false. Every level therefore has a
visible way out (the back button, a click anywhere else, the pill button that opened it) and the back
button says "back" rather than "esc".

**The resting pill** under the pet's feet is the notch's compact slots relocated. Same constraint —
too small to caption anything — so the same rule: never a bare count of dispatches, because a count
with no age is the stale-claim problem in miniature. It only appears when there is something to say.

## Dev loop

```bash
swift build

# board and pet, rendered to PNG against LIVE data
.build/debug/DarbarBuddy --board /tmp/buddy
DARBAR_STALE_AFTER=0 .build/debug/DarbarBuddy --board /tmp/buddy-stale   # the stale treatment

# the avatar art loop, inherited
.build/debug/DarbarBuddy --avatars /tmp/avatars
.build/debug/DarbarBuddy --gif /tmp/orbie.gif 0 4 15 orbie
```

`--reveal` launches the real app and opens the board once, ~1.2s in, then prints the live window
geometry to stderr. It is a one-shot for photographing and checking the real panel. It is
deliberately not a demo loop.

- `Sources/DarbarBuddy/Catalog.swift` — the cast and the persisted app state
- `Sources/DarbarBuddy/RootView.swift` — pet, hover pill, picker, resting status pill
- `Sources/DarbarBuddy/Board/BoardView.swift` — the card, both levels, the strip
- `Sources/DarbarBuddy/Board/BoardPanel.swift` — the second window, its placement and its reveal
- `Sources/DarbarBuddy/main.swift` — NSPanel setup, menu bar item, offline render modes

## Config

No port is hardcoded. `build-app.sh` reads `PORT` out of the repo `.env` and stamps the resolved
base into `Info.plist`; `DARBAR_API` in the environment overrides it at runtime.

The bundle identifier is `com.rajvarsani.darbar-buddy`, deliberately not
`com.heysaturn.coplanner-buddy`. A shared identifier would mean one preferences domain (the two pets
fighting over avatar, size and window position), one Launch Services registration and one login
item. Different id, different name, different frame autosave key: they install side by side.
