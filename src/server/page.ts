/**
 * The dashboard, inlined.
 *
 * Kept as strings in a .ts file rather than as assets on disk so that
 * `npm run build` stays a single `tsc` invocation with nothing to copy, and so
 * the server has no filesystem dependency beyond .office. The client uses no
 * framework and no template literals -- string concatenation and DOM calls --
 * because this file is itself inside a template literal.
 */

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0e1116; --panel: #161b22; --panel-2: #1c2129; --line: #262c36;
  --text: #e6edf3; --muted: #8b949e; --faint: #6e7681;
  --idle: #6e7681; --working: #3fb950; --queued: #58a6ff;
  --blocked: #d29922; --parked: #f85149; --accent: #58a6ff;
  --desk: #2d333b; --desk-edge: #3d444d; --floor: #12161c;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #f6f8fa; --panel: #ffffff; --panel-2: #f6f8fa; --line: #d8dee4;
    --text: #1f2328; --muted: #59636e; --faint: #818b98;
    --desk: #e4e8ed; --desk-edge: #cdd4db; --floor: #eef1f4;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  height: 100vh; display: flex; flex-direction: column; overflow: hidden;
}
header {
  display: flex; align-items: center; gap: 24px; padding: 12px 18px;
  background: var(--panel); border-bottom: 1px solid var(--line); flex: none;
}
.brand { font-weight: 650; letter-spacing: -0.01em; display: flex; align-items: center; gap: 9px; }
.brand .plan {
  font-weight: 500; font-size: 11px; color: var(--muted);
  border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px;
}
.live { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--working); }
.live.stale .dot { background: var(--parked); }
.live.stale .dot, .live .dot { animation: pulse 2.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }

.meters { display: flex; gap: 20px; margin-left: auto; align-items: center; }
.meter { min-width: 190px; }
.meter .top { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.meter .top b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.track { position: relative; height: 7px; border-radius: 4px; background: var(--panel-2); border: 1px solid var(--line); overflow: hidden; }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: var(--working); transition: width .5s cubic-bezier(.4,0,.2,1), background .3s; }
.fill.warn { background: var(--blocked); }
.fill.over { background: var(--parked); }
.softstop { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--muted); opacity: .8; }
.spend { font-size: 11px; color: var(--muted); white-space: nowrap; }
.spend b { color: var(--text); font-variant-numeric: tabular-nums; }

