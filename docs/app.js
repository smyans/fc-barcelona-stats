"use strict";

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

function htmlEl(tag, attrs = {}, parent) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else node.setAttribute(key, value);
  }
  if (parent) parent.appendChild(node);
  return node;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (v, digits = 2) => Number(v).toFixed(digits);
const signed = (v, digits = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(digits);
const pct = (v, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  const [ra, ga, ba] = hexToRgb(a);
  const [rb, gb, bb] = hexToRgb(b);
  const c = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${c(ra, rb)}, ${c(ga, gb)}, ${c(ba, bb)})`;
}
function rampColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const scaled = t * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  return mix(stops[i], stops[i + 1], scaled - i);
}
function diverging(value, limit) {
  const stops = ["--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2"].map(css);
  return rampColor(stops, (value / limit + 1) / 2);
}
function sequential(value, max) {
  return rampColor([css("--seq-0"), css("--seq-1")], value / max);
}
function inkFor(rgb) {
  const [r, g, b] = rgb.match(/\d+/g).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55 ? "#0b0b0b" : "#ffffff";
}

// ---------- tooltip ----------
const tooltip = $("#tooltip");
function showTooltip(event, title, rows = []) {
  tooltip.innerHTML = `<div class="tt-title">${escapeHtml(title)}</div>` +
    rows.map(([k, v]) => `<div class="tt-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join("");
  tooltip.hidden = false;
  const pad = 14;
  const box = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
  if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}
const hideTooltip = () => { tooltip.hidden = true; };
window.addEventListener("scroll", hideTooltip, { passive: true });

function segmented(container, onChange) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    for (const b of container.querySelectorAll("button")) b.setAttribute("aria-checked", String(b === button));
    onChange(button.dataset.value);
  });
}

function tile(parent, value, label, cls = "") {
  const t = htmlEl("div", { class: `tile ${cls}` }, parent);
  htmlEl("div", { class: "value", text: value }, t);
  htmlEl("div", { class: "label", text: label }, t);
}

// ---------- state ----------
let DATA;
let SHOTS = [];
const state = {
  cell: { group: "Attackers", metric: "xg" },
  side: "for",
  season: "all",
  player: "all",
  outcome: "all",
  territory: "diff",
};

const METRIC_SECTIONS = [
  ["Shooting", ["xg", "shots", "touches_in_box"]],
  ["Creating", ["xa", "chances_created", "passes_into_box", "crosses"]],
  ["Passing & progression", ["passes", "pass_completion_pct", "ground_pass_pct", "long_balls", "switches",
    "passes_into_final_third", "progressive_passes", "progressive_carries"]],
  ["On the ball", ["actions_under_pressure", "successful_dribbles", "turnovers"]],
  ["Defending", ["tackles", "tackles_won", "interceptions", "pressures", "blocks", "clearances",
    "middle_third_recoveries", "fouls_committed"]],
];
const RATE_METRICS = new Set(["pass_completion_pct", "ground_pass_pct"]);
const unit = (metric) => (RATE_METRICS.has(metric) ? "%" : " per 90");

// Heatmap shade encodes strength of evidence: -log10(FDR-adjusted p), saturating at p = 0.001.
const EVIDENCE_CAP = 3;
const evidence = (p) => Math.min(1, -Math.log10(Math.max(p, 1e-12)) / EVIDENCE_CAP);
const SIG_THRESHOLD = evidence(0.05);

// ---------- hero ----------
function renderSummary() {
  const s = DATA.summary;
  const root = $("#summary-tiles");
  root.innerHTML = "";
  tile(root, s.matches, `La Liga matches, ${s.seasons} seasons`);
  tile(root, `${s.wins}–${s.draws}–${s.losses}`, "won–drawn–lost");
  tile(root, s.goals_for.toLocaleString(), "goals scored");
  tile(root, s.events.toLocaleString(), "events analysed");
  tile(root, s.player_matches.toLocaleString(), "player performances");
}

// ---------- correlation heatmap ----------
function corrFor(group, metric) {
  return DATA.correlations.find((c) => c.position_group === group && c.metric === metric);
}

