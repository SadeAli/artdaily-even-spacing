# Even Spacing — an Art Daily drill

Split by eye, hatch to a beat. Four items per round: cross two
baselines with evenly spaced ticks (3, then 5 — undo takes back a
misplaced one), then fill two boxes with 8–12 even parallel hatch
strokes — the last box is tilted ~30° and wants hatching parallel to
its short edge. After every item the ideal shows up in pink next to
your ink, with your offsets / gap sizes labeled in px.

Scoring is pure geometry (top of `js/game.js`, unit-testable): ticks
score the mean offset from the ideal i/(N+1) split in gap units;
hatching scores 35% parallelism (angular spread of stroke directions)
and 65% rhythm (coefficient of variation of the gaps). Round score is
the mean of the four items, reported once via `ArtDaily.report`.

Part of [artdaily.sadeali.com](https://artdaily.sadeali.com/) — zero
build, plain files, no trackers. `js/artdaily-sdk.js` is vendored and
never edited.
