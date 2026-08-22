import type { TrajectoryModel } from "../host/trajectoryModel";

/**
 * Self-drawn (flavor B) trajectory HTML. The model rides a JSON `<script type=
 * "application/json">` island; the inline renderer reads it and draws, with
 * plain string concatenation only (no template literals, so nothing collides
 * with the outer TypeScript template). No external assets: hand-rolled SVG for
 * the timeline, scatter-line, comfy lanes, and attribution graph.
 */
export function trajectoryHtml(model: TrajectoryModel, nonce: string): string {
  const json = JSON.stringify(model)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 12px 16px; background: #1e1e1e; color: #d4d4d4; font: 13px/1.5 var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif); }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .meta { color: #9d9d9d; font-size: 11px; margin-bottom: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
  details { border: 1px solid #3c3c3c; border-radius: 5px; margin-bottom: 10px; background: #252526; }
  summary { cursor: pointer; padding: 6px 10px; font-weight: 600; color: #e0e0e0; user-select: none; }
  .body { padding: 8px 10px; overflow: auto; }
  svg text { fill: #cccccc; font-size: 10px; }
  .msg { border-left: 3px solid #555; margin: 8px 0; padding: 4px 10px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { border-left-color: #4ec9b0; }
  .msg.assistant { border-left-color: #569cd6; }
  .msg .tag { display: block; color: #8a8a8a; font-size: 10px; margin-bottom: 2px; }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 10px; color: #9d9d9d; margin: 4px 0; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 3px; border-radius: 2px; vertical-align: -1px; }
</style>
</head>
<body>
<h1>DSH 轨迹</h1>
<div class="meta" id="meta"></div>
<script type="application/json" id="data">${json}</script>
<script nonce="${nonce}">
(function () {
  var M = JSON.parse(document.getElementById("data").textContent);
  var COLORS = {
    "user/message": "#4ec9b0", "assistant/message": "#569cd6", "assistant/chunk": "#9cdcfe",
    "tool/call": "#dcdcaa", "tool/result": "#ce9178", "step/start": "#c586c0",
    "step/end": "#c586c0", "turn/end": "#f48771", "request/header": "#6a9955",
    "request/context": "#6a9955"
  };
  function colorOf(t) { return COLORS[t] || "#808080"; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(n) { if (!n && n !== 0) return "-"; if (n >= 1000000) return (n / 1000000).toFixed(1) + "M"; if (n >= 1000) return (n / 1000).toFixed(1) + "K"; return String(Math.round(n)); }
  function sect(title, inner) {
    return '<details open><summary>' + esc(title) + '</summary><div class="body">' + inner + '</div></details>';
  }

  var root = document.body;
  root.querySelector("#meta").innerHTML =
    '<span>turns ' + M.turns + '</span><span>steps ' + M.steps + '</span>' +
    '<span>Δ' + fmt(M.durationMs) + 'ms</span>' +
    '<span>llm ' + fmt(M.tokenRow.llmMs) + 'ms</span>' +
    '<span>tok ' + fmt(M.tokenRow.outputTokens) + ' out / ' + fmt(M.tokenRow.cacheReadTokens) + ' cache</span>' +
    '<span>files ' + M.files.length + '</span>' +
    '<span class="mono">' + esc(String(M.sessionId).slice(0, 18) + "…") + '</span>';

  var TL = null;

  // ---- timeline (downsampled density strip) ----
  function timeline() {
    var W = 980, H = 70, pad = 12;
    var t0 = M.startTime, t1 = M.endTime > M.startTime ? M.endTime : M.startTime + 1;
    var x = function (t) { return pad + (t - t0) / (t1 - t0) * (W - 2 * pad); };
    var bins = 380, size = (t1 - t0) / bins || 1;
    var buckets = {};
    for (var i = 0; i < M.trace.length; i++) {
      var p = M.trace[i];
      var b = Math.floor((p.time - t0) / size);
      (buckets[b] = buckets[b] || { time: p.time, type: p.type, n: 0 }).n++;
      buckets[b].type = p.type;
      buckets[b].time = p.time;
    }
    TL = { t0: t0, t1: t1, pad: pad, W: W };
    var svg = ['<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'];
    svg.push('<line x1="' + pad + '" y1="' + (H - 6) + '" x2="' + (W - pad) + '" y2="' + (H - 6) + '" stroke="#555"/>');
    for (var k in buckets) {
      var bk = buckets[k];
      var h = Math.max(3, Math.min(56, 4 + Math.log(bk.n + 1) * 14));
      svg.push('<line x1="' + x(bk.time).toFixed(1) + '" y1="' + (H - 6 - h) + '" x2="' + x(bk.time).toFixed(1) + '" y2="' + (H - 6) + '" stroke="' + colorOf(bk.type) + '"/><title>' + esc(bk.type + " ×" + bk.n) + '</title>');
    }
    svg.push('<line id="cursor" x1="' + pad + '" y1="0" x2="' + pad + '" y2="' + H + '" stroke="#ffffff" stroke-width="1.5" style="display:none"/>');
    svg.push('</svg>');
    var replay = '<div style="margin:4px 0"><button id="replayBtn" style="cursor:pointer">▶ 回放</button> <span id="replayClock" style="color:#9d9d9d"></span></div>';
    var legend = ['<div class="legend">'];
    for (var c in COLORS) legend.push('<span><i style="background:' + COLORS[c] + '"></i>' + esc(c) + '</span>');
    legend.push('</div>');
    return sect("时间线（按事件类型着色的密度带）", replay + svg.join("") + legend.join(""));
  }

  // ---- scatter-line: step latency over wall time ----
  function latency() {
    var W = 980, H = 180, padL = 46, padR = 12, padT = 12, padB = 24;
    var pts = M.latency;
    var t0 = M.startTime, t1 = M.endTime > M.startTime ? M.endTime : M.startTime + 1;
    var maxD = 1;
    for (var i = 0; i < pts.length; i++) if (pts[i].durMs > maxD) maxD = pts[i].durMs;
    var x = function (t) { return padL + (t - t0) / (t1 - t0) * (W - padL - padR); };
    var y = function (d) { return padT + (1 - d / maxD) * (H - padT - padB); };
    var svg = ['<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '">'];
    var poly = [];
    for (var j = 0; j < pts.length; j++) {
      var px = x(pts[j].time).toFixed(1), py = y(pts[j].durMs).toFixed(1);
      poly.push(px + "," + py);
      svg.push('<circle cx="' + px + '" cy="' + py + '" r="2.5" fill="#dcdcaa"><title>' + esc("step " + pts[j].step + " · " + fmt(pts[j].durMs) + "ms") + '</title></circle>');
    }
    if (poly.length > 1) svg.push('<polyline points="' + poly.join(" ") + '" fill="none" stroke="#569cd6" stroke-width="1"/>');
    svg.push('<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#555"/>');
    svg.push('<text x="' + padL + '" y="' + (H - 8) + '">0</text><text x="' + (W - 40) + '" y="' + (H - 8) + '">时间 →</text>');
    svg.push('</svg>');
    return sect("散点-折线（每步延迟 vs 墙钟时间）", svg.join(""));
  }

  // ---- comfy lanes: one row per turn, step boxes by time ----
  function lanes() {
    var boxH = 22, gap = 4, pad = 14, labelW = 60;
    var turns = [];
    var maxTurn = 0;
    for (var i = 0; i < M.lanes.length; i++) if (M.lanes[i].turn > maxTurn) maxTurn = M.lanes[i].turn;
    var rows = [];
    for (var t = 1; t <= Math.max(1, maxTurn); t++) rows.push(M.lanes.filter(function (l) { return l.turn === t; }));
    var H = rows.reduce(function (a, r) { return a + (r.length ? boxH + gap : 0); }, pad) + pad;
    var W = 980, innerW = W - pad - labelW;
    var t0 = M.startTime, t1 = M.endTime > M.startTime ? M.endTime : M.startTime + 1;
    var x = function (t) { return labelW + pad + (t - t0) / (t1 - t0) * (innerW - 2 * pad); };
    var wOf = function (l) { return Math.max(6, (l.durMs) / (t1 - t0) * innerW); };
    var svg = ['<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '">'];
    var y = pad;
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      svg.push('<text x="4" y="' + (y + boxH / 2 + 3) + '" fill="#9d9d9d">T' + (r + 1) + '</text>');
      for (var s = 0; s < row.length; s++) {
        var l = row[s];
        var bx = x(l.start), bw = wOf(l);
        var label = "s" + l.step + (l.tools.length ? " · " + l.tools.join(",") : "");
        svg.push('<rect x="' + bx.toFixed(1) + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + boxH + '" rx="4" fill="#3c3c3c" stroke="#569cd6"/><text x="' + (bx + 4).toFixed(1) + '" y="' + (y + boxH / 2 + 3) + '">' + esc(String(label).slice(0, 38)) + '</text><title>' + esc("turn " + l.turn + " step " + l.step + " · " + l.tools.join(", ") + " · " + fmt(l.durMs) + "ms") + '</title>');
        if (s > 0) {
          var prev = row[s - 1];
          svg.push('<line x1="' + x(prev.end).toFixed(1) + '" y1="' + (y + boxH / 2) + '" x2="' + x(l.start).toFixed(1) + '" y2="' + (y + boxH / 2) + '" stroke="#666" stroke-dasharray="2,2" marker-end="url(#arr)"/>');
        }
      }
      y += row.length ? boxH + gap : 0;
    }
    svg.push('<defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#888"/></marker></defs>');
    svg.push('</svg>');
    return sect("Comfy 流（轮次泳道 · 步骤节点按时间排布）", svg.join(""));
  }

  // ---- attribution: agent → tools → files ----
  function attribution() {
    var tools = {}, order = [];
    for (var i = 0; i < M.toolCalls.length; i++) {
      var n = M.toolCalls[i].name;
      if (!(n in tools)) { tools[n] = { files: {} }; order.push(n); }
      for (var j = 0; j < M.toolCalls[i].files.length; j++) tools[n].files[M.toolCalls[i].files[j]] = 1;
    }
    order = order.slice(0, 16);
    var files = M.files.slice(0, 30);
    var W = 980, padT = 16, rowH = 20;
    var toolMidY = padT + (order.length ? (order.length * 24) : 20) / 2;
    var fileMidY = padT + (files.length ? (files.length * 14) : 20) / 2;
    var H = Math.max(toolMidY * 2, fileMidY * 2) + 20;
    var ax = 60, tx = 340, fx = 660, ay = H / 2, ty = H / 2, fy = H / 2;
    var svg = ['<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '">'];
    svg.push('<circle cx="' + ax + '" cy="' + ay + '" r="24" fill="#1f6feb"/><text x="' + ax + '" y="' + (ay + 4) + '" text-anchor="middle" fill="#fff" font-weight="600">Agent</text>');
    var toolYs = {};
    order.forEach(function (n, idx) {
      var yy = padT + idx * 24 + 10;
      toolYs[n] = yy;
      svg.push('<rect x="' + (tx - 50) + '" y="' + (yy - 9) + '" width="100" height="18" rx="9" fill="#2d2d2d" stroke="#dcdcaa"/><text x="' + tx + '" y="' + (yy + 3) + '" text-anchor="middle">' + esc(n) + '</text>');
      svg.push('<line x1="' + (ax + 24) + '" y1="' + ay + '" x2="' + (tx - 50) + '" y2="' + yy + '" stroke="#555"/>');
    });
    var fileYs = {};
    files.forEach(function (f, idx) {
      var yy = padT + idx * 14 + 6;
      fileYs[f] = yy;
      var short = f.length > 34 ? "…" + f.slice(-33) : f;
      svg.push('<text x="' + fx + '" y="' + yy + '">' + esc(short) + '</text>');
    });
    order.forEach(function (n) {
      for (var f in tools[n].files) {
        if (fileYs[f] !== undefined) svg.push('<line x1="' + (tx + 50) + '" y1="' + toolYs[n] + '" x2="' + fx + '" y2="' + fileYs[f] + '" stroke="#4a4a4a" stroke-width="0.7"/>');
      }
    });
    svg.push('</svg>');
    return sect("归因图（Agent → 工具 → 文件）", svg.join("") + (files.length >= 30 ? '<div class="meta">文件过多，仅显示前 30 个。</div>' : ""));
  }

  // ---- transcript ----
  function transcript() {
    if (!M.messages.length) return sect("关联式转写", '<div class="meta">该窗口无消息。</div>');
    var out = [];
    for (var i = 0; i < M.messages.length; i++) {
      var m = M.messages[i];
      out.push('<div class="msg ' + esc(m.role) + '"><span class="tag">' + esc(m.role + " · " + m.type) + '</span>' + esc(m.text) + '</div>');
    }
    return sect("关联式转写（" + M.messages.length + " 条消息）", out.join(""));
  }

  root.insertAdjacentHTML("beforeend",
    timeline() + latency() + lanes() + attribution() + transcript());

  // replay animation: sweep a cursor across the timeline at ~150x wall-clock.
  function attachReplay() {
    var btn = document.getElementById("replayBtn");
    var cur = document.getElementById("cursor");
    var clock = document.getElementById("replayClock");
    if (!btn || !cur || !TL) return;
    var raf = 0, playing = false, start0 = 0;
    var SPEED = 150; // playback ms = span / SPEED
    var span = TL.t1 - TL.t0;
    function stop() {
      playing = false; cancelAnimationFrame(raf); btn.textContent = "▶ 回放";
      if (clock) clock.textContent = "";
    }
    function tick(now) {
      var t = (now - start0) * SPEED;
      if (t >= span) { stop(); return; }
      var xv = (TL.pad + t / span * (TL.W - 2 * TL.pad)).toFixed(1);
      cur.setAttribute("x1", xv); cur.setAttribute("x2", xv);
      if (clock) clock.textContent = "+" + (t / 1000).toFixed(1) + "s / " + (span / 1000).toFixed(0) + "s";
      raf = requestAnimationFrame(tick);
    }
    btn.addEventListener("click", function () {
      if (playing) { stop(); return; }
      playing = true; start0 = performance.now(); btn.textContent = "⏸ 暂停";
      cur.setAttribute("x1", TL.pad); cur.setAttribute("x2", TL.pad);
      cur.style.display = "block";
      raf = requestAnimationFrame(tick);
    });
  }
  attachReplay();
})();
</script>
</body>
</html>`;
}