function renderHeatmap() {
  const root = $("#heatmap");
  root.innerHTML = "";
  htmlEl("div", {}, root);
  for (const group of DATA.groups) htmlEl("div", { class: "col-head", text: group }, root);

  for (const [section, metrics] of METRIC_SECTIONS) {
    htmlEl("div", { class: "group-head", text: section }, root);
    for (const metric of metrics) {
      htmlEl("div", { class: "row-head", text: DATA.labels[metric] }, root);
      for (const group of DATA.groups) {
        const c = corrFor(group, metric);
        const bg = diverging(Math.sign(c.rho) * evidence(c.p_adjusted), 1);
        const selected = state.cell.group === group && state.cell.metric === metric;
        const button = htmlEl("button", {
          style: `background:${bg}`,
          class: selected ? "selected" : "",
          "aria-pressed": String(selected),
          "aria-label": `${DATA.labels[metric]}, ${group}: rho ${signed(c.rho)}${c.significant ? ", significant" : ", not significant"}`,
        }, root);
        button.addEventListener("click", () => { state.cell = { group, metric }; renderHeatmap(); renderDistribution(); });
        button.addEventListener("pointermove", (e) => showTooltip(e, `${DATA.labels[metric]} · ${group}`, [
          ["Spearman ρ", signed(c.rho, 3)],
          ["FDR-adjusted p", c.p_adjusted < 0.001 ? "< 0.001" : fmt(c.p_adjusted, 3)],
          ["Player-matches", c.n.toLocaleString()],
          ["Significant", c.significant ? "Yes" : "No"],
        ]));
        button.addEventListener("pointerleave", hideTooltip);
      }
    }
  }

  const legend = $("#heatmap-legend");
  legend.innerHTML = "";
  legend.className = "evidence-legend";
  const ends = htmlEl("div", { class: "ends" }, legend);
  htmlEl("span", { text: "← Goes with dropping points" }, ends);
  htmlEl("span", { text: "Goes with winning →" }, ends);
  const stops = Array.from({ length: 11 }, (_, i) => diverging(i / 5 - 1, 1));
  htmlEl("div", { class: "bar", style: `background:linear-gradient(90deg,${stops.join(",")})` }, legend);
  const ticks = htmlEl("div", { class: "ticks" }, legend);
  const half = SIG_THRESHOLD / 2;
  for (const [pos, label] of [[0, "p < 0.001"], [0.5 - half, "p = 0.05"], [0.5, "no link"], [0.5 + half, "p = 0.05"], [1, "p < 0.001"]]) {
    htmlEl("span", { style: `left:${pos * 100}%`, text: label }, ticks);
  }
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
  const [weak, strong] = dark ? ["faint", "bright"] : ["lighter", "darker"];
  htmlEl("p", { class: "meta", text: `${weak[0].toUpperCase() + weak.slice(1)} = weak evidence, ${strong} = strong evidence (lower p-value). ` +
    `Anything ${strong} than the p = 0.05 marks is statistically significant. Hover a cell for exact numbers.` }, legend);
}

