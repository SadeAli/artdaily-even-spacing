/* ============================================================
   game.js — Even Spacing: the divide-and-fill drill. Four items
   per round: two baselines to split with evenly spaced ticks
   (3, then 5), then two rectangles to fill with even parallel
   strokes — the last box tilted ~30° and filled parallel to its
   short edge. Scoring is pure interval geometry; the functions at
   the top take plain arrays and return 0–100 (no canvas, no DOM)
   so they are unit-testable as-is.

   Hardware fairness (protocol v1 input profile):
     · every tolerance is the LARGER of the drill's own standard
       (relative to the gap it is judging) and what a hand on this
       hardware can physically hit (absolute px, ArtDaily.ease()d).
       A phone's 5-tick item used to demand 14px placement accuracy
       from a fingertip wider than the error band;
     · the box and the number of strokes asked for scale with the
       canvas, so a phone is never asked for 12 strokes at 17px apart;
     · nothing is ever committed without the player pressing done, so
       a mark placed under an occluding finger can still be undone.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'even-spacing';
  var ITEMS_PER_ROUND = 4;
  var TICK_MIN_PATH = 8;     /* px of drawn path — shorter is a stray tap */
  var TICK_NEAR_BASE = 44;   /* how close a tick must pass to the baseline */
  var HATCH_MIN_PATH = 30;   /* px — shorter strokes cannot be read as fills */
  var REVEAL_TICKS_MS = 1800;
  var REVEAL_HATCH_MS = 2400;
  var TEACH_MS = 1200;       /* the one-time "this is what evenly means" flash */
  var PEN_LOCKOUT_MS = 700;

  /* Tick placement band, in pixels of mean error. It used to be a pure
     fraction of one gap: on a 213px phone baseline the 5-tick item asked
     for 14px accuracy under a 30–45px fingertip, while the desktop got
     20.6px on the same item and 31px on the 3-tick one. */
  var TICK_REL_FREE = 0.04, TICK_FREE_FLOOR_PX = 3;
  var TICK_REL_ZERO = 0.40, TICK_ZERO_FLOOR_PX = 16;
  /* Fill quality: angular spread of the stroke directions, and the
     evenness of the gaps between them. Parallelism is the one genuinely
     MOTOR term in the drill — holding a straight repeated drag is what a
     mouse is worst at — so it is eased outright. Rhythm is placement, so
     it takes the larger-of-two treatment. */
  var PARALLEL_ZERO_DEG = 14;
  var RHYTHM_REL_ZERO = 0.42, RHYTHM_FLOOR_PX = 5;
  /* The tilted box is the one item that asks for a DIRECTION in words
     ("running the way the dashed guide runs"), so it is the one item where
     direction is scored. The free zone is eased — holding an eyeballed axis
     is motor work — and the falloff is not. */
  var TILT_FREE_DEG = 7, TILT_ZERO_DEG = 55;
  /* A fill has to cross the box. An evenly spaced k-stroke fill spans
     (k−1)/k of it, so full marks land well before edge-to-edge: this is a
     floor against a scribble crammed into one band, not a demand. */
  var FILL_SPAN_FRAC = 1.2;   /* × the box's half-extent = full marks */

  /* ============================================================
     Pure scoring + geometry — arrays in, numbers out. No DOM.
     `ease` is the multiplier from ArtDaily.ease(1): 1 pen, 2
     mouse/trackpad, 1.5 finger.
     ============================================================ */
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function mean(a) {
    var s = 0, i;
    for (i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : 0;
  }

  function stdev(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0, i, d;
    for (i = 0; i < a.length; i++) { d = a[i] - m; s += d * d; }
    return Math.sqrt(s / a.length);
  }

  function pathLength(pts) {
    var s = 0, i;
    for (i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return s;
  }

  function centroid(pts) {
    var x = 0, y = 0, i;
    for (i = 0; i < pts.length; i++) { x += pts[i].x; y += pts[i].y; }
    return pts.length ? { x: x / pts.length, y: y / pts.length } : { x: 0, y: 0 };
  }

  /* --- ticks: split a segment at i/(N+1) --- */
  function idealFractions(n) {
    var out = [], i;
    for (i = 1; i <= n; i++) out.push(i / (n + 1));
    return out;
  }

  /* Mean |actual − ideal| in PIXELS along the baseline; actual fractions
     are sorted and paired with the sorted ideals, so tick order never
     matters. Returns Infinity when there are not enough ticks to judge. */
  function tickErrorPx(fracs, n, segLen) {
    if (!n || fracs.length < n || !(segLen > 0)) return Infinity;
    var sorted = fracs.slice().sort(function (x, y) { return x - y; });
    var ideal = idealFractions(n);
    var s = 0, i;
    for (i = 0; i < n; i++) s += Math.abs(sorted[i] - ideal[i]) * segLen;
    return s / n;
  }

  function tickTolerancePx(n, segLen, ease) {
    var e = ease > 0 ? ease : 1;
    var gap = (n > 0 && segLen > 0) ? segLen / (n + 1) : 0;
    return {
      free: Math.max(TICK_REL_FREE * gap, TICK_FREE_FLOOR_PX),
      zero: Math.max(TICK_REL_ZERO * gap, e * TICK_ZERO_FLOOR_PX),
    };
  }

  function tickScore(fracs, n, segLen, ease) {
    var err = tickErrorPx(fracs, n, segLen);
    if (!isFinite(err)) return 0;
    var t = tickTolerancePx(n, segLen, ease);
    if (t.zero <= t.free) return err <= t.free ? 100 : 0;
    return 100 * clamp01(1 - (err - t.free) / (t.zero - t.free));
  }

  /* Per-tick signed offsets (px toward B) for the reveal. */
  function tickOffsets(fracs, n, segLen) {
    var sorted = fracs.slice().sort(function (x, y) { return x - y; });
    var out = [], i, ideal;
    for (i = 0; i < n && i < sorted.length; i++) {
      ideal = (i + 1) / (n + 1);
      out.push({ ideal: ideal, deltaPx: (sorted[i] - ideal) * segLen });
    }
    return out;
  }

  /* The n+1 gaps the ticks actually made, in px, END GAPS INCLUDED —
     A-to-first and last-to-B are gaps the player chose too, and leaving
     them out is how "even" quietly stops meaning even. */
  function tickGaps(fracs, n, segLen) {
    if (!n || fracs.length < n || !(segLen > 0)) return [];
    var sorted = fracs.slice().sort(function (x, y) { return x - y; });
    var out = [], i, prev = 0;
    for (i = 0; i < n; i++) { out.push((sorted[i] - prev) * segLen); prev = sorted[i]; }
    out.push((1 - prev) * segLen);
    return out;
  }

  /* The gaps re-ordered the way the player WORKED. tickGaps walks the
     baseline from dot A to dot B, which is a fixed direction on the page
     and has nothing to do with the hand: a player who ticks from B back
     toward A widening as they go would be told they tightened. `fracs` is
     in placement order, so its own ends say which way they travelled. */
  function gapsInDrawnOrder(gaps, fracs) {
    if (!gaps || gaps.length < 2 || !fracs || fracs.length < 2) return gaps || [];
    return fracs[fracs.length - 1] < fracs[0] ? gaps.slice().reverse() : gaps;
  }

  /* What shape a run of gaps has, once `tol` px of slop is allowed:
     'even' | 'widened' | 'tightened' | 'endsTight' | 'endsWide' | 'jumpy'.

     "widened as you went" is a claim about a TREND, so every step is
     checked, not just the ends: 40, 150, 20, 190 ends far wider than it
     starts and is nothing like a widening rhythm — it is gaps jumping
     about. BOTH item families run through this one function, because
     they used to disagree: the tick items called that exact gap list
     "jumped about" and the fill items called it "widened as you went",
     in the same drill, on the same numbers. */
  function gapTrend(gaps, tol) {
    if (!gaps || gaps.length < 2) return 'even';
    var sd = stdev(gaps);
    if (!isFinite(sd)) return 'even';
    if (sd <= tol) return 'even';
    var up = true, down = true, i, step;
    for (i = 1; i < gaps.length; i++) {
      step = gaps[i] - gaps[i - 1];
      if (!isFinite(step)) return 'jumpy';
      if (step < -tol) up = false;
      if (step > tol) down = false;
    }
    var drift = gaps[gaps.length - 1] - gaps[0];
    if (up && drift > 2 * tol) return 'widened';
    if (down && drift < -2 * tol) return 'tightened';
    /* The middle held one size and the two OUTSIDE gaps did not — the single
       commonest way a beginner splits a line wrong, and on the tick items it
       is the shape the drill's own end-gap-inclusive design exists to catch:
       you eyeball the interior rhythm correctly and misjudge how far the
       first and last marks should sit from the ends.

       It had no name, so it fell into 'jumpy' — measured on known-shape
       inputs, 72–82% of the time — and 'your gaps jumped about instead of
       holding one size' is both untrue of it and no use. Measured on the
       shipped tick scorer, that catch-all was 76% of all attempts and it
       printed under scores as high as 100: a sentence calling the player
       chaotic beside a number calling them perfect.

       Guarded so it can only ever take cases the tests above have already
       declined: a real trend returns before this, and the interior must be
       consistent (stdev within the same slop) or this is just noise being
       relabelled. Needs an interior to average, hence length >= 4 — every
       tick item has n+1 >= 4 gaps and every fill has at least min−1. */
    if (gaps.length >= 4) {
      var inner = gaps.slice(1, gaps.length - 1);
      var edge = (gaps[0] + gaps[gaps.length - 1]) / 2;
      var mid = mean(inner);
      if (isFinite(edge) && isFinite(mid) && stdev(inner) <= tol) {
        if (mid - edge > 2 * tol) return 'endsTight';
        if (edge - mid > 2 * tol) return 'endsWide';
      }
    }
    return 'jumpy';
  }

  function trendSentence(t) {
    if (t === 'widened') return 'your gaps widened as you went';
    if (t === 'tightened') return 'your gaps tightened as you went';
    /* names the half that WORKED as well as the half that did not — the
       player who hears only "wrong" has nothing to keep doing */
    if (t === 'endsTight') return 'your middle gaps held one size — the two outside ones came up short';
    if (t === 'endsWide') return 'your middle gaps held one size — the two outside ones ran wide';
    if (t === 'jumpy') return 'your gaps jumped about instead of holding one size';
    return 'your gaps were even';
  }

  /* The same delta the pink ticks show, in words. The tick items shipped a
     score and a row of ±px numbers and left the player to spot the pattern
     themselves.

     `errPx` and `tol` are the very numbers tickScore is computed from, so the
     sentence cannot contradict the number printed beside it. tickScore maps
     errPx linearly from tol.free (100) to tol.zero (0), so "errPx within a
     fifth of the band" IS the statement "80 or better" — the same contract
     fillWords already keeps on the fill half of this drill.

     Gating on the free zone alone (i.e. only a literal 100) was the bug:
     measured over 40,000 simulated rounds against the shipped scorer, 10,658
     attempts scoring 90 or better were handed "your gaps jumped about instead
     of holding one size". A number calling the player near-perfect beside a
     sentence calling them chaotic teaches nothing except not to read one of
     the two. The per-tick ±px bars on the canvas still carry every bit of the
     detail this sentence rounds off. */
  function tickWords(gaps, ease, errPx, tol) {
    if (!gaps || gaps.length < 2) return '';
    var e = ease > 0 ? ease : 1;
    var m = mean(gaps);
    if (!isFinite(m) || !isFinite(stdev(gaps))) return '';
    if (tol && isFinite(errPx) && isFinite(tol.free)) {
      var band = (isFinite(tol.zero) && tol.zero > tol.free) ? tol.zero - tol.free : 0;
      if (errPx <= tol.free + 0.2 * band) return 'your gaps were even';
    }
    return trendSentence(gapTrend(gaps, Math.max(0.06 * m, e * 3)));
  }

  /* The fill's delta in words, read off the same gap list the rhythm score
     is computed from. Worst thing first, and it always says SOMETHING: a
     fill whose gaps held one size used to get the numbers and silence,
     which leaves the player guessing which half of the score was the good
     half. */
  function fillWords(ev, ease) {
    if (!ev) return '';
    var e = ease > 0 ? ease : 1;
    /* No daylight between the strokes: they were redrawn on top of one
       another, which is one mark, not a fill. That earns a flat 0 — and it
       used to be explained as "your gaps jumped about", which describes a
       fill the player did not draw. */
    if (!ev.spread) return 'your strokes landed on top of each other — a fill needs daylight between them';
    var gaps = ev.gaps || [];
    if (gaps.length < 2) return '';
    var m = mean(gaps);
    if (!isFinite(m)) return '';
    /* The slop the words allow is a fifth of the very band the rhythm
       score dies at, so "your gaps held one size" is exactly the
       statement "rhythm 80 or better" and the sentence can never
       contradict the number printed beside it. A flat fraction of the
       mean gap instead let a tight fill — mean gap near the hand's own
       slop, where the pixel floor rules — be called even at rhythm 40. */
    var t = gapTrend(gaps, 0.2 * Math.max(RHYTHM_REL_ZERO * m, e * RHYTHM_FLOOR_PX));
    return t === 'even' ? 'your gaps held one size' : trendSentence(t);
  }

  /* --- segment geometry shared by tick registration --- */
  /* Fraction along a→b where segment p1→p2 crosses it, else null. */
  function segCrossT(p1, p2, a, b) {
    var d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    var d2x = b.x - a.x, d2y = b.y - a.y;
    var denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    var wx = a.x - p1.x, wy = a.y - p1.y;
    var s = (wx * d2y - wy * d2x) / denom;
    var u = (wx * d1y - wy * d1x) / denom;
    return (s >= 0 && s <= 1 && u >= 0 && u <= 1) ? u : null;
  }

  /* Clamped projection of p onto segment a→b: { t, dist }. */
  function projectOnSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return { t: 0, dist: Math.hypot(p.x - a.x, p.y - a.y) };
    var t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2);
    return { t: t, dist: Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) };
  }

  /* Where a drawn stroke marks the baseline: its crossing point, or —
     forgiving — the nearest-point projection if it never quite crosses.
     Returns { t, near } (near = 0 for a true crossing). */
  function strokeCrossing(pts, a, b) {
    var i, u;
    for (i = 1; i < pts.length; i++) {
      u = segCrossT(pts[i - 1], pts[i], a, b);
      if (u !== null) return { t: u, near: 0 };
    }
    var best = null, bd = Infinity, pr;
    for (i = 0; i < pts.length; i++) {
      pr = projectOnSegment(pts[i], a, b);
      if (pr.dist < bd) { bd = pr.dist; best = pr; }
    }
    return best ? { t: best.t, near: bd } : null;
  }

  /* --- fills: parallelism + rhythm --- */
  /* Least-squares (PCA) direction of a point cloud, as a unit vector. */
  function fitDirection(pts) {
    var n = pts.length, i, mx = 0, my = 0;
    for (i = 0; i < n; i++) { mx += pts[i].x; my += pts[i].y; }
    mx /= n; my /= n;
    var sxx = 0, sxy = 0, syy = 0, dx, dy;
    for (i = 0; i < n; i++) {
      dx = pts[i].x - mx; dy = pts[i].y - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    var a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  /* Axial (180°-symmetric) mean angle + RMS spread in degrees. */
  function axialStats(dirs) {
    var C = 0, S = 0, i, a2, d;
    for (i = 0; i < dirs.length; i++) {
      a2 = 2 * Math.atan2(dirs[i].y, dirs[i].x);
      C += Math.cos(a2); S += Math.sin(a2);
    }
    var meanAng = 0.5 * Math.atan2(S, C);
    var ss = 0;
    for (i = 0; i < dirs.length; i++) {
      d = Math.atan2(dirs[i].y, dirs[i].x) - meanAng;
      while (d > Math.PI / 2) d -= Math.PI;
      while (d < -Math.PI / 2) d += Math.PI;
      ss += d * d;
    }
    var stdDeg = dirs.length ? Math.sqrt(ss / dirs.length) * 180 / Math.PI : 0;
    return { meanAng: meanAng, stdDeg: stdDeg };
  }

  /* Full fill evaluation. parallelism: angular spread of the stroke
     directions (eased — this is the motor term). rhythm: how far the
     gaps between stroke midpoints wander from their own average, in
     pixels, against the larger of 42% of that average and the hand's
     own slop. Score leans on rhythm — this is a spacing drill. */
  function hatchEval(strokes, ease) {
    var e = ease > 0 ? ease : 1;
    var dirs = [], mids = [], i;
    for (i = 0; i < strokes.length; i++) {
      if (strokes[i].length < 2) continue;
      dirs.push(fitDirection(strokes[i]));
      mids.push(centroid(strokes[i]));
    }
    var ax = axialStats(dirs);
    var parallelism = dirs.length ? 100 * clamp01(1 - ax.stdDeg / (e * PARALLEL_ZERO_DEG)) : 0;
    var px = -Math.sin(ax.meanAng), py = Math.cos(ax.meanAng);
    /* Point the spacing axis the way the player WORKED, first stroke to
       last. Its raw direction comes out of an atan2 on a doubled angle, so
       a fill two degrees off vertical flips it: the very same widening fill
       was told "your gaps widened as you went" or "…tightened as you went"
       depending on a wobble nobody could see. Orientation cannot touch a
       score — the gaps are sorted, so they stay positive and their mean and
       spread are identical either way — it only decides which end of the
       fill the sentence calls the start. */
    if (mids.length > 1) {
      var d0 = (mids[mids.length - 1].x - mids[0].x) * px +
        (mids[mids.length - 1].y - mids[0].y) * py;
      if (d0 < 0) { px = -px; py = -py; }
    }
    var ts = [], order = [];
    for (i = 0; i < mids.length; i++) {
      ts.push(mids[i].x * px + mids[i].y * py);
      order.push(i);
    }
    order.sort(function (x, y) { return ts[x] - ts[y]; });
    var gaps = [];
    for (i = 1; i < order.length; i++) gaps.push(ts[order[i]] - ts[order[i - 1]]);
    var m = mean(gaps);
    var sd = stdev(gaps);
    /* strokes redrawn on top of one another are one mark, not a fill —
       "perfectly parallel" is meaningless there, so it earns nothing */
    var spread = gaps.length > 0 && m > e * RHYTHM_FLOOR_PX;
    if (!spread) parallelism = 0;
    var zeroSd = Math.max(RHYTHM_REL_ZERO * m, e * RHYTHM_FLOOR_PX);
    var rhythm = (spread && zeroSd > 0) ? 100 * clamp01(1 - sd / zeroSd) : 0;
    var score = 0.35 * parallelism + 0.65 * rhythm;
    return {
      score: isFinite(score) ? score : 0,
      parallelism: isFinite(parallelism) ? parallelism : 0,
      rhythm: isFinite(rhythm) ? rhythm : 0,
      meanAng: ax.meanAng,
      mids: mids,
      order: order,
      gaps: gaps,
      stdDeg: ax.stdDeg,
      /* reported so the words can name the one failure the numbers cannot:
         strokes with no daylight between them are one mark, not a fill */
      spread: spread,
      drift: gaps.length > 1 ? gaps[gaps.length - 1] - gaps[0] : 0
    };
  }

  /* Does the fill answer the item it was asked for?
     hatchEval only ever sees the strokes, so on its own it grades a fill
     drawn in the far corner of the sheet, or run across the tilted box
     instead of along its guide, exactly as highly as the obedient one —
     the drill knows the answer (the reveal draws it) and never scored
     against it. Three 0–1 multipliers, all pure geometry:
       inBox   share of stroke midpoints that landed in the box, with a
               generous margin: an honest stroke overshoots the edges;
       spread  how far across the box the fill actually reaches, so nine
               strokes packed into a 50px band is not a filled box;
       aligned tilted box only: how close the fill's own axis is to the
               box's short-edge axis, measured axially — a fill is the
               same fill drawn either way along its direction.
     Ease widens the angular free zone and nothing else: where the box is
     is not a question of how steady the hand is. */
  function fillFit(ev, box, ease) {
    var e = ease > 0 ? ease : 1;
    var mids = (ev && ev.mids) || [];
    var out = { inBox: 1, spread: 1, aligned: 1, offDeg: 0, factor: 1 };
    if (!box || !mids.length) return out;
    var u = { x: Math.cos(box.ang), y: Math.sin(box.ang) };
    var v = { x: -Math.sin(box.ang), y: Math.cos(box.ang) };
    var slackU = Math.max(0.15 * box.hw, 12), slackV = Math.max(0.15 * box.hh, 12);
    var n = 0, i, dx, dy;
    for (i = 0; i < mids.length; i++) {
      dx = mids[i].x - box.cx; dy = mids[i].y - box.cy;
      if (Math.abs(dx * u.x + dy * u.y) <= box.hw + slackU &&
          Math.abs(dx * v.x + dy * v.y) <= box.hh + slackV) n += 1;
    }
    out.inBox = n / mids.length;

    /* the fill's own spacing axis, and the box's half-extent along it */
    var px = -Math.sin(ev.meanAng), py = Math.cos(ev.meanAng);
    var extent = Math.abs(u.x * px + u.y * py) * box.hw +
      Math.abs(v.x * px + v.y * py) * box.hh;
    var span = 0, gaps = ev.gaps || [];
    for (i = 0; i < gaps.length; i++) span += gaps[i];
    out.spread = extent > 0 ? clamp01(span / (FILL_SPAN_FRAC * extent)) : 1;

    if (box.rotated) {
      var d = Math.atan2(v.y, v.x) - ev.meanAng;
      while (d > Math.PI / 2) d -= Math.PI;
      while (d < -Math.PI / 2) d += Math.PI;
      out.offDeg = Math.abs(d) * 180 / Math.PI;
      out.aligned = clamp01(1 - Math.max(0, out.offDeg - e * TILT_FREE_DEG) / TILT_ZERO_DEG);
    }
    var f = out.inBox * out.spread * out.aligned;
    out.factor = isFinite(f) ? clamp01(f) : 0;
    return out;
  }

  function roundScore(scores) {
    var v = mean(scores);
    return isFinite(v) ? v : 0;
  }

  /* ============================================================
     Canvas / DOM from here down.
     ============================================================ */
  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnUndo = document.getElementById('btnUndo');
  var btnDone = document.getElementById('btnDone');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    return {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      /* --canvas-accent: AA-safe pink for marks on paper (style.css, below
         the game marker); falls back to the plain accent. */
      accent: cs.getPropertyValue('--canvas-accent').trim() ||
        cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--bubblegum').trim()
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * (W < 520 ? 0.78 : 0.62));
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function narrow() { return W < 460; }
  function easeFactor() { return ArtDaily.ease(1); }
  /* how close a tick has to pass to count — the SDK widens it most for a
     screenless tablet, whose hand is out of sight when it lands */
  function tickNear() { return ArtDaily.startRadius(TICK_NEAR_BASE); }
  /* the ask scales with the sheet: 8–12 strokes across a 206px phone box
     is 17px gaps, narrower than the finger placing them */
  function fillAsk() { return narrow() ? { lo: 5, hi: 7, min: 4 } : { lo: 8, hi: 12, min: 6 }; }

  /* ---- round state ---- */
  var round = 0, itemIdx = 0, itemScores = [], item = null, playing = false;
  var ticks = [], hatchStrokes = [];
  var drawing = false, stroke = [], activePid = null, activeType = null;
  var lastPenAt = -1e9;
  var revealing = null, revealTimer = null;
  var holdingReveal = false;  /* a press is studying the reveal; release moves on */
  var teaching = false, teachTimer = null;
  var lastWords = '';  /* the last scored item, in words, for the round-done line */

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function itemLabel() { return 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND; }

  /* Items 1–2: a baseline at a gentle ±15° with big endpoint dots. */
  function makeTicksItem(n) {
    var m = 36;
    var ang = rand(-15, 15) * Math.PI / 180;
    var dx = Math.cos(ang), dy = Math.sin(ang);
    var len = 0.82 * (W - 2 * m);
    if (Math.abs(dx) > 0.01) len = Math.min(len, (W - 2 * m) / Math.abs(dx));
    if (Math.abs(dy) > 0.01) len = Math.min(len, (H - 2 * m) / Math.abs(dy));
    var hx = dx * len / 2, hy = dy * len / 2;
    var axAbs = Math.abs(hx), ayAbs = Math.abs(hy);
    var mx = rand(m + axAbs, Math.max(m + axAbs, W - m - axAbs));
    var myLo = Math.max(m + ayAbs, H * 0.32), myHi = Math.min(H - m - ayAbs, H * 0.68);
    var my = myHi > myLo ? rand(myLo, myHi) : H / 2;
    return { type: 'ticks', n: n, a: { x: mx - hx, y: my - hy }, b: { x: mx + hx, y: my + hy } };
  }

  /* Items 3–4: a rectangle — the fourth tilted ~30°, filled parallel to
     its short edge. Scaled + centered so it always fits; on a narrow
     sheet the box takes more of the page, because the gaps inside it are
     what the player is being asked to see. */
  function makeHatchItem(rotated) {
    var m = 16;
    var wide = narrow();
    var ang = rotated ? rand(25, 35) * Math.PI / 180 * (Math.random() < 0.5 ? -1 : 1) : 0;
    var hw = (wide ? 0.40 : (rotated ? 0.27 : 0.31)) * W;
    var hh = (wide ? 0.30 : (rotated ? 0.22 : 0.27)) * H;
    var cu = Math.abs(Math.cos(ang)), su = Math.abs(Math.sin(ang));
    var ex = hw * cu + hh * su, ey = hw * su + hh * cu;
    var s = Math.min(1, (W / 2 - m) / ex, (H / 2 - m) / ey);
    hw *= s; hh *= s; ex *= s; ey *= s;
    var cx = W / 2 + rand(-1, 1) * Math.min(18, Math.max(0, W / 2 - m - ex));
    var cy = H / 2 + rand(-1, 1) * Math.min(12, Math.max(0, H / 2 - m - ey));
    return { type: 'hatch', rotated: rotated, ang: ang, cx: cx, cy: cy, hw: hw, hh: hh };
  }

  function makeItem(idx) {
    if (idx === 0) return makeTicksItem(3);
    if (idx === 1) return makeTicksItem(5);
    return makeHatchItem(idx === 3);
  }

  function resetItemMarks() {
    ticks = [];
    hatchStrokes = [];
    stroke = [];
    drawing = false;
    activePid = null;
    activeType = null;
    teaching = false;
    clearTimeout(teachTimer);
  }

  function introHint() {
    var ask = fillAsk();
    if (item.type === 'ticks') {
      return itemLabel() + ' — cross the line with ' + item.n +
        ' short ticks, the same distance apart, then press done.';
    }
    return item.rotated
      ? itemLabel() + ' — tilted box: fill it with ' + ask.lo + '–' + ask.hi +
        ' evenly spaced parallel strokes, running the way the dashed guide runs, then press done.'
      : itemLabel() + ' — fill the box with ' + ask.lo + '–' + ask.hi +
        ' evenly spaced parallel strokes, like the dashed guide, then press done.';
  }

  function progressHint() {
    var ask = fillAsk();
    if (item.type === 'ticks') {
      if (ticks.length >= item.n) {
        return itemLabel() + ' — all ' + item.n + ' ticks placed. press done, or undo ↶ to move one.';
      }
      return itemLabel() + ' — ' + ticks.length + ' of ' + item.n + ' ticks.';
    }
    var n = hatchStrokes.length;
    return itemLabel() + ' — ' + n + ' stroke' + (n === 1 ? '' : 's') +
      (n < ask.min
        ? ' (done unlocks at ' + ask.min + ').'
        : ' — press done when the gaps look even.');
  }

  function updateTools() {
    var live = playing && !revealing && item;
    var ask = fillAsk();
    var ready = false, marks = 0;
    if (live) {
      marks = item.type === 'ticks' ? ticks.length : hatchStrokes.length;
      ready = item.type === 'ticks' ? marks >= item.n : marks >= ask.min;
    }
    /* always on the page now, so nothing about the drill commits itself:
       the ticks items used to score the instant the n-th tick landed */
    btnDone.hidden = false;
    btnDone.disabled = !ready;
    btnDone.title = ready ? 'score this item'
      : (live && item.type === 'ticks' ? 'place all ' + item.n + ' ticks first' : 'draw a few more strokes first');
    btnUndo.disabled = marks === 0;
  }

  function newRound() {
    clearTimeout(revealTimer);
    round += 1;
    itemIdx = 0;
    itemScores = [];
    revealing = null;
    holdingReveal = false;
    lastWords = '';
    playing = true;
    item = makeItem(0);
    resetItemMarks();
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = introHint();
    updateTools();
    draw();
  }

  /* ============================================================
     Painting (canvas bg stays clear so the CSS dot-grid shows).
     ============================================================ */
  function drawPolyline(pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function chip(text, x, y, c, color) {
    ctx.font = '800 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    var lx = Math.max(16, Math.min(W - 16, x));
    var ly = Math.max(13, Math.min(H - 5, y));
    var w = ctx.measureText(text).width + 10;
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = c.card;
    ctx.fillRect(lx - w / 2, ly - 10, w, 15);
    ctx.restore();
    ctx.fillStyle = color;
    ctx.fillText(text, lx, ly + 2);
  }

  function drawBaseline(c, it, subdued) {
    ctx.strokeStyle = subdued ? c.muted : c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(it.a.x, it.a.y);
    ctx.lineTo(it.b.x, it.b.y);
    ctx.stroke();
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(it.a.x, it.a.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(it.b.x, it.b.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTickMarks(c, it, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    var i, t, p;
    for (i = 0; i < ticks.length; i++) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(ticks[i].pts);
      t = ticks[i].t;
      p = { x: it.a.x + (it.b.x - it.a.x) * t, y: it.a.y + (it.b.y - it.a.y) * t };
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* Shown once, on the very first item of a first round, for about a
     second after the first tick lands: where the ticks WOULD go if they
     were even. "Evenly" is the whole idea of the drill and nothing on
     the page had ever shown it. */
  function drawTeachGhost(c, it) {
    var ideal = idealFractions(it.n), i, p, dxl = it.b.x - it.a.x, dyl = it.b.y - it.a.y;
    var len = Math.hypot(dxl, dyl) || 1;
    var nx = -dyl / len, ny = dxl / len;
    ctx.save();
    ctx.globalAlpha = 0.85;   /* 3.9:1 paper / 5.4:1 night — it is a lesson, not decoration */
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 4]);
    for (i = 0; i < ideal.length; i++) {
      p = { x: it.a.x + dxl * ideal[i], y: it.a.y + dyl * ideal[i] };
      ctx.beginPath();
      ctx.moveTo(p.x - nx * 12, p.y - ny * 12);
      ctx.lineTo(p.x + nx * 12, p.y + ny * 12);
      ctx.stroke();
    }
    ctx.restore();
  }

  function hatchAxes(it) {
    return {
      u: { x: Math.cos(it.ang), y: Math.sin(it.ang) },
      v: { x: -Math.sin(it.ang), y: Math.cos(it.ang) }
    };
  }

  function drawHatchRect(c, it, subdued) {
    var ax = hatchAxes(it), u = ax.u, v = ax.v;
    ctx.strokeStyle = subdued ? c.muted : c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(it.cx - u.x * it.hw - v.x * it.hh, it.cy - u.y * it.hw - v.y * it.hh);
    ctx.lineTo(it.cx + u.x * it.hw - v.x * it.hh, it.cy + u.y * it.hw - v.y * it.hh);
    ctx.lineTo(it.cx + u.x * it.hw + v.x * it.hh, it.cy + u.y * it.hw + v.y * it.hh);
    ctx.lineTo(it.cx - u.x * it.hw + v.x * it.hh, it.cy - u.y * it.hw + v.y * it.hh);
    ctx.closePath();
    ctx.stroke();
  }

  /* Dashed sample stroke near the box's left end — "make strokes like
     this" for a first-time player, and on the tilted box it is also the
     answer to "which edge is the short one". */
  function drawHatchGuide(c, it) {
    var ax = hatchAxes(it), u = ax.u, v = ax.v;
    var gx = it.cx - u.x * it.hw * 0.76, gy = it.cy - u.y * it.hw * 0.76;
    ctx.save();
    ctx.globalAlpha = 0.85;   /* the guide answers "which edge is short" — keep it readable */
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gx - v.x * it.hh * 0.8, gy - v.y * it.hh * 0.8);
    ctx.lineTo(gx + v.x * it.hh * 0.8, gy + v.y * it.hh * 0.8);
    ctx.stroke();
    ctx.restore();
  }

  /* Clip the line through q along unit dir d to the rectangle. */
  function clipLineToRect(it, q, d) {
    var ax = hatchAxes(it), u = ax.u, v = ax.v;
    var qx = (q.x - it.cx) * u.x + (q.y - it.cy) * u.y;
    var qy = (q.x - it.cx) * v.x + (q.y - it.cy) * v.y;
    var dx = d.x * u.x + d.y * u.y;
    var dy = d.x * v.x + d.y * v.y;
    var t0 = -Infinity, t1 = Infinity, ta, tb;
    if (Math.abs(dx) < 1e-9) {
      if (Math.abs(qx) > it.hw) return null;
    } else {
      ta = (-it.hw - qx) / dx; tb = (it.hw - qx) / dx;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (Math.abs(dy) < 1e-9) {
      if (Math.abs(qy) > it.hh) return null;
    } else {
      ta = (-it.hh - qy) / dy; tb = (it.hh - qy) / dy;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (!isFinite(t0) || !isFinite(t1) || t0 > t1) return null;
    return [{ x: q.x + d.x * t0, y: q.y + d.y * t0 }, { x: q.x + d.x * t1, y: q.y + d.y * t1 }];
  }

  /* k evenly spaced lines along dir, clipped to the rect. */
  function ghostLines(it, dir, k) {
    var ax = hatchAxes(it);
    var px = -dir.y, py = dir.x;
    var E = Math.abs(ax.u.x * px + ax.u.y * py) * it.hw + Math.abs(ax.v.x * px + ax.v.y * py) * it.hh;
    var out = [], i, t, seg;
    for (i = 0; i < k; i++) {
      t = -E + (i + 0.5) * 2 * E / k;
      seg = clipLineToRect(it, { x: it.cx + px * t, y: it.cy + py * t }, dir);
      if (seg) out.push(seg);
    }
    return out;
  }

  function drawTicksReveal(c, r) {
    drawBaseline(c, r.item, true);
    var dxl = r.item.b.x - r.item.a.x, dyl = r.item.b.y - r.item.a.y;
    var len = Math.hypot(dxl, dyl) || 1;
    var nx = -dyl / len, ny = dxl / len;
    var i, p, off, txt;
    /* the player's ink */
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2.5;
    for (i = 0; i < r.ticks.length; i++) drawPolyline(r.ticks[i].pts);
    ctx.restore();
    /* ideal ticks in accent + signed per-tick offsets */
    var q, f;
    for (i = 0; i < r.offsets.length; i++) {
      off = r.offsets[i];
      p = { x: r.item.a.x + dxl * off.ideal, y: r.item.a.y + dyl * off.ideal };
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(p.x - nx * 12, p.y - ny * 12);
      ctx.lineTo(p.x + nx * 12, p.y + ny * 12);
      ctx.stroke();
      /* The delta as a LENGTH, not only as a number: a bar on the far side
         of the baseline running from where the tick belonged to where it
         landed, capped by a dot on the player's own position. "+18" is a
         figure a beginner has to convert into a distance on this very
         sheet before it means anything; the bar is already that distance.
         Drawn opposite the ±px chips so the two never overlap. */
      f = off.ideal + (len > 0 ? off.deltaPx / len : 0);
      q = { x: r.item.a.x + dxl * f, y: r.item.a.y + dyl * f };
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x - nx * 19, p.y - ny * 19);
      ctx.lineTo(q.x - nx * 19, q.y - ny * 19);
      ctx.stroke();
      ctx.fillStyle = c.ink;
      ctx.beginPath();
      ctx.arc(q.x - nx * 19, q.y - ny * 19, 3.5, 0, Math.PI * 2);
      ctx.fill();
      txt = (off.deltaPx >= 0 ? '+' : '') + Math.round(off.deltaPx);
      chip(txt, p.x + nx * 27, p.y + ny * 27, c, c.ink);
    }
  }

  function drawHatchReveal(c, r) {
    drawHatchRect(c, r.item, true);
    var i, g, m1, m2;
    /* ideal evenly spaced ghost in accent. The stroke count was fixed when the
       item was scored — it must NOT be re-derived from fillAsk() here, which
       reads the CURRENT canvas width: rotating a tablet mid-reveal redrew "a
       perfectly even fill" with 7 lines for a fill the player made with 9,
       while their own gap numbers, printed on the same picture and merely
       rescaled, still described 9. The ghost and the numbers are one lesson. */
    var lines = ghostLines(r.item, r.ghostDir, r.ghostN);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    for (i = 0; i < lines.length; i++) {
      ctx.beginPath();
      ctx.moveTo(lines[i][0].x, lines[i][0].y);
      ctx.lineTo(lines[i][1].x, lines[i][1].y);
      ctx.stroke();
    }
    ctx.restore();
    /* the player's ink */
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2.5;
    for (i = 0; i < r.strokes.length; i++) drawPolyline(r.strokes[i]);
    /* their gap sizes, labeled between consecutive strokes */
    for (i = 0; i < r.ev.gaps.length; i++) {
      g = r.ev.gaps[i];
      m1 = r.ev.mids[r.ev.order[i]];
      m2 = r.ev.mids[r.ev.order[i + 1]];
      chip(String(Math.round(g)), (m1.x + m2.x) / 2, (m1.y + m2.y) / 2, c, c.ink);
    }
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (revealing) {
      if (revealing.type === 'ticks') drawTicksReveal(c, revealing);
      else drawHatchReveal(c, revealing);
      return;
    }
    if (!playing || !item) return;

    if (item.type === 'ticks') {
      drawBaseline(c, item, false);
      if (teaching) drawTeachGhost(c, item);
      drawTickMarks(c, item, 1);
    } else {
      drawHatchRect(c, item, false);
      drawHatchGuide(c, item);
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      for (var i = 0; i < hatchStrokes.length; i++) drawPolyline(hatchStrokes[i]);
    }
    if (drawing) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(stroke);
    }
  }

  /* ============================================================
     Input — free strokes anywhere on the canvas, one pointer at a
     time, with a pen outranking a palm that landed first.
     ============================================================ */
  /* Split in two so a run of coalesced samples can share ONE canvas
     measurement: getBoundingClientRect() forces a layout flush, and a fast
     pen hands over dozens of samples per frame — all of them describing a
     canvas that cannot have moved between them — in the same handler that
     repaints. Measured here: 16 layout reads per pointermove instead of 1.
     (This is the hazard ArtDaily.samples() is documented against.) */
  function posIn(ev, rect) {
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
  function pointerPos(ev) {
    return posIn(ev, canvas.getBoundingClientRect());
  }

  function penWins(ev) {
    /* only a FINGER ever waits, and only while the pen is still talking;
       a mouse or an unknown pointer type is always allowed to draw */
    if (ev.pointerType !== 'touch') return true;
    return (ev.timeStamp || 0) - lastPenAt >= PEN_LOCKOUT_MS;
  }

  /* The press that owns the current stroke is provably no longer down.

     A pointer is `primary` only while it is the FIRST ACTIVE pointer of its
     type, so a new primary of the SAME type proves the stored one has ended —
     while a genuine second finger arriving during a live stroke is never
     primary, and is still ignored by the guard below.

     This is the only recovery a FINGER has. The same-id branch below exists
     for a release lost outside the document (press, drag out of the embed
     frame, let go over the page), and it works for a mouse or a pen because
     those keep one pointerId for the whole session. Every touch gets a FRESH
     id, so that branch can never fire for one — and no pointerup,
     pointercancel or lostpointercapture will ever arrive for a finger that is
     already gone. Measured: one lost touch release left `drawing` true against
     an id nothing could match again, every later press was swallowed, and the
     sheet was dead until "new round" — which throws the whole round away. */
  function ownerGone(ev) {
    return ev.isPrimary === true && ev.pointerType === activeType;
  }

  function abortStroke() {
    if (activePid !== null) {
      try { canvas.releasePointerCapture(activePid); } catch (e) {}
    }
    drawing = false;
    activePid = null;
    activeType = null;
    stroke = [];
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (ev.pointerType === 'pen') lastPenAt = ev.timeStamp || 0;
    if (!playing || !item) return;
    if (revealing) {
      /* Press-and-hold studies the reveal for as long as you like; the
         release moves on. This is the busiest reveal in the set — a pink
         ghost, the player's own marks, a delta bar and a number per gap —
         and it used to be shown for under two seconds with no way to
         pause it. Same gesture as angle-snap's protractor arc. */
      ev.preventDefault();
      clearTimeout(revealTimer);
      holdingReveal = true;
      return;
    }
    if (drawing) {
      /* This very pointer is down twice with no release in between, which the
         pointer-events spec says cannot happen: its release was lost (press,
         drag out of the embed frame, let go over the page). The old press is
         over, so drop it. Without this the `else return` below swallowed the
         new press while pointermove — which only checks `drawing` and the id,
         both still matching — kept appending its samples to the ABANDONED
         stroke: the two marks were welded into one tick (or one fill stroke)
         and the item was graded on a mark the player never made. */
      if (ev.pointerId === activePid) abortStroke();
      else if (ev.pointerType === 'pen' && activeType !== 'pen') abortStroke();
      /* a finger's release was lost: the id is new but the old one is gone */
      else if (ownerGone(ev)) abortStroke();
      else return;
    }
    if (!penWins(ev)) return;
    if (item.type === 'ticks' && ticks.length >= item.n) {
      hint.textContent = itemLabel() + ' — that is all ' + item.n +
        ' ticks. press done to score, or undo ↶ to move one.';
      return;
    }
    ev.preventDefault();
    drawing = true;
    activePid = ev.pointerId;
    activeType = ev.pointerType;
    stroke = [pointerPos(ev)];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (ev.pointerType === 'pen') lastPenAt = ev.timeStamp || 0;
    if (!drawing || ev.pointerId !== activePid) return;
    ev.preventDefault();
    /* coalesced events: a fast fill stroke keeps every sample, and
       fitDirection is only as good as the samples that survive. The canvas is
       measured ONCE for the whole run — see posIn(). */
    var rect = canvas.getBoundingClientRect();
    var evs = ArtDaily.samples(ev);
    for (var i = 0; i < evs.length; i++) stroke.push(posIn(evs[i], rect));
    draw();
  });

  function endStroke(ev) {
    if (!drawing || ev.pointerId !== activePid) return;
    if (ev.cancelable) ev.preventDefault();
    drawing = false;
    activePid = null;
    activeType = null;
    var pts = stroke;
    stroke = [];
    /* a second finger may have pressed done / new round mid-stroke —
       never commit ink into an item that is already scored or gone */
    if (!playing || revealing || !item) { draw(); return; }
    if (item.type === 'ticks') registerTick(pts);
    else registerHatchStroke(pts);
  }
  /* A release while the reveal is held moves on; otherwise it is a lift. */
  function onPointerUp(ev) {
    if (revealing && holdingReveal) {
      holdingReveal = false;
      clearTimeout(revealTimer);
      nextItem();
      return;
    }
    endStroke(ev);
  }
  canvas.addEventListener('pointerup', onPointerUp);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', onPointerUp);
  /* iOS drops capture without a pointerup — treat it as the lift it is */
  canvas.addEventListener('lostpointercapture', endStroke);

  /* End a press-and-hold that is never going to get its release, and start
     the countdown over: the hold cancels the auto-advance, so a tab switch,
     an OS notification or a context menu would otherwise strand the reveal
     with nothing counting down and no way on but "new round". */
  function releaseHold() {
    if (!revealing || !holdingReveal) return;
    holdingReveal = false;
    clearTimeout(revealTimer);
    if (playing) {
      revealTimer = setTimeout(nextItem,
        revealing.type === 'ticks' ? REVEAL_TICKS_MS : REVEAL_HATCH_MS);
    }
  }
  window.addEventListener('blur', releaseHold);
  window.addEventListener('contextmenu', releaseHold);

  function cancelStroke(ev) {
    /* interrupted stroke (system gesture etc.) — reset, no penalty */
    if (revealing && holdingReveal) { releaseHold(); return; }
    if (!drawing || ev.pointerId !== activePid) return;
    abortStroke();
    if (playing && !revealing && item) hint.textContent = progressHint();
    draw();
  }
  canvas.addEventListener('pointercancel', cancelStroke);
  window.addEventListener('pointercancel', cancelStroke);

  function registerTick(pts) {
    if (pts.length < 2 || pathLength(pts) < TICK_MIN_PATH) {
      /* a press with no pull — no penalty, no tick, and say so, because
         a mark that silently fails to appear reads as a broken page */
      hint.textContent = itemLabel() + ' — that was a press, not a tick. draw a short line across the baseline.';
      draw();
      return;
    }
    var hit = strokeCrossing(pts, item.a, item.b);
    if (!hit || hit.near > tickNear()) {
      hint.textContent = itemLabel() + ' — that mark was too far from the line; draw your tick across it.';
      draw();
      return;
    }
    ticks.push({ t: hit.t, pts: pts });
    /* one-time lesson: after the first tick of a first round, show where
       even ticks would sit. Nothing else on the page ever showed it. */
    if (round === 1 && itemIdx === 0 && ticks.length === 1) {
      teaching = true;
      clearTimeout(teachTimer);
      teachTimer = setTimeout(function () { teaching = false; draw(); }, TEACH_MS);
      hint.textContent = itemLabel() + ' — the pink ticks show what "evenly" means. shown once.';
    } else {
      hint.textContent = progressHint();
    }
    updateTools();
    draw();
  }

  function registerHatchStroke(pts) {
    if (pts.length < 2 || pathLength(pts) < HATCH_MIN_PATH) {
      /* dropping this silently, and then scoring the gap it left, is the
         exact "this feels unfair" failure — so it says what happened */
      hint.textContent = itemLabel() + ' — that mark was too short to count. pull each stroke right across the box.';
      draw();
      return;
    }
    hatchStrokes.push(pts);
    hint.textContent = progressHint();
    updateTools();
    draw();
  }

  /* ============================================================
     Scoring a finished item → reveal → next.
     ============================================================ */
  /* Named once so the two scorers cannot drift apart. The round's LAST
     reveal stays on the sheet with nothing counting down, so offering to
     hold it would be an instruction with nothing behind it. */
  function holdCopy() {
    return itemIdx + 1 < ITEMS_PER_ROUND ? ' hold to study, release for next.' : '';
  }

  function scoreTicksItem() {
    var fracs = [], i;
    for (i = 0; i < ticks.length; i++) fracs.push(ticks[i].t);
    var segLen = Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y);
    var sc = tickScore(fracs, item.n, segLen, easeFactor());
    itemScores.push(sc);
    if (itemScores.length === ITEMS_PER_ROUND) reportRound();
    revealing = {
      type: 'ticks',
      item: item,
      ticks: ticks,
      offsets: tickOffsets(fracs, item.n, segLen)
    };
    var words = tickWords(
      gapsInDrawnOrder(tickGaps(fracs, item.n, segLen), fracs), easeFactor(),
      tickErrorPx(fracs, item.n, segLen),
      tickTolerancePx(item.n, segLen, easeFactor()));
    lastWords = itemLabel() + ': ' + Math.round(sc) + (words ? ' — ' + words + '.' : '.');
    /* The legend earns its length once. Repeating it on every item pushed
       the delta — the only part that is about THIS attempt — past the fold
       of a phone hint line, and a hint line that long shoves the canvas
       down the page. Item 1 is the first tick item, so it carries it. */
    hint.textContent = itemLabel() + ' — ' + Math.round(sc) +
      (words ? '. ' + words + '.' : '.') +
      (itemIdx === 0
        ? ' pink ticks = perfectly even; the bar beside each runs to where yours landed, and the number is that gap in px.'
        : '') + holdCopy();
    updateTools();
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(nextItem, REVEAL_TICKS_MS);
  }

  function scoreHatchItem() {
    var ev = hatchEval(hatchStrokes, easeFactor());
    var ax = hatchAxes(item);
    var ask = fillAsk();
    /* hatchEval grades the strokes against each other; fillFit grades them
       against the box they were asked to fill */
    var fit = fillFit(ev, item, easeFactor());
    var score = ev.score * fit.factor;
    itemScores.push(score);
    if (itemScores.length === ITEMS_PER_ROUND) reportRound();
    revealing = {
      type: 'hatch',
      item: item,
      strokes: hatchStrokes,
      ev: ev,
      /* tilted box: the ideal follows the asked-for short-edge axis;
         free box: it follows the player's own mean direction */
      ghostDir: item.rotated ? ax.v : { x: Math.cos(ev.meanAng), y: Math.sin(ev.meanAng) },
      /* how many strokes "evenly spaced" meant for THIS attempt — frozen with
         the rest of the reveal, so a resize cannot restate the lesson */
      ghostN: Math.min(ask.hi, Math.max(ask.lo, hatchStrokes.length))
    };
    /* the numbers, then the same thing in words — a reveal that only
       scores teaches nothing */
    var fw = fillWords(ev, easeFactor());
    var words = fw ? ' ' + fw + '.' : '';
    /* parallelism is forced to 0 when the strokes had no daylight between
       them, so "fanned 0° apart" would be an invented second complaint on
       top of the one that actually cost the score */
    if (ev.spread && ev.parallelism < 60) words += ' your strokes fanned about ' + Math.round(ev.stdDeg) + '° apart in direction.';
    /* a score cut by the box, not by the strokes, has to say so — a number
       that drops for a reason nobody names teaches nothing */
    if (fit.aligned < 0.98) words += ' your fill ran ' + Math.round(fit.offDeg) +
      '° off the dashed guide — the pink ghost shows the way it was asked for.';
    if (fit.spread < 0.9) words += ' it only crossed part of the box.';
    if (fit.inBox < 0.9) words += ' some strokes landed outside the box.';
    lastWords = itemLabel() + ': ' + Math.round(score) + (words ? ' —' + words : '.');
    /* words BEFORE the legend: the delta is the part about this attempt,
       and it used to sit behind a sentence of chrome the player has
       already read. Item 3 is the first fill item, so it carries the
       legend and item 4 does not repeat it. */
    hint.textContent = itemLabel() + ' — ' + Math.round(score) +
      ' (parallel ' + Math.round(ev.parallelism) + ' · even gaps ' + Math.round(ev.rhythm) + ').' +
      words +
      (itemIdx === 2 ? ' pink ghost = a perfectly even fill; the numbers are your own gaps.' : '') +
      holdCopy();
    updateTools();
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(nextItem, REVEAL_HATCH_MS);
  }

  /* Nothing commits itself. The ticks item used to score the instant the
     n-th tick landed, which took the decision away from a player whose
     own finger was covering the mark they had just made. */
  btnDone.addEventListener('click', function () {
    if (!playing || revealing || !item) return;
    if (item.type === 'ticks') {
      if (ticks.length < item.n) return;
      scoreTicksItem();
      return;
    }
    if (hatchStrokes.length < fillAsk().min) return;
    scoreHatchItem();
  });

  btnUndo.addEventListener('click', function () {
    if (!playing || revealing || !item) return;
    if (item.type === 'ticks' && ticks.length) ticks.pop();
    else if (item.type === 'hatch' && hatchStrokes.length) hatchStrokes.pop();
    hint.textContent = progressHint();
    updateTools();
    draw();
  });

  function nextItem() {
    if (!revealing) return;
    if (itemIdx + 1 >= ITEMS_PER_ROUND) {
      /* The round's last reveal STAYS on the sheet, exactly as it does in
         every sibling drill. Clearing `revealing` here blanked the canvas the
         instant the round ended — the pink ghost, the gap numbers and the
         player's own fill all vanished a second after the score appeared,
         so the one item they most wanted to compare was the one they never
         got to look at. */
      finishRound();
      return;
    }
    revealing = null;
    holdingReveal = false;
    itemIdx += 1;
    item = makeItem(itemIdx);
    resetItemMarks();
    hint.textContent = introHint();
    updateTools();
    draw();
  }

  /* The round is complete the instant its fourth item is scored —
     report right then (exactly once: itemScores only ever reaches
     ITEMS_PER_ROUND once per round), not after the final reveal, so
     pressing "new round" or closing the tab mid-reveal can't lose a
     finished round. */
  function reportRound() {
    var res = ArtDaily.report(roundScore(itemScores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  function finishRound() {
    playing = false;
    item = null;
    updateTools();
    draw();   /* `revealing` is still set, so the last item stays up to study */
    hint.textContent = 'round done — ' + (lastWords ? lastWords + ' ' : '') +
      'the last item stays up to study. press "new round" to go again.';
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  ArtDaily.onInput(function () {
    /* Only once there is something to count. This fires from the SDK's
       capture-phase pointerdown listener, i.e. on the player's very first
       press — replacing the item's instructions with "0 of 3 ticks" while
       they are still reading them, before a single mark exists. */
    if (playing && !revealing && item && (ticks.length || hatchStrokes.length)) {
      hint.textContent = progressHint();
    }
    updateTools();
    draw();
  });

  /* A reveal has to be carried across a resize, not left drawn against the
     old canvas box. The handler below only ever REBUILT the live item, so a
     reveal was untouched — and the round's closing reveal is kept on screen
     deliberately, with `playing` already false, so nothing rebuilt it
     either: rotating a phone there left the pink ghost, the gap numbers and
     the player's own fill exactly where they were (measured: painted out to
     x=702 on a 380px sheet — nearly the whole lesson off the page).

     Uniform scale about the sheet's centre. Uniform because the tilted box
     and the fill's own direction are what item 4 is ABOUT — scaling x and y
     by different factors would shear the box and quietly redraw the strokes
     at an angle nobody drew. Scaling about the centre also cannot push
     anything out: a point within half the old box of the old centre lands
     within s·(oldW/2) ≤ W/2 of the new one. Pixel readouts (the per-tick
     ±px chips, the gap sizes) scale with the picture so the numbers still
     describe the drawing they are printed on. */
  function rescaleReveal(oldW, oldH) {
    var rv = revealing, s, ox, oy, nx, ny, it, i, k;
    if (!rv || !(oldW > 0) || !(oldH > 0)) return;
    s = Math.min(W / oldW, H / oldH);
    if (!isFinite(s) || s <= 0) return;
    ox = oldW / 2; oy = oldH / 2; nx = W / 2; ny = H / 2;
    function mv(p) {
      p.x = nx + (p.x - ox) * s;
      p.y = ny + (p.y - oy) * s;
    }
    it = rv.item;
    if (rv.type === 'ticks') {
      mv(it.a); mv(it.b);
      for (i = 0; i < rv.ticks.length; i++) {
        for (k = 0; k < rv.ticks[i].pts.length; k++) mv(rv.ticks[i].pts[k]);
      }
      for (i = 0; i < rv.offsets.length; i++) rv.offsets[i].deltaPx *= s;
      return;
    }
    it.cx = nx + (it.cx - ox) * s;
    it.cy = ny + (it.cy - oy) * s;
    it.hw *= s; it.hh *= s;
    for (i = 0; i < rv.strokes.length; i++) {
      for (k = 0; k < rv.strokes[i].length; k++) mv(rv.strokes[i][k]);
    }
    for (i = 0; i < rv.ev.mids.length; i++) mv(rv.ev.mids[i]);
    for (i = 0; i < rv.ev.gaps.length; i++) rv.ev.gaps[i] *= s;
    /* it.ang, ev.meanAng and ghostDir are directions — a uniform scale
       leaves every one of them exactly as it was */
  }

  window.addEventListener('resize', function () {
    var prevW = W, prevH = H;
    fitCanvas();
    /* mobile URL-bar collapses fire resize without a width change —
       only rebuild (and clear in-progress marks) when width moved */
    if (W !== prevW && revealing) rescaleReveal(prevW, prevH);
    if (W !== prevW && playing && !revealing) {
      /* the baseline/box is re-placed for the new sheet, so any marks already
         on the old one go with it. Say so: the marks used to vanish under the
         plain opening instructions, which reads as the drill losing your work
         rather than the screen having changed. */
      var hadMarks = ticks.length > 0 || hatchStrokes.length > 0;
      abortStroke();
      item = makeItem(itemIdx);
      resetItemMarks();
      hint.textContent = (hadMarks ? 'the screen changed size — fresh item, no penalty. ' : '') + introHint();
      updateTools();
    }
    draw();
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