main { display: grid; grid-template-columns: 1fr 340px; flex: 1; min-height: 0; }
#floor { position: relative; background: var(--floor); overflow: hidden; }
#floor::before {
  content: ""; position: absolute; inset: 0; opacity: .5;
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 44px 44px; -webkit-mask-image: radial-gradient(ellipse at center, #000 40%, transparent 85%);
  mask-image: radial-gradient(ellipse at center, #000 40%, transparent 85%);
}
#wires { position: absolute; inset: 0; pointer-events: none; }

.desk {
  position: absolute; width: 176px; transform: translate(-50%, -50%);
  cursor: pointer; transition: transform .35s cubic-bezier(.4,0,.2,1);
}
.desk .surface {
  background: var(--desk); border: 1px solid var(--desk-edge);
  border-radius: 10px; padding: 10px 10px 8px; position: relative;
  box-shadow: 0 1px 0 rgba(0,0,0,.25), 0 6px 18px rgba(0,0,0,.18);
  transition: border-color .3s, box-shadow .3s;
}
.desk.sel .surface { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 8px 24px rgba(0,0,0,.3); }
.desk .row { display: flex; align-items: center; gap: 8px; }
.avatar {
  width: 30px; height: 30px; border-radius: 50%; flex: none;
  display: grid; place-items: center; font-weight: 650; font-size: 11px;
  color: #0e1116; background: var(--idle); position: relative;
  transition: background .35s, box-shadow .35s;
}
.desk[data-status="working"] .avatar { background: var(--working); box-shadow: 0 0 0 3px color-mix(in srgb, var(--working) 25%, transparent); }
.desk[data-status="queued"] .avatar { background: var(--queued); }
.desk[data-status="blocked"] .avatar { background: var(--blocked); box-shadow: 0 0 0 3px color-mix(in srgb, var(--blocked) 25%, transparent); }
.desk[data-status="parked"] .avatar { background: var(--parked); }
.desk[data-status="working"] .avatar::after {
  content: ""; position: absolute; inset: -5px; border-radius: 50%;
  border: 1px solid var(--working); animation: ring 1.8s ease-out infinite;
}
@keyframes ring { from { transform: scale(.85); opacity: .9; } to { transform: scale(1.35); opacity: 0; } }
.who { min-width: 0; }
.who .n { font-weight: 600; font-size: 12px; }
.who .t { font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.screen {
  margin-top: 8px; height: 26px; display: block; line-height: 24px; border-radius: 4px; background: var(--panel);
  border: 1px solid var(--line); padding: 0 6px; display: flex; align-items: center;
  font-size: 10px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.desk[data-status="working"] .screen { color: var(--text); border-color: color-mix(in srgb, var(--working) 45%, var(--line)); }
.chips { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.chip {
  font-size: 9.5px; padding: 1px 5px; border-radius: 3px;
  background: var(--panel); border: 1px solid var(--line); color: var(--muted);
}
.chip.demoted { color: var(--blocked); border-color: var(--blocked); }
.chip.breaker { color: var(--parked); border-color: var(--parked); }
.chip.dirty { color: var(--queued); }
.badge {
  position: absolute; top: -7px; right: -7px; min-width: 18px; height: 18px;
  border-radius: 9px; background: var(--accent); color: #0e1116;
  font-size: 10px; font-weight: 700; display: grid; place-items: center; padding: 0 5px;
}

.envelope { transition: none; }
.envelope rect { fill: var(--accent); }
.envelope path { stroke: var(--bg); stroke-width: 1; fill: none; }

aside { background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; padding: 14px; }
aside h2 {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); margin: 0 0 8px; font-weight: 600;
}
aside section { margin-bottom: 22px; }
.card { background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
.card.warn { border-color: var(--blocked); }
.card .hd { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-bottom: 5px; }
.card .hd b { font-size: 12px; }
.card .hd span { font-size: 10px; color: var(--muted); }
.card p { margin: 0; font-size: 11.5px; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
.actions { display: flex; gap: 6px; margin-top: 9px; }
button {
  font: inherit; font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--text); transition: .15s;
}
button:hover { border-color: var(--accent); }
button.ok { border-color: var(--working); color: var(--working); }
button.no { border-color: var(--parked); color: var(--parked); }
button:disabled { opacity: .45; cursor: default; }
input[type=text] {
  font: inherit; font-size: 11px; width: 100%; margin-top: 7px; padding: 5px 8px;
  border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text);
}
.taskrow { display: flex; gap: 8px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 11.5px; }
.taskrow:last-child { border-bottom: 0; }
.taskrow .st { font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; width: 58px; flex: none; }
.st.done { color: var(--working); } .st.running { color: var(--queued); }
.st.blocked { color: var(--blocked); } .st.failed { color: var(--parked); }
.st.pending, .st.assigned { color: var(--faint); }
.taskrow .who2 { color: var(--muted); font-size: 10.5px; margin-left: auto; flex: none; }
.empty { color: var(--faint); font-size: 11.5px; font-style: italic; }
pre {
  margin: 0; font: 10.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap; word-break: break-word; max-height: 230px; overflow: auto;
  color: var(--muted);
}
pre .add { color: var(--working); } pre .del { color: var(--parked); } pre .hunk { color: var(--queued); }
footer {
  flex: none; height: 46px; background: var(--panel); border-top: 1px solid var(--line);
  display: flex; align-items: center; gap: 14px; padding: 0 18px;
}
footer .lbl { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
#burn { flex: 1; height: 26px; }
.tabs { display: flex; gap: 4px; margin-bottom: 9px; }
.tab { font-size: 11px; padding: 3px 9px; border-radius: 6px; cursor: pointer; color: var(--muted); border: 1px solid transparent; }
.tab.on { color: var(--text); border-color: var(--line); background: var(--panel-2); }
`;

const BODY = `
<header>
  <div class="brand">ai-office <span class="plan" id="plan">--</span></div>
  <div class="live" id="live"><span class="dot"></span><span id="livetext">connecting</span></div>
  <div class="meters">
    <div class="meter">
      <div class="top"><span id="wlabel">window</span><b id="wpct">0%</b></div>
      <div class="track"><div class="fill" id="wfill"></div><div class="softstop" id="wstop"></div></div>
    </div>
    <div class="meter">
      <div class="top"><span>this week</span><b id="kpct">0%</b></div>
      <div class="track"><div class="fill" id="kfill"></div><div class="softstop" id="kstop"></div></div>
    </div>
    <div class="spend">notional <b id="spend">$0.00</b> &middot; <b id="turns">0</b> turns</div>
  </div>
</header>
<main>
  <div id="floor"><svg id="wires"></svg></div>
  <aside>
    <section id="escsec">
      <h2>Waiting on you</h2>
      <div id="escalations"></div>
    </section>
    <section>
      <div class="tabs">
        <div class="tab on" data-tab="tasks">Tasks</div>
        <div class="tab" data-tab="agent">Agent</div>
      </div>
      <div id="panel"></div>
    </section>
  </aside>
</main>
<footer>
  <span class="lbl">burn, last 60 turns</span>
  <svg id="burn"></svg>
  <span class="lbl" id="burnnote"></span>
</footer>
`;

const JS = `
var S = null, sel = null, tab = "tasks", flown = {}, pos = {}, stale = false;
var SVGNS = "http://www.w3.org/2000/svg";

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function svg(tag, attrs) {
  var n = document.createElementNS(SVGNS, tag);
  for (var k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}
function initials(name) {
  var p = String(name).trim().split(/\\s+/);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
function ago(iso) {
  var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

var DESK_W = 176, DESK_H = 132, GAP = 46, scale = 1;

/* Desks form one centred block, not a grid stretched over the whole floor.
   Spreading four desks across a wide screen puts them in the corners and makes
   the mail between them unreadable; a cluster keeps the traffic visible. The
   column count is whichever makes the block's shape closest to the floor's,
   and short rows are centred so the last one is not left-aligned under a full
   row above it. */
function layout() {
  var floor = document.getElementById("floor");
  var w = floor.clientWidth, h = floor.clientHeight, n = S.desks.length;
  if (!n || !w) return;

  var target = w / Math.max(h, 1), best = 1, bestErr = Infinity;
  for (var c = 1; c <= n; c++) {
    var r = Math.ceil(n / c);
    var blockW = c * DESK_W + (c - 1) * GAP;
    var blockH = r * DESK_H + (r - 1) * GAP;
    if (blockW > w - 40 || blockH > h - 40) continue;
    var err = Math.abs(Math.log((blockW / blockH) / target));
    if (err < bestErr) { bestErr = err; best = c; }
  }

  var cols = best, rows = Math.ceil(n / cols);

  /* A handful of desks at their natural size leave most of the floor empty and
     the whole thing reads as a spreadsheet with gaps. Grow the block to fill
     what is there, capped so a floor of two does not turn into billboards. */
  scale = Math.max(1, Math.min(1.45,
    Math.min((w - 96) / (cols * DESK_W + (cols - 1) * GAP),
             (h - 96) / (rows * DESK_H + (rows - 1) * GAP))));

  var stepX = (DESK_W + GAP) * scale, stepY = (DESK_H + GAP) * scale;
  var top = (h - (rows * DESK_H + (rows - 1) * GAP) * scale) / 2 + DESK_H * scale / 2;

  S.desks.forEach(function (d, i) {
    var r = Math.floor(i / cols), c = i % cols;
    var inRow = Math.min(cols, n - r * cols);
    var rowW = (inRow * DESK_W + (inRow - 1) * GAP) * scale;
    var left = (w - rowW) / 2 + DESK_W * scale / 2;
    pos[d.id] = { x: left + c * stepX, y: top + r * stepY };
  });
}

function renderDesks() {
  var floor = document.getElementById("floor");
  var keep = {};
  S.desks.forEach(function (d) {
    keep[d.id] = 1;
    var node = document.getElementById("desk-" + d.id);
    if (!node) {
      node = el("div", "desk");
      node.id = "desk-" + d.id;
      node.onclick = function () { sel = d.id; tab = "agent"; renderPanel(); renderDesks(); };
      node.appendChild(el("div", "surface"));
      floor.appendChild(node);
    }
    var p = pos[d.id] || { x: 0, y: 0 };
    node.style.left = p.x + "px";
    node.style.top = p.y + "px";
    node.style.transform = "translate(-50%, -50%) scale(" + scale.toFixed(3) + ")";
    node.dataset.status = d.status;
    node.className = "desk" + (sel === d.id ? " sel" : "");

    var s = node.firstChild;
    s.textContent = "";
    var row = el("div", "row");
    var av = el("div", "avatar", initials(d.name));
    if (d.unread > 0) av.appendChild(el("div", "badge", String(d.unread)));
    row.appendChild(av);
    var who = el("div", "who");
    who.appendChild(el("div", "n", d.name));
    who.appendChild(el("div", "t", d.title));
    row.appendChild(who);
    s.appendChild(row);

    var line = d.currentTask ? d.currentTask.title
      : d.status === "blocked" ? "waiting on a decision"
      : d.status === "parked" ? "parked by the breaker"
      : d.status === "working" ? "working"
      : d.status === "queued" ? "queued"
      : "idle";
    var screen = el("div", "screen", line);
    screen.title = line;
    s.appendChild(screen);

    var chips = el("div", "chips");
    var t = el("span", "chip" + (d.effectiveTier !== d.tier ? " demoted" : ""), d.effectiveTier);
    chips.appendChild(t);
    if (d.breakerStage > 0) chips.appendChild(el("span", "chip breaker", "breaker " + d.breakerStage));
    if (d.dirty) chips.appendChild(el("span", "chip dirty", "uncommitted"));
    if (d.turnsToday) chips.appendChild(el("span", "chip", d.turnsToday + " turns \\u00b7 " + fmt(d.weightedToday)));
    s.appendChild(chips);
  });

  Array.prototype.slice.call(floor.querySelectorAll(".desk")).forEach(function (n) {
    if (!keep[n.id.slice(5)]) n.remove();
  });
}

/* An envelope drawn once per message, along a curve between two desks. It is
   the only way to see that two agents talked without reading two transcripts. */
function fly(m) {
  var a = pos[m.from], b = pos[m.to];
  if (!a || !b) return;
  var wires = document.getElementById("wires");
  var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - Math.hypot(b.x - a.x, b.y - a.y) * 0.22;
  var path = svg("path", { d: "M" + a.x + "," + a.y + " Q" + mx + "," + my + " " + b.x + "," + b.y,
    fill: "none", stroke: "var(--accent)", "stroke-width": "1", "stroke-dasharray": "3 4", opacity: "0.35" });
  wires.appendChild(path);

  var g = svg("g", { class: "envelope" });
  g.appendChild(svg("rect", { x: "-7", y: "-5", width: "14", height: "10", rx: "1.5" }));
  g.appendChild(svg("path", { d: "M-7,-5 L0,1 L7,-5" }));
  wires.appendChild(g);

  var len = path.getTotalLength(), t0 = performance.now(), dur = 1100;
  function step(now) {
    var k = Math.min(1, (now - t0) / dur);
    var pt = path.getPointAtLength(len * k);
    g.setAttribute("transform", "translate(" + pt.x + "," + pt.y + ")");
    g.setAttribute("opacity", String(k < 0.12 ? k / 0.12 : k > 0.85 ? (1 - k) / 0.15 : 1));
    path.setAttribute("opacity", String(0.35 * (1 - k)));
    if (k < 1) requestAnimationFrame(step);
    else { g.remove(); path.remove(); }
  }
  requestAnimationFrame(step);
}

function renderHeader() {
  document.getElementById("plan").textContent = S.plan + " \\u00b7 max " + S.maxConcurrent + " at once";
  document.getElementById("wlabel").textContent = S.windowHours + "h window";
  document.getElementById("spend").textContent = "$" + S.budget.costUsd.toFixed(2);
  document.getElementById("turns").textContent = String(S.budget.turns);
  [["w", S.budget.window], ["k", S.budget.week]].forEach(function (pair) {
    var k = pair[0], m = pair[1], p = Math.max(0, Math.min(1, m.pct));
    var fill = document.getElementById(k + "fill");
    fill.style.width = (p * 100).toFixed(1) + "%";
    fill.className = "fill" + (m.pct >= 1 ? " over" : m.pct >= S.softStopPct ? " warn" : "");
    document.getElementById(k + "pct").textContent = Math.round(m.pct * 100) + "%";
    document.getElementById(k + "stop").style.left = (S.softStopPct * 100) + "%";
    fill.parentNode.title = fmt(m.used) + " of " + fmt(m.limit) + " weighted tokens";
  });
}

function renderEscalations() {
  var host = document.getElementById("escalations");
  host.textContent = "";
  var open = S.escalations.filter(function (e) { return !e.decision; });
  if (!open.length) { host.appendChild(el("div", "empty", "Nothing. The floor is running itself.")); return; }

  open.forEach(function (e) {
    var c = el("div", "card warn");
    var hd = el("div", "hd");
    hd.appendChild(el("b", null, e.agent + " \\u00b7 " + e.kind));
    hd.appendChild(el("span", null, ago(e.raisedAt)));
    c.appendChild(hd);
    c.appendChild(el("p", null, e.detail));
    var note = el("input");
    note.type = "text";
    note.placeholder = "why (the agent will remember this)";
    c.appendChild(note);
    var actions = el("div", "actions");
    ["approve", "deny"].forEach(function (verb) {
      var b = el("button", verb === "approve" ? "ok" : "no", verb);
      b.onclick = function () {
        actions.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
        fetch("/api/escalations/" + e.id + "/" + verb, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: note.value })
        }).then(refresh);
      };
      actions.appendChild(b);
    });
    c.appendChild(actions);
    host.appendChild(c);
  });
}

function renderPanel() {
  document.querySelectorAll(".tab").forEach(function (t) {
    t.className = "tab" + (t.dataset.tab === tab ? " on" : "");
  });
  var host = document.getElementById("panel");
  host.textContent = "";

  if (tab === "tasks") {
    if (!S.tasks.length) { host.appendChild(el("div", "empty", "No tasks. Run: office brief \\"...\\"")); return; }
    S.tasks.slice().reverse().forEach(function (t) {
      var r = el("div", "taskrow");
      r.appendChild(el("span", "st " + t.state, t.state));
      r.appendChild(el("span", null, t.title));
      r.appendChild(el("span", "who2", t.assignee));
      host.appendChild(r);
    });
    return;
  }

  var d = null;
  S.desks.forEach(function (x) { if (x.id === sel) d = x; });
  if (!d) { host.appendChild(el("div", "empty", "Click a desk.")); return; }

  var c = el("div", "card");
  var hd = el("div", "hd");
  hd.appendChild(el("b", null, d.name));
  hd.appendChild(el("span", null, d.status));
  c.appendChild(hd);
  c.appendChild(el("p", null,
    d.title + "\\n" + d.effectiveTier + " \\u00b7 autonomy " + d.autonomy +
    "\\nscope: " + (d.scope.length ? d.scope.join(", ") : "the whole repo") +
    (d.branch ? "\\nbranch: " + d.branch : "")));
  host.appendChild(c);

  if (d.lastNote) {
    var m = el("div", "card");
    var mh = el("div", "hd");
    mh.appendChild(el("b", null, "last note" + (d.lastNote.tag ? " \\u00b7 " + d.lastNote.tag : "")));
    mh.appendChild(el("span", null, ago(d.lastNote.at)));
    m.appendChild(mh);
    m.appendChild(el("p", null, d.lastNote.text));
    host.appendChild(m);
  }

  var dc = el("div", "card");
  dc.appendChild(el("div", "hd")).appendChild(el("b", null, "diff"));
  var pre = el("pre", null, "loading...");
  dc.appendChild(pre);
  host.appendChild(dc);

  fetch("/api/diff/" + d.id).then(function (r) { return r.json(); }).then(function (j) {
    pre.textContent = "";
    var text = (j.diff || "").trim();
    if (!text) { pre.appendChild(el("span", null, "No changes on this branch.")); return; }
    text.split("\\n").slice(0, 300).forEach(function (line) {
      var cls = line[0] === "+" && line[1] !== "+" ? "add"
        : line[0] === "-" && line[1] !== "-" ? "del"
        : line.slice(0, 2) === "@@" ? "hunk" : null;
      pre.appendChild(el("span", cls, line + "\\n"));
    });
  });
}

function renderBurn() {
  var host = document.getElementById("burn");
  host.textContent = "";
  var w = host.clientWidth, h = host.clientHeight;
  var pts = S.burn;
  document.getElementById("burnnote").textContent = pts.length ? fmt(pts[pts.length - 1].weighted) + " last turn" : "no turns yet";
  if (!pts.length || !w) return;

  var max = Math.max.apply(null, pts.map(function (p) { return p.weighted; })) || 1;
  var bw = Math.max(1, w / pts.length - 1.5);
  pts.forEach(function (p, i) {
    var bh = Math.max(1.5, (p.weighted / max) * (h - 4));
    var r = svg("rect", {
      x: (i * (w / pts.length)).toFixed(1), y: (h - bh).toFixed(1),
      width: bw.toFixed(1), height: bh.toFixed(1), rx: "1",
      fill: p.ok ? "var(--accent)" : "var(--parked)", opacity: "0.75"
    });
    var title = document.createElementNS(SVGNS, "title");
    title.textContent = p.agent + " \\u00b7 " + p.tier + " \\u00b7 " + fmt(p.weighted) + " \\u00b7 " + ago(p.at);
    r.appendChild(title);
    host.appendChild(r);
  });
}

/* The nominal desk height is a guess until something is on screen -- chips wrap,
   and a wrapped desk is half again as tall. Measure one and re-run the layout
   if the guess was wrong, so the block stays centred instead of riding high. */
function remeasure() {
  var one = document.querySelector(".desk");
  if (!one) return;
  var h = one.offsetHeight; // unscaled: the transform does not change layout size
  if (Math.abs(h - DESK_H) < 5) return;
  DESK_H = h;
  layout();
  S.desks.forEach(function (d) {
    var node = document.getElementById("desk-" + d.id), p = pos[d.id];
    if (!node || !p) return;
    node.style.left = p.x + "px";
    node.style.top = p.y + "px";
    node.style.transform = "translate(-50%, -50%) scale(" + scale.toFixed(3) + ")";
  });
}

function render() {
  layout();
  renderHeader();
  renderDesks();
  remeasure();
  renderEscalations();
  renderPanel();
  renderBurn();
  S.mail.forEach(function (m) {
    if (m.delivered && !flown[m.id]) { flown[m.id] = 1; fly(m); }
  });
}

var pending = false;
function refresh() {
  if (pending) return Promise.resolve();
  pending = true;
  return fetch("/api/floor").then(function (r) { return r.json(); }).then(function (j) {
    S = j; stale = false; setLive("live"); render();
  }).catch(function () {
    stale = true; setLive("no connection");
  }).finally(function () { pending = false; });
}

function setLive(text) {
  document.getElementById("live").className = "live" + (stale ? " stale" : "");
  document.getElementById("livetext").textContent = text;
}

document.querySelectorAll(".tab").forEach(function (t) {
  t.onclick = function () { tab = t.dataset.tab; renderPanel(); };
});
window.addEventListener("resize", function () { if (S) { layout(); renderDesks(); remeasure(); renderBurn(); } });

var es = new EventSource("/api/stream");
es.addEventListener("change", refresh);
es.onerror = function () { stale = true; setLive("reconnecting"); };
es.onopen = function () { stale = false; setLive("live"); refresh(); };

/* The stream is the fast path; this is the floor recovering on its own if a
   watcher missed an event or the connection dropped without firing onerror. */
setInterval(refresh, 5000);
refresh();
`;

export function page(): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>ai-office</title>",
    '<link rel="icon" href="/favicon.svg">',
    "<style>" + CSS + "</style>",
    "</head><body>",
    BODY,
    "<script>" + JS + "</script>",
    "</body></html>",
  ].join("\n");
}