function renderCorrTable() {
  const rows = METRIC_SECTIONS.flatMap(([, metrics]) => metrics).map((metric) => {
    const cells = DATA.groups.map((g) => {
      const c = corrFor(g, metric);
      return `<td class="n">${signed(c.rho)}${c.significant ? " *" : ""}</td>`;
    }).join("");
    return `<tr><td>${escapeHtml(DATA.labels[metric])}</td>${cells}</tr>`;
  }).join("");
  $("#corr-table").innerHTML = `<table><thead><tr><th>Stat</th>${DATA.groups.map((g) => `<th class="n">${g}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody></table><p class="meta">Spearman ρ with the result. * significant after Benjamini–Hochberg correction (q &lt; 0.05).</p>`;
}

// Lower-case a stat name mid-sentence, but leave acronyms like xG and xA alone.
const inSentence = (label) => (/^[a-z][A-Z]/.test(label) ? label : label.toLowerCase());

function strengthWord(rho) {
  const r = Math.abs(rho);
  if (r < 0.05) return "essentially no";
  if (r < 0.1) return "a weak";
  if (r < 0.2) return "a modest";
  return "a clear";
}

function renderDistribution() {
  const { group, metric } = state.cell;
  const c = corrFor(group, metric);
  const dist = DATA.distributions[group][metric];
  $("#dist-title").textContent = `${DATA.labels[metric]}${RATE_METRICS.has(metric) ? "" : " per 90"} · ${group}`;
  $("#dist-meta").textContent = `${GLOSSARY[metric]}`;

  const svg = $("#dist-chart");
  svg.innerHTML = "";
  const width = Math.max(260, svg.clientWidth || svg.parentNode.clientWidth - 36);
  const rows = [["win", "Win", css("--pos")], ["draw", "Draw", css("--neutral")], ["loss", "Loss", css("--neg")]];
  const left = 48, right = 78, top = 8, rowH = 46, axisH = 28;
  const height = top + rows.length * rowH + axisH;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", `Distribution of ${DATA.labels[metric]} for ${group} by match result`);

  const max = Math.max(...rows.map(([k]) => dist[k][4])) || 1;
  const x = (v) => left + (v / max) * (width - left - right);
  const grid = svgEl("g", { class: "grid" }, svg);
  for (const t of niceTicks(0, max, 4)) {
    svgEl("line", { x1: x(t), x2: x(t), y1: top, y2: top + rows.length * rowH }, grid);
    svgEl("text", { x: x(t), y: height - 8, "text-anchor": "middle" }, svg).textContent = formatTick(t);
  }

  rows.forEach(([key, label, color], i) => {
    const [p10, p25, p50, p75, p90] = dist[key];
    const cy = top + i * rowH + rowH / 2;
    const g = svgEl("g", {}, svg);
    svgEl("text", { x: 0, y: cy + 4, style: `fill:${css("--ink")};font-weight:600` }, g).textContent = label;
    svgEl("line", { x1: x(p10), x2: x(p90), y1: cy, y2: cy, stroke: color, "stroke-width": 2 }, g);
    svgEl("rect", { x: x(p25), y: cy - 11, width: Math.max(2, x(p75) - x(p25)), height: 22, rx: 4,
      fill: color, "fill-opacity": 0.35, stroke: color, "stroke-width": 1.5 }, g);
    svgEl("line", { x1: x(p50), x2: x(p50), y1: cy - 13, y2: cy + 13, stroke: css("--ink"), "stroke-width": 2.5 }, g);
    svgEl("text", { x: x(p90) + 8, y: cy + 4, style: `fill:${css("--ink")}` }, g).textContent = `med ${formatTick(p50)}`;
    const hit = svgEl("rect", { x: left, y: cy - rowH / 2, width: width - left, height: rowH, fill: "transparent" }, g);
    hit.addEventListener("pointermove", (e) => showTooltip(e, `${label} · ${DATA.labels[metric]}`, [
      ["90th percentile", formatTick(p90)], ["75th", formatTick(p75)], ["Median", formatTick(p50)],
      ["25th", formatTick(p25)], ["10th", formatTick(p10)],
    ]));
    hit.addEventListener("pointerleave", hideTooltip);
  });

  // Plain-English reading of the selected cell.
  const win = dist.win[2], loss = dist.loss[2];
  const direction = c.rho > 0 ? "winning" : "dropping points";
  const verdict = c.significant
    ? `<strong>This is a real pattern.</strong> It survives the correction for testing 78 stat-position combinations.`
    : `<strong>Treat this as noise.</strong> With p = ${fmt(c.p_adjusted, 2)} after correction, it could easily be chance.`;
  const generic = `For Barça's ${group.toLowerCase()}, ${inSentence(DATA.labels[metric])} has ${strengthWord(c.rho)} link with ` +
    `${direction} (ρ = ${signed(c.rho)}). The typical player recorded ${formatTick(win)}${unit(metric)} in wins and ` +
    `${formatTick(loss)}${unit(metric)} in defeats. ${verdict}`;
  const curated = INSIGHTS[`${group}|${metric}`] || INSIGHTS[`*|${metric}`];
  $("#dist-insight").innerHTML = `<p>${generic}</p>${curated ? `<p>${curated}</p>` : ""}`;
}

function niceTicks(min, max, count) {
  const span = max - min || 1;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || mag * 10;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}
const formatTick = (v) => (Math.abs(v) >= 10 ? fmt(v, 0) : Math.abs(v) >= 1 ? fmt(v, 1) : fmt(v, 2));

// ---------- shot map ----------
// Markers shrink when thousands of shots are on screen, so dense areas stay readable.
let shotScale = 1;
const shotR = (xg) => Math.max(0.3, Math.sqrt(xg) * 3.0 * shotScale);

function decodeShots(s) {
  const L = s.lookups;
  return s.x.map((x, i) => ({
    x, y: s.y[i], xg: s.xg[i], minute: s.minute[i], isFor: s.for[i] === 1, goal: s.goal[i] === 1,
    on_target: s.on_target[i] === 1, result: s.result[i], match: L.match[s.match[i]], season: L.season[s.season[i]],
    player: L.player[s.player[i]], team: L.team[s.team[i]], outcome: L.outcome[s.outcome[i]],
    shot_type: L.shot_type[s.shot_type[i]], body_part: L.body_part[s.body_part[i]],
  }));
}

