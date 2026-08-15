# Even Spacing — an Art Daily drill

Split by eye, then fill at a steady pitch. Four items per round: cross two
baselines with evenly spaced ticks (3, then 5), then fill two boxes with even
parallel strokes — the last box is tilted ~30° and wants strokes running the way
its dashed guide runs. After every item the ideal shows up in pink next to your
ink, with your offsets / gap sizes labeled in px and a plain-words read of what
went wrong ("your gaps widened as you went").

Scoring is pure geometry (top of `js/game.js`, unit-testable). Round score is
the mean of the four items, reported once via `ArtDaily.report`.

**Every tolerance is the larger of two numbers**: the drill's own standard,
relative to the gap it is judging, and what a hand on this hardware can
physically hit, in absolute pixels — the second is what `ArtDaily.ease()`
scales. What this drill mostly grades is *placement*, and a mouse places as well
as a pen; what a phone's fingertip cannot do is hit a 14px band. Concretely:

```
ticks  free = max(4%  of a gap, 3 px)
       zero = max(40% of a gap, ease × 16 px)
fill   parallelism zero at ease × 14° RMS   (the one motor term — eased outright)
       rhythm      zero at max(42% of the mean gap, ease × 5 px) of gap stdev
```

On a phone the 5-tick item used to zero at **14 px** of mean placement error —
under a fingertip 30–45 px wide — while the desktop got 20.6 px on the same item.
That item now zeroes at 24 px for a finger, and a 10 px-error attempt went from
**30** to **72**.

**The box scales too.** 8–12 strokes across a 206 px phone box is 17 px gaps and
a 2.2 px standard-deviation requirement — the player literally cannot see where
the last stroke went. Under 460 px the box is wider (0.40 W × 0.30 H), the sheet
is taller, and the drill asks for 5–7 strokes, keeping the gaps wider than the
finger placing them.

**Nothing commits itself.** The ticks items used to score the instant the n-th
tick landed, so a bad third tick was locked in — with `undo` sitting right there,
unreachable at the only moment it mattered. Both item types now wait for
**done ✓**, and `undo ↩` works on the last tick.

**Marks that do not count say so.** A stroke under 30 px used to vanish in
silence and then leave a wrong gap in the score, which is exactly the "this feels
unfair" failure; a press with no pull did the same on the ticks items. Both now
explain themselves. The proximity rule for a tick is `ArtDaily.startRadius(44)`,
widest for a screenless tablet, whose hand is out of sight when it lands.

**First win**: after the very first tick of your very first round, the drill
flashes the perfectly even positions for about a second — the one thing the page
never showed, shown once.

**Also fixed**: a pen pointer outranks a palm that landed first; `pointercancel`
and `lostpointercapture` are handled wherever `pointerup` is; coalesced pointer
events keep a fast stroke intact (the direction fit is only as good as the
samples that survive); and the stylesheet suppresses the iOS long-press callout
over the canvas, double-tap zoom on the controls, and pull-to-refresh.

Part of [artdaily.sadeali.com](https://artdaily.sadeali.com/) — zero build,
plain files, no trackers. `js/artdaily-sdk.js` is vendored and never edited.
