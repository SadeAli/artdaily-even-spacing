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
      drift: gaps.length > 1 ? gaps[gaps.length - 1] - gaps[0] : 0
    };
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
  var teaching = false, teachTimer = null;

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
    for (i = 0; i < r.offsets.length; i++) {
      off = r.offsets[i];
      p = { x: r.item.a.x + dxl * off.ideal, y: r.item.a.y + dyl * off.ideal };
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(p.x - nx * 12, p.y - ny * 12);
      ctx.lineTo(p.x + nx * 12, p.y + ny * 12);
      ctx.stroke();
      txt = (off.deltaPx >= 0 ? '+' : '') + Math.round(off.deltaPx);
      chip(txt, p.x + nx * 27, p.y + ny * 27, c, c.ink);
    }
  }

  function drawHatchReveal(c, r) {
    drawHatchRect(c, r.item, true);
    var ask = fillAsk();
    var i, g, m1, m2;
    /* ideal evenly spaced ghost in accent */
    var lines = ghostLines(r.item, r.ghostDir, Math.min(ask.hi, Math.max(ask.lo, r.strokes.length)));
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
  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function penWins(ev) {
    /* only a FINGER ever waits, and only while the pen is still talking;
       a mouse or an unknown pointer type is always allowed to draw */
    if (ev.pointerType !== 'touch') return true;
    return (ev.timeStamp || 0) - lastPenAt >= PEN_LOCKOUT_MS;
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
    if (!playing || revealing || !item) return;
    if (drawing) {
      if (ev.pointerType === 'pen' && activeType !== 'pen') abortStroke();
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
       fitDirection is only as good as the samples that survive */
    var evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null;
    if (evs && evs.length) {
      for (var i = 0; i < evs.length; i++) stroke.push(pointerPos(evs[i]));
    } else {
      stroke.push(pointerPos(ev));
    }
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
  canvas.addEventListener('pointerup', endStroke);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endStroke);
  /* iOS drops capture without a pointerup — treat it as the lift it is */
  canvas.addEventListener('lostpointercapture', endStroke);

  function cancelStroke(ev) {
    /* interrupted stroke (system gesture etc.) — reset, no penalty */
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
    hint.textContent = itemLabel() + ' — ' + Math.round(sc) +
      '. pink ticks = perfectly even spacing; the numbers are how far off each of yours landed, in px.';
    updateTools();
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(nextItem, REVEAL_TICKS_MS);
  }

  function scoreHatchItem() {
    var ev = hatchEval(hatchStrokes, easeFactor());
    var ax = hatchAxes(item);
    itemScores.push(ev.score);
    if (itemScores.length === ITEMS_PER_ROUND) reportRound();
    revealing = {
      type: 'hatch',
      item: item,
      strokes: hatchStrokes,
      ev: ev,
      /* tilted box: the ideal follows the asked-for short-edge axis;
         free box: it follows the player's own mean direction */
      ghostDir: item.rotated ? ax.v : { x: Math.cos(ev.meanAng), y: Math.sin(ev.meanAng) }
    };
    /* the numbers, then the same thing in words — a reveal that only
       scores teaches nothing */
    var words = '';
    if (Math.abs(ev.drift) > 6) words = ev.drift > 0 ? ' your gaps widened as you went.' : ' your gaps tightened as you went.';
    else if (ev.rhythm < 60) words = ' your gaps jumped about instead of holding one size.';
    if (ev.parallelism < 60) words += ' your strokes fanned about ' + Math.round(ev.stdDeg) + '° apart in direction.';
    hint.textContent = itemLabel() + ' — ' + Math.round(ev.score) +
      ' (parallel ' + Math.round(ev.parallelism) + ' · even gaps ' + Math.round(ev.rhythm) +
      '). pink ghost = a perfectly even fill; the numbers are your own gaps.' + words;
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
    revealing = null;
    itemIdx += 1;
    if (itemIdx < ITEMS_PER_ROUND) {
      item = makeItem(itemIdx);
      resetItemMarks();
      hint.textContent = introHint();
      updateTools();
      draw();
      return;
    }
    finishRound();
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
    draw();
    hint.textContent = 'round done — press "new round" to go again.';
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
    if (playing && !revealing && item) hint.textContent = progressHint();
    updateTools();
    draw();
  });

  window.addEventListener('resize', function () {
    var prevW = W;
    fitCanvas();
    /* mobile URL-bar collapses fire resize without a width change —
       only rebuild (and clear in-progress marks) when width moved */
    if (W !== prevW && playing && !revealing) {
      abortStroke();
      item = makeItem(itemIdx);
      resetItemMarks();
      hint.textContent = introHint();
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