function drawHalfPitch(svg) {
  const line = { fill: "none", stroke: css("--pitch-line"), "stroke-width": 0.3 };
  const g = svgEl("g", { "pointer-events": "none" }, svg);
  svgEl("rect", { x: 0, y: 0, width: 80, height: 60, ...line }, g);
  svgEl("rect", { x: 18, y: 0, width: 44, height: 18, ...line }, g);
  svgEl("rect", { x: 30, y: 0, width: 20, height: 6, ...line }, g);
  svgEl("rect", { x: 36, y: -2, width: 8, height: 2, ...line }, g);
  svgEl("circle", { cx: 40, cy: 12, r: 0.4, fill: css("--pitch-line") }, g);
  svgEl("path", { d: "M32,18 A10,10 0 0,0 48,18", ...line }, g);
  svgEl("path", { d: "M30,60 A10,10 0 0,1 50,60", ...line }, g);
}

const sideShots = () => SHOTS.filter((s) => s.isFor === (state.side === "for"));
const seasonShots = () => sideShots().filter((s) => state.season === "all" || s.season === state.season);
const whoKey = (s) => (s.isFor ? s.player : s.team);

function filteredShots() {
  return seasonShots().filter((s) =>
    (state.player === "all" || whoKey(s) === state.player) &&
    (state.outcome === "all" || (state.outcome === "goal" ? s.goal : s.on_target)));
}

function populateShotFilters() {
  const seasonSelect = $("#season-filter");
  seasonSelect.innerHTML = `<option value="all">All seasons</option>` +
    DATA.seasons.map((s) => `<option value="${s.season}">${s.season}</option>`).join("");
  seasonSelect.value = state.season;
  populatePlayerFilter();
}

function populatePlayerFilter() {
  const select = $("#player-filter");
  const counts = new Map();
  for (const s of seasonShots()) counts.set(whoKey(s), (counts.get(whoKey(s)) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  $("#player-label").firstChild.textContent = state.side === "for" ? "Player " : "Opponent ";
  select.innerHTML = `<option value="all">${state.side === "for" ? "All players" : "All opponents"}</option>` +
    names.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
  if (!counts.has(state.player)) state.player = "all";
  select.value = state.player;
}

function renderShotMap() {
  const svg = $("#shot-map");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", "-1.5 -3 83 64.5");
  drawHalfPitch(svg);

  const shots = filteredShots();
  const ordered = [...shots].sort((a, b) => (a.goal - b.goal) || (b.xg - a.xg));
  const dense = shots.length > 2000;
  shotScale = dense ? 0.5 : shots.length > 600 ? 0.75 : 1;
  const dots = svgEl("g", {}, svg);
  const goalColor = state.side === "for" ? css("--pos") : css("--neg");
  for (const s of ordered) {
    svgEl("circle", {
      cx: s.y, cy: 120 - s.x, r: shotR(s.xg),
      fill: s.goal ? goalColor : css("--neutral"),
      "fill-opacity": s.goal ? (dense ? 0.45 : 0.95) : (dense ? 0.3 : 0.7),
      stroke: s.goal && !dense ? css("--surface") : "none", "stroke-width": 0.18,
    }, dots);
  }
  const ring = svgEl("circle", { fill: "none", stroke: css("--ink"), "stroke-width": 0.35, visibility: "hidden" }, svg);

  svg.onpointermove = (event) => {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    let best = null, bestDist = Infinity;
    for (const s of shots) {
      const d = Math.hypot(s.y - point.x, 120 - s.x - point.y) - shotR(s.xg);
      if (d < bestDist || (d === bestDist && s.goal)) { bestDist = d; best = s; }
    }
    if (!best || bestDist > 1) { ring.setAttribute("visibility", "hidden"); hideTooltip(); return; }
    ring.setAttribute("cx", best.y);
    ring.setAttribute("cy", 120 - best.x);
    ring.setAttribute("r", shotR(best.xg) + 0.5);
    ring.setAttribute("visibility", "visible");
    showTooltip(event, `${best.player} (${best.team})`, [
      ["Match", `${best.match}, ${best.season}`], ["Minute", `${best.minute}'`], ["xG", fmt(best.xg, 2)],
      ["Outcome", best.outcome], ["Type", `${best.shot_type}, ${best.body_part}`],
    ]);
  };
  svg.onpointerleave = () => { ring.setAttribute("visibility", "hidden"); hideTooltip(); };

  $("#shot-legend").innerHTML = `<span><span class="swatch" style="background:${goalColor}"></span>Goal</span>` +
    `<span><span class="swatch" style="background:${css("--neutral")}"></span>No goal</span>` +
    `<span>Bigger marker = higher xG (a penalty is about 0.76)</span>`;

  const tiles = $("#shot-tiles");
  tiles.innerHTML = "";
  const goals = shots.filter((s) => s.goal).length;
  const xg = sum(shots, (s) => s.xg);
  tile(tiles, shots.length.toLocaleString(), state.side === "for" ? "shots" : "shots conceded");
  tile(tiles, goals.toLocaleString(), state.side === "for" ? "goals" : "goals conceded");
  tile(tiles, xg.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }), "expected goals (xG)");
  const better = state.side === "for" ? goals - xg > 0 : goals - xg < 0;
  tile(tiles, signed(goals - xg, 1), "goals minus xG", better ? "highlight" : "");

  renderLeaderboard();
  renderShotInsight(shots, goals, xg);
}

function renderLeaderboard() {
  const forSide = state.side === "for";
  const byWho = new Map();
  for (const s of seasonShots()) {
    const key = whoKey(s);
    const p = byWho.get(key) || { name: key, shots: 0, goals: 0, xg: 0, seasons: new Set() };
    p.shots += 1; p.goals += s.goal ? 1 : 0; p.xg += s.xg; p.seasons.add(s.season);
    byWho.set(key, p);
  }
  const top = [...byWho.values()].sort((a, b) => b.goals - a.goals || b.xg - a.xg).slice(0, 8);
  const scope = state.season === "all" ? "" : ` · ${state.season}`;
  $("#leaderboard-title").textContent = (forSide ? "Top scorers" : "Opponents who scored most") + scope;
  const table = $("#leaderboard");
  table.innerHTML = `<thead><tr><th>${forSide ? "Player" : "Opponent"}</th><th class="n hide-sm">Shots</th><th class="n">Goals</th><th class="n">xG</th><th class="n">G − xG</th></tr></thead>`;
  const body = htmlEl("tbody", {}, table);
  for (const p of top) {
    const diff = p.goals - p.xg;
    const row = htmlEl("tr", {}, body);
    const cell = htmlEl("td", {}, row);
    const button = htmlEl("button", { class: "link", text: p.name }, cell);
    if (state.season === "all") {
      const seasons = [...p.seasons].sort();
      htmlEl("span", { class: "sub", text: seasons.length > 1 ? `${seasons[0]} to ${seasons[seasons.length - 1]}` : seasons[0] }, cell);
    }
    button.addEventListener("click", () => { state.player = p.name; populatePlayerFilter(); renderShotMap(); });
    htmlEl("td", { class: "n hide-sm", text: p.shots.toLocaleString() }, row);
    htmlEl("td", { class: "n", text: p.goals }, row);
    htmlEl("td", { class: "n", text: fmt(p.xg, 1) }, row);
    const good = forSide ? diff >= 0 : diff <= 0;
    htmlEl("td", { class: `n ${good ? "delta-pos" : "delta-neg"}`, text: signed(diff, 1) }, row);
  }
}

function inBox(s) { return s.x >= 102 && s.y >= 18 && s.y <= 62; }

function renderShotInsight(shots, goals, xg) {
  const el = $("#shot-insight");
  if (!shots.length) { el.innerHTML = "No shots match these filters."; return; }
  const forSide = state.side === "for";
  const diff = goals - xg;
  const boxShare = shots.filter(inBox).length / shots.length;
  const boxGoals = goals ? shots.filter((s) => s.goal && inBox(s)).length / goals : 0;
  const pens = shots.filter((s) => s.shot_type === "Penalty");
  const penGoals = pens.filter((s) => s.goal).length;
  const who = state.player !== "all" ? state.player : (forSide ? "Barça" : "Barça's opponents");
  const when = state.season === "all" ? "across the 17 seasons" : `in ${state.season}`;
  const finishing = Math.abs(diff) < 0.05 * Math.max(xg, 1)
    ? "That's almost exactly what the chances were worth, so finishing was about average."
    : diff > 0
      ? `That's ${fmt(diff, 1)} more than the chances were worth${forSide ? ", which is elite finishing" : ", so opponents finished better than expected"}.`
      : `That's ${fmt(-diff, 1)} fewer than the chances were worth${forSide ? ", so the finishing let them down" : ", which is a sign of good goalkeeping or wasteful opponents"}.`;
  const avgXg = xg / shots.length;
  const quality = avgXg >= 0.14 ? "high-quality chances (most shots from close range)"
    : avgXg >= 0.09 ? "decent-quality chances" : "a lot of speculative, low-quality attempts";
  const penText = pens.length ? ` ${penGoals} of ${pens.length} penalties went in.` : "";
  el.innerHTML = `<strong>${escapeHtml(who)} ${when}:</strong> ${goals.toLocaleString()} goals from ${xg.toLocaleString(undefined, { maximumFractionDigits: 1 })} xG. ${finishing} ` +
    `${pct(boxShare)} of the shots came from inside the box, but ${pct(boxGoals)} of the goals did. The average shot was worth ` +
    `${fmt(avgXg, 2)} xG, which points to ${quality}.${penText}`;
}

// ---------- territory ----------
function renderTerritory() {
  const svg = $("#territory-map");
  svg.innerHTML = "";
  svg.setAttribute("viewBox", "-2 -9 124 91");
  const { win, dropped } = DATA.touch_grid;
  const rows = win.length, cols = win[0].length;
  const zw = 120 / cols, zh = 80 / rows;
  const diff = win.map((row, r) => row.map((v, c) => v - dropped[r][c]));
  const diffLimit = Math.max(...diff.flat().map(Math.abs));
  const seqMax = Math.max(...win.flat(), ...dropped.flat());

  const zones = svgEl("g", {}, svg);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const value = state.territory === "diff" ? diff[r][c] : (state.territory === "win" ? win : dropped)[r][c];
      const fill = state.territory === "diff" ? diverging(value, diffLimit) : sequential(value, seqMax);
      const rect = svgEl("rect", { x: c * zw + 0.4, y: r * zh + 0.4, width: zw - 0.8, height: zh - 0.8, rx: 0.8, fill }, zones);
      rect.addEventListener("pointermove", (e) => showTooltip(e, "Pitch zone", [
        ["Share in wins", `${fmt(win[r][c], 2)}%`], ["Share when dropping points", `${fmt(dropped[r][c], 2)}%`],
        ["Difference", `${signed(diff[r][c], 2)} pts`],
      ]));
      rect.addEventListener("pointerleave", hideTooltip);
    }
  }

  const line = { fill: "none", stroke: css("--ink-2"), "stroke-width": 0.35, "stroke-opacity": 0.7 };
  const g = svgEl("g", { "pointer-events": "none" }, svg);
  svgEl("rect", { x: 0, y: 0, width: 120, height: 80, ...line }, g);
  svgEl("line", { x1: 60, x2: 60, y1: 0, y2: 80, ...line }, g);
  svgEl("circle", { cx: 60, cy: 40, r: 10, ...line }, g);
  for (const dir of [1, -1]) {
    svgEl("rect", { x: dir > 0 ? 0 : 102, y: 18, width: 18, height: 44, ...line }, g);
    svgEl("rect", { x: dir > 0 ? 0 : 114, y: 30, width: 6, height: 20, ...line }, g);
    svgEl("rect", { x: dir > 0 ? -1.5 : 120, y: 36, width: 1.5, height: 8, ...line }, g);
  }
  svgEl("line", { x1: 48, x2: 71, y1: -4.5, y2: -4.5, stroke: css("--ink-3"), "stroke-width": 0.4 }, svg);
  svgEl("path", { d: "M70,-6 L72.5,-4.5 L70,-3 Z", fill: css("--ink-3") }, svg);
  svgEl("text", { x: 60, y: -6.5, "text-anchor": "middle", style: "font-size:2.8px" }, svg).textContent = "Barça attacking direction";

  const legend = $("#territory-legend");
  legend.innerHTML = "";
  if (state.territory === "diff") {
    htmlEl("span", { text: "More when dropping points" }, legend);
    const stops = [-1, -0.5, 0, 0.5, 1].map((t) => diverging(t * diffLimit, diffLimit));
    htmlEl("span", { class: "bar", style: `background:linear-gradient(90deg,${stops.join(",")})` }, legend);
    htmlEl("span", { text: "More in wins" }, legend);
  } else {
    htmlEl("span", { text: "Less of the ball" }, legend);
    htmlEl("span", { class: "bar", style: `background:linear-gradient(90deg,${css("--seq-0")},${css("--seq-1")})` }, legend);
    htmlEl("span", { text: "More of the ball" }, legend);
  }
}

// ---------- model ----------
function renderModel() {
  const { scores, coefficients, matches } = DATA.model;
  const byName = Object.fromEntries(scores.map((s) => [s.model, s]));
  const full = byName["All stat differences + venue"], xgOnly = byName["xG difference only"], base = byName["Always predict the win rate"];
  const tiles = $("#model-tiles");
  tiles.innerHTML = "";
  tile(tiles, fmt(full.roc_auc, 2), "ROC AUC, full model (1.0 = perfect, 0.5 = guessing)", "highlight");
  tile(tiles, fmt(xgOnly.roc_auc, 2), "ROC AUC, xG difference only");
  tile(tiles, pct(full.accuracy), `accuracy (vs ${pct(base.accuracy)} for always predicting a win)`);
  tile(tiles, pct(1 - full.brier / base.brier), "less error than the base rate (Brier skill)");

  renderCoefficients(coefficients);
  renderCalibration(matches);
  renderSurprises(matches);
}

function renderCoefficients(coefficients) {
  const svg = $("#coef-chart");
  svg.innerHTML = "";
  const coefs = [...coefficients].sort((a, b) => b.coefficient - a.coefficient);
  const width = Math.max(260, svg.clientWidth || svg.parentNode.clientWidth - 36);
  const rowH = 40, top = 4, axisH = 26;
  const height = top + coefs.length * rowH + axisH;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const lo = Math.min(...coefs.map((c) => c.ci_low)), hi = Math.max(...coefs.map((c) => c.ci_high));
  const limit = Math.ceil(Math.max(Math.abs(lo), Math.abs(hi)) * 2) / 2;
  const x = (v) => 6 + ((v + limit) / (2 * limit)) * (width - 12);

  const grid = svgEl("g", { class: "grid" }, svg);
  for (const t of niceTicks(-limit, limit, 4)) {
    svgEl("line", { x1: x(t), x2: x(t), y1: top, y2: top + coefs.length * rowH, class: t === 0 ? "zero" : "" }, grid);
    svgEl("text", { x: x(t), y: height - 6, "text-anchor": "middle" }, svg).textContent = t === 0 ? "0" : signed(t, 1);
  }
  coefs.forEach((c, i) => {
    const y = top + i * rowH;
    const significant = c.ci_low > 0 || c.ci_high < 0;
    const color = significant ? (c.coefficient > 0 ? css("--pos") : css("--neg")) : css("--neutral");
    const g = svgEl("g", {}, svg);
    svgEl("text", { x: 6, y: y + 13, style: `fill:${css("--ink")}` }, g).textContent = c.label;
    svgEl("line", { x1: x(c.ci_low), x2: x(c.ci_high), y1: y + 27, y2: y + 27, stroke: color, "stroke-width": 2.5, "stroke-linecap": "round" }, g);
    svgEl("circle", { cx: x(c.coefficient), cy: y + 27, r: 5.5, fill: color, stroke: css("--surface"), "stroke-width": 2 }, g);
    const hit = svgEl("rect", { x: 0, y, width, height: rowH, fill: "transparent" }, g);
    hit.addEventListener("pointermove", (e) => showTooltip(e, c.label, [
      ["Coefficient", signed(c.coefficient, 2)], ["95% interval", `${signed(c.ci_low, 2)} to ${signed(c.ci_high, 2)}`],
      ["Odds multiplier per SD", `×${fmt(Math.exp(c.coefficient), 2)}`],
      ["Reading", significant ? (c.coefficient > 0 ? "Clearly helps" : "Clearly hurts") : "Not distinguishable from 0"],
    ]));
    hit.addEventListener("pointerleave", hideTooltip);
  });
}

function renderCalibration(matches) {
  const root = $("#calibration");
  root.innerHTML = "";
  const bins = [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 1.01]];
  const colors = { 1: css("--pos"), 0.5: css("--neutral"), 0: css("--neg") };
  for (const [lo, hi] of bins) {
    const games = matches.filter((m) => m.p_win >= lo && m.p_win < hi);
    if (!games.length) continue;
    const row = htmlEl("div", { class: "calibration-row" }, root);
    htmlEl("span", { text: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%` }, row);
    const stack = htmlEl("div", { class: "stack" }, row);
    for (const result of [1, 0.5, 0]) {
      const n = games.filter((m) => m.result === result).length;
      if (!n) continue;
      const seg = htmlEl("span", { style: `flex:${n};background:${colors[result]}` }, stack);
      const name = { 1: "Won", 0.5: "Drew", 0: "Lost" }[result];
      seg.addEventListener("pointermove", (e) => showTooltip(e, `Model said ${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}% chance of a win`, [
        [name, `${n} of ${games.length} (${pct(n / games.length)})`],
        ["Actual win rate", pct(games.filter((m) => m.result === 1).length / games.length)],
      ]));
      seg.addEventListener("pointerleave", hideTooltip);
    }
    htmlEl("span", { class: "n", text: games.length }, row);
  }
  $("#calibration-legend").innerHTML = `<span><span class="swatch" style="background:${colors[1]}"></span>Won</span>` +
    `<span><span class="swatch" style="background:${colors[0.5]}"></span>Drew</span>` +
    `<span><span class="swatch" style="background:${colors[0]}"></span>Lost</span><span>Right-hand number = matches in that band</span>`;
}

function whyDropped(m) {
  const reasons = [];
  if (m.xg - m.xg_opp >= 1) reasons.push(`out-created them by ${fmt(m.xg - m.xg_opp, 1)} xG but couldn't convert`);
  if (m.shots - m.shots_opp >= 10) reasons.push(`took ${m.shots - m.shots_opp} more shots`);
  if (m.pass_share >= 70) reasons.push(`had ${fmt(m.pass_share, 0)}% of the passes`);
  if (!reasons.length) reasons.push("edged most stat battles, but not by enough to show on the scoreboard");
  return reasons.slice(0, 2).join(" and ");
}

function whyWon(m) {
  const reasons = [];
  if (m.xg < m.xg_opp) reasons.push(`were out-created ${fmt(m.xg, 1)}–${fmt(m.xg_opp, 1)} on xG`);
  if (m.shots < m.shots_opp) reasons.push(`took fewer shots (${m.shots} vs ${m.shots_opp})`);
  if (m.pass_share < 55) reasons.push(`had only ${fmt(m.pass_share, 0)}% of the passes`);
  if (!reasons.length) reasons.push("were roughly level on the numbers");
  return reasons.slice(0, 2).join(" and ");
}

function renderSurpriseTable(selector, games, why) {
  const table = $(selector);
  table.innerHTML = `<thead><tr><th>Match</th><th class="n">P(win)</th><th>Why the stats got it wrong</th></tr></thead>`;
  const body = htmlEl("tbody", {}, table);
  for (const m of games) {
    const row = htmlEl("tr", {}, body);
    const cell = htmlEl("td", {}, row);
    htmlEl("span", { text: m.match }, cell);
    htmlEl("span", { class: "sub", text: `${m.season} · ${m.venue.toLowerCase()}` }, cell);
    htmlEl("td", { class: "n", text: pct(m.p_win) }, row);
    htmlEl("td", { text: `Barça ${why(m)}.` }, row);
  }
}

function renderSurprises(matches) {
  const dropped = matches.filter((m) => m.result < 1).sort((a, b) => b.p_win - a.p_win).slice(0, 5);
  const wins = matches.filter((m) => m.result === 1).sort((a, b) => a.p_win - b.p_win).slice(0, 5);
  renderSurpriseTable("#surprise-dropped", dropped, whyDropped);
  renderSurpriseTable("#surprise-wins", wins, whyWon);
}

// ---------- wiring ----------
function renderAll() {
  renderSummary();
  renderHeatmap();
  renderCorrTable();
  renderDistribution();
  renderShotMap();
  renderTerritory();
  renderModel();
}

function wireControls() {
  segmented($("#side-filter"), (v) => { state.side = v; state.player = "all"; populatePlayerFilter(); renderShotMap(); });
  $("#season-filter").addEventListener("change", (e) => { state.season = e.target.value; populatePlayerFilter(); renderShotMap(); });
  $("#player-filter").addEventListener("change", (e) => { state.player = e.target.value; renderShotMap(); });
  segmented($("#outcome-filter"), (v) => { state.outcome = v; renderShotMap(); });
  segmented($("#territory-view"), (v) => { state.territory = v; renderTerritory(); });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderDistribution(); renderModel(); }, 150);
  });
}

fetch("data/site.json")
  .then((r) => r.json())
  .then((data) => {
    DATA = data;
    SHOTS = decodeShots(data.shots);
    populateShotFilters();
    wireControls();
    renderAll();
  })
  .catch((err) => {
    document.querySelector("main").insertAdjacentHTML("afterbegin",
      `<p class="note">Couldn't load the data (${escapeHtml(err.message)}). If you opened this file directly, serve the folder instead: <code>python -m http.server -d docs</code>.</p>`);
  });
