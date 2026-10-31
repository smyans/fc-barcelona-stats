"use strict";

// Uses helpers from common.js ($, svgEl, htmlEl, css, fmt, signed, pct, diverging, showTooltip, tile, niceTicks).

let NOW;
const live = { fixture: 0, minute: 0, goalsB: 0, goalsO: 0, redsB: 0, redsO: 0 };
const OUTCOMES = [["win", "Barça win"], ["draw", "Draw"], ["loss", "Barça lose"]];
const outcomeColor = (key) => ({ win: css("--pos"), draw: css("--neutral"), loss: css("--neg") }[key]);
const evidence = (p) => Math.min(1, -Math.log10(Math.max(p, 1e-12)) / 3);
const DIFF_RANGE = 12;

function formatDate(iso, time) {
  const d = new Date(`${iso}T12:00:00`);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return time ? `${day}, ${time}` : day;
}

// ---------- live model (same as barca_stats/inplay.py: live_probs_dp) ----------
function liveProbs(fx, minute, goalsB, goalsO, redsB, redsO) {
  const m = NOW.live_model;
  const { own, opponent } = m.red;
  const lamB = fx.lam_barca * own ** redsB * opponent ** redsO;
  const lamO = fx.lam_opponent * own ** redsO * opponent ** redsB;
  const size = 2 * DIFF_RANGE + 1;
  let dist = new Float64Array(size);
  dist[Math.max(-DIFF_RANGE, Math.min(DIFF_RANGE, goalsB - goalsO)) + DIFF_RANGE] = 1;
  const multFor = (d) => (d < 0 ? m.state.trailing : d === 0 ? m.state.level : m.state.leading);
  const last = m.cdf.length - 1;
  for (let t = Math.min(minute, last); t < last; t++) {
    const share = m.cdf[t + 1] - m.cdf[t];
    if (share <= 0) continue;
    const next = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      if (!dist[i]) continue;
      const d = i - DIFF_RANGE;
      const pB = 1 - Math.exp(-lamB * share * multFor(d));
      const pO = 1 - Math.exp(-lamO * share * multFor(-d));
      const up = pB * (1 - pO), down = pO * (1 - pB);
      next[i] += dist[i] * (1 - up - down);
      if (i + 1 < size) next[i + 1] += dist[i] * up;
      if (i > 0) next[i - 1] += dist[i] * down;
    }
    dist = next;
  }
  let win = 0, draw = 0, loss = 0;
  dist.forEach((p, i) => { if (i > DIFF_RANGE) win += p; else if (i === DIFF_RANGE) draw += p; else loss += p; });
  return { win, draw, loss };
}

function outcomeTiles(root, probs, compare) {
  root.innerHTML = "";
  for (const [key, label] of OUTCOMES) {
    const t = htmlEl("div", { class: "outcome", style: `--accent:${outcomeColor(key)}` }, root);
    htmlEl("div", { class: "value", text: pct(probs[key]) }, t);
    htmlEl("div", { class: "label", text: label }, t);
    if (compare) htmlEl("div", { class: "sub", text: `Bookmakers: ${pct(compare[key])}` }, t);
  }
}

function stackedBar(root, probs, label) {
  const row = htmlEl("div", { class: "prob-row" }, root);
  htmlEl("span", { class: "prob-label", text: label }, row);
  const bar = htmlEl("div", { class: "prob-bar" }, row);
  for (const [key, name] of OUTCOMES) {
    const seg = htmlEl("span", { style: `flex:${probs[key]};background:${outcomeColor(key)}` }, bar);
    seg.addEventListener("pointermove", (e) => showTooltip(e, `${label}: ${name}`, [["Chance", pct(probs[key], 1)]]));
    seg.addEventListener("pointerleave", hideTooltip);
  }
}

// ---------- hero + next match ----------
function renderHero() {
  $("#data-through").textContent = `results through ${formatDate(NOW.data_through)}`;
  $("#generated").textContent = `Updated ${NOW.generated}`;
  const seasons = NOW.seasons;
  const games = sum(seasons, (s) => s.games), points = sum(seasons, (s) => s.points), expected = sum(seasons, (s) => s.expected);
  const root = $("#hero-tiles");
  root.innerHTML = "";
  const fx = NOW.fixtures[0];
  if (fx) tile(root, pct(fx.model.win), `chance Barça beat ${fx.opponent} next`, "highlight");
  tile(root, games, "league games since 2023/24");
  tile(root, `${points}`, `points (odds expected ${Math.round(expected)})`);
  tile(root, signed(points - expected, 0), "points above expectations");
}

function renderNext() {
  const fx = NOW.fixtures[0];
  if (!fx) {
    $("#next-title").textContent = "Next match";
    $("#next-sub").textContent = "No upcoming Barça league fixture is listed yet. Re-run the pipeline after fixtures are published.";
    return;
  }
  const venue = fx.venue === "Home" ? "at home" : "away";
  $("#next-title").textContent = fx.venue === "Home" ? `Next: Barcelona vs ${fx.opponent}` : `Next: ${fx.opponent} vs Barcelona`;
  $("#next-sub").textContent = `${formatDate(fx.date, fx.time)} · La Liga · Barça ${venue}`;
  outcomeTiles($("#next-model"), fx.model, fx.market);
  const compare = $("#next-compare");
  compare.innerHTML = "";
  stackedBar(compare, fx.model, "Our model");
  if (fx.market) stackedBar(compare, fx.market, "Bookmakers");

  $("#next-xg").textContent = `Expected goals: Barça ${fmt(fx.lam_barca, 1)}, ${fx.opponent} ${fmt(fx.lam_opponent, 1)}.`;
  const table = $("#next-scores");
  table.innerHTML = `<thead><tr><th>Score (Barça first)</th><th class="n">Chance</th></tr></thead>`;
  const body = htmlEl("tbody", {}, table);
  for (const s of fx.likely_scores) {
    const row = htmlEl("tr", {}, body);
    htmlEl("td", { text: `${s.barca}–${s.opponent}` }, row);
    htmlEl("td", { class: "n", text: pct(s.p, 1) }, row);
  }

  const eloGap = fx.elo_barca - fx.elo_opponent;
  const diff = fx.market ? fx.model.win - fx.market.win : 0;
  const agree = !fx.market ? "" : Math.abs(diff) < 0.03
    ? `The bookmakers agree almost exactly (${pct(fx.market.win)} for a Barça win).`
    : `The bookmakers are ${diff > 0 ? "a little less" : "a little more"} confident (${pct(fx.market.win)} for a Barça win). ` +
      `They know about injuries and line-ups; this model doesn't.`;
  const topScore = fx.likely_scores[0];
  $("#next-analysis").innerHTML = `
    <h3>Why the model thinks this</h3>
    <p>Barça's rating is ${Math.round(eloGap)} Elo points above ${escapeHtml(fx.opponent)}'s${fx.venue === "Home" ? ", before home advantage" : ""}.
      In rating terms that's ${eloGap > 250 ? "a mismatch" : eloGap > 120 ? "a clear gap" : "a fairly even contest"}.
      Recent form adds to it: over the last six league games Barça scored ${fmt(fx.form.barca_gf, 1)} and conceded ${fmt(fx.form.barca_ga, 1)} a game,
      against ${fmt(fx.form.opp_gf, 1)} and ${fmt(fx.form.opp_ga, 1)} for ${escapeHtml(fx.opponent)}. ${agree}</p>
    <p>Even so, the single most likely score (${topScore.barca}–${topScore.opponent}) happens only ${pct(topScore.p)} of the time. Football is
      low-scoring, so even this favourite would drop points in about one game in ${Math.max(2, Math.round(1 / (1 - fx.model.win)))} like this.
      Use the live predictor below to follow it as it happens.</p>`;
}

// ---------- live predictor ----------
function populateLiveFixtures() {
  const select = $("#live-fixture");
  select.innerHTML = NOW.fixtures.map((fx, i) =>
    `<option value="${i}">${fx.venue === "Home" ? `Barcelona vs ${escapeHtml(fx.opponent)}` : `${escapeHtml(fx.opponent)} vs Barcelona`} · ${formatDate(fx.date)}</option>`).join("");
  select.addEventListener("change", (e) => { live.fixture = Number(e.target.value); renderLive(); });
}

function renderLive() {
  const fx = NOW.fixtures[live.fixture];
  if (!fx) { $("#live").hidden = true; return; }
  $("#opp-name-goals").textContent = fx.opponent;
  $("#opp-name-reds").textContent = fx.opponent;
  $("#minute-value").textContent = live.minute === 45 ? "45' (half-time)" : live.minute > 90 ? `90+${live.minute - 90}'` : `${live.minute}'`;
  for (const el of document.querySelectorAll(".stepper")) el.querySelector("b").textContent = live[el.dataset.key];

  const kickoff = live.minute === 0 && !live.goalsB && !live.goalsO && !live.redsB && !live.redsO;
  const probs = kickoff ? fx.model : liveProbs(fx, live.minute, live.goalsB, live.goalsO, live.redsB, live.redsO);
  outcomeTiles($("#live-probs"), probs);
  const pre = fx.model;
  $("#live-caption").textContent = kickoff
    ? `This is the pre-match forecast. Move the minute or change the score to update it.`
    : `Barça win chance: ${pct(pre.win)} before kick-off → ${pct(probs.win)} now (${signed((probs.win - pre.win) * 100, 0)} points).`;
  renderLiveChart(fx, probs);
}

function renderLiveChart(fx, current) {
  const svg = $("#live-chart");
  svg.innerHTML = "";
  const width = Math.max(260, svg.clientWidth || svg.parentNode.clientWidth - 36);
  const height = 190, left = 36, right = 12, top = 10, bottom = 24;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const end = 95;
  const start = Math.min(live.minute, end - 1);
  const series = [];
  for (let t = start; t <= end; t++) {
    series.push({ t, ...(t === live.minute ? current : liveProbs(fx, t, live.goalsB, live.goalsO, live.redsB, live.redsO)) });
  }
  const x = (t) => left + ((t - start) / (end - start)) * (width - left - right);
  const y = (p) => top + (1 - p) * (height - top - bottom);
  const grid = svgEl("g", { class: "grid" }, svg);
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    svgEl("line", { x1: left, x2: width - right, y1: y(p), y2: y(p) }, grid);
    svgEl("text", { x: left - 6, y: y(p) + 4, "text-anchor": "end" }, svg).textContent = pct(p);
  }
  for (const t of niceTicks(start, end, 5)) {
    svgEl("text", { x: x(t), y: height - 6, "text-anchor": "middle" }, svg).textContent = `${t}'`;
  }
  for (const [key] of OUTCOMES) {
    const d = series.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join("");
    svgEl("path", { d, fill: "none", stroke: outcomeColor(key), "stroke-width": 2.2, "stroke-linejoin": "round" }, svg);
  }
  const marker = svgEl("line", { y1: top, y2: height - bottom, stroke: css("--ink-3"), "stroke-dasharray": "3 3", visibility: "hidden" }, svg);
  const hit = svgEl("rect", { x: left, y: top, width: width - left - right, height: height - top - bottom, fill: "transparent" }, svg);
  hit.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const t = Math.round(start + ((e.clientX - box.left) / box.width * width - left) / (width - left - right) * (end - start));
    const s = series.find((p) => p.t === Math.max(start, Math.min(end, t)));
    if (!s) return;
    marker.setAttribute("x1", x(s.t)); marker.setAttribute("x2", x(s.t)); marker.setAttribute("visibility", "visible");
    showTooltip(e, `If it's still ${live.goalsB}–${live.goalsO} at ${s.t}'`, OUTCOMES.map(([k, n]) => [n, pct(s[k])]));
  });
  hit.addEventListener("pointerleave", () => { marker.setAttribute("visibility", "hidden"); hideTooltip(); });
  $("#live-legend").innerHTML = OUTCOMES.map(([k, n]) => `<span><span class="swatch" style="background:${outcomeColor(k)}"></span>${n}</span>`).join("");
}

function wireLive() {
  $("#minute").addEventListener("input", (e) => { live.minute = Number(e.target.value); renderLive(); });
  for (const el of document.querySelectorAll(".stepper")) {
    el.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;
      const key = el.dataset.key;
      const max = key.startsWith("reds") ? 3 : 12;
      live[key] = Math.max(0, Math.min(max, live[key] + Number(button.dataset.step)));
      renderLive();
    });
  }
  $("#live-reset").addEventListener("click", () => {
    Object.assign(live, { minute: 0, goalsB: 0, goalsO: 0, redsB: 0, redsO: 0 });
    $("#minute").value = 0;
    renderLive();
  });
}

// ---------- what's driving results ----------
function renderSeasons() {
  const root = $("#season-bars");
  root.innerHTML = "";
  const max = Math.max(...NOW.seasons.map((s) => Math.max(s.points, s.expected)));
  for (const s of NOW.seasons) {
    const row = htmlEl("div", { class: "season-row" }, root);
    htmlEl("span", { class: "prob-label", text: `${s.season}${s.games < 38 ? ` (${s.games} games)` : ""}` }, row);
    const bars = htmlEl("div", { class: "season-bars" }, row);
    htmlEl("span", { class: "bar actual", style: `width:${(s.points / max) * 100}%` }, bars);
    htmlEl("span", { class: "bar expected", style: `width:${(s.expected / max) * 100}%` }, bars);
    htmlEl("span", { class: "n", text: `${s.points} vs ${Math.round(s.expected)} (${signed(s.points - s.expected, 0)})` }, row);
    row.addEventListener("pointermove", (e) => showTooltip(e, s.season, [["Points", s.points], ["Odds expected", fmt(s.expected, 1)],
      ["Difference", signed(s.points - s.expected, 1)], ["Games", s.games]]));
    row.addEventListener("pointerleave", hideTooltip);
  }
  htmlEl("div", { class: "legend", html: `<span><span class="swatch" style="background:${css("--pos")}"></span>Actual points</span>` +
    `<span><span class="swatch" style="background:${css("--neutral")}"></span>Expected from the odds</span>` }, root);
}

function renderSurpriseBars() {
  const root = $("#surprise-bars");
  root.innerHTML = "";
  const rows = [...NOW.surprises].sort((a, b) => b.rho - a.rho);
  const limit = 0.3;
  for (const s of rows) {
    const row = htmlEl("div", { class: "rho-row" }, root);
    htmlEl("span", { class: "prob-label", text: s.label }, row);
    const track = htmlEl("div", { class: "rho-track" }, row);
    const width = Math.min(Math.abs(s.rho), limit) / limit * 50;
    const color = diverging(Math.sign(s.rho) * evidence(s.p_adjusted), 1);
    htmlEl("span", { class: "rho-bar", style: `background:${color};width:${width}%;${s.rho >= 0 ? "left:50%" : `left:${50 - width}%`}` }, track);
    htmlEl("span", { class: "rho-tick", style: `left:${50 + Math.max(-1, Math.min(1, s.league_rho / limit)) * 50}%` }, track);
    row.addEventListener("pointermove", (e) => showTooltip(e, s.label, [
      ["Barça ρ", signed(s.rho, 2)], ["Adjusted p (Barça)", s.p_adjusted < 0.001 ? "< 0.001" : fmt(s.p_adjusted, 2)],
      ["All La Liga ρ", signed(s.league_rho, 2)], ["Significant league-wide", s.league_significant ? "Yes" : "No"],
    ]));
    row.addEventListener("pointerleave", hideTooltip);
  }
  const axis = htmlEl("div", { class: "rho-axis" }, root);
  htmlEl("span", { text: "← fewer points than expected" }, axis);
  htmlEl("span", { text: "more points than expected →" }, axis);
}

function renderSplits() {
  const root = $("#split-cards");
  root.innerHTML = "";
  const pairs = [[0, 1, "Fouls committed"], [2, 3, "Corners won (Barça)"], [4, 5, "Corners won (every other team)"]];
  for (const [a, b, title] of pairs) {
    const card = htmlEl("div", { class: "card split-card" }, root);
    htmlEl("h3", { text: title }, card);
    for (const s of [NOW.splits[a], NOW.splits[b]]) {
      const row = htmlEl("div", { class: "split-row" }, card);
      htmlEl("span", { text: s.label.replace(/^(Barça|Other teams) with /, "") }, row);
      htmlEl("b", { class: s.above >= 0 ? "delta-pos" : "delta-neg", text: `${signed(s.above, 2)} pts/game` }, row);
      htmlEl("span", { class: "sub", text: `${s.games.toLocaleString()} games` }, row);
    }
  }
}

function renderDriversAnalysis() {
  const sp = Object.fromEntries(NOW.splits.map((s) => [s.label, s]));
  const fouls12 = sp["Barça with 12+ fouls committed"], fouls7 = sp["Barça with 7 or fewer fouls"];
  const lc9 = sp["Other teams with 9+ corners"], lc4 = sp["Other teams with 4 or fewer corners"];
  const total = NOW.seasons.reduce((t, s) => t + s.points - s.expected, 0);
  const by = Object.fromEntries(NOW.surprises.map((s) => [s.stat, s]));
  $("#drivers-analysis").innerHTML = `
    <h3>Barça keep beating the odds</h3>
    <p>Since 2023/24 Barça have taken ${Math.round(total)} more points than the pre-match odds implied, and they've beaten expectations in every
      season. The market has consistently underrated them. The model on this page makes the same mistake unless it's told Barça games have more goals than ratings predict.</p>
    <h3>The unlikely one: Barça do better when they foul more</h3>
    <p>With 12 or more fouls committed, Barça beat the odds by ${signed(fouls12.above, 2)} points a game (${fouls12.games} games). With 7 or fewer,
      they fell ${fmt(Math.abs(fouls7.above), 2)} short (${fouls7.games} games). It isn't that fouling wins games. More likely, a Barça side that presses
      high and breaks up counter-attacks with a tactical foul is a Barça side that's in control. A passive Barça that lets opponents run doesn't foul,
      and that's the version that drops points. Across every La Liga team the same link exists but is weaker
      (ρ = ${signed(by.fouls.league_rho, 2)}), so it's partly a Barça trait.</p>
    <h3>The corner paradox</h3>
    <p>Across La Liga, teams that win 9 or more corners take ${fmt(Math.abs(lc9.above), 2)} fewer points than the odds expected
      (${lc9.games.toLocaleString()} games), while teams with 4 or fewer slightly beat expectations. Corners pile up when a team is camped around a
      deep defence and can't get through, the same pattern the <a href="index.html#territory">Messi-era territory map</a> found. For Barça the effect points the
      same way (ρ = ${signed(by.corners.rho, 2)}) but is smaller in raw averages.</p>
    <h3>What doesn't matter</h3>
    <p>Kickoff time, days of rest since the last league game, and yellow cards show no meaningful link with beating or missing expectations.
      Barça's results don't hinge on a 2 p.m. kickoff or a short turnaround (though midweek Champions League games aren't in this data).</p>
    <p class="note">How sure is this? For Barça alone (124 games) none of these patterns clears the strict multiple-testing bar; the strongest have
      adjusted p ≈ 0.08. The corners and fouls links do hold up across all La Liga teams (2,478 team-games), which is why they're worth taking seriously.</p>`;
}

// ---------- recent games ----------
function describeStandout(s) {
  const higher = s.z > 0;
  const fmtVal = (v) => (Number.isInteger(v) ? v : fmt(v, 0));
  if (s.stat === "rest") return `${fmtVal(s.value)} days since the last league game (usual ${fmt(s.typical, 0)})`;
  if (s.stat === "kickoff_hour") return `${fmtVal(s.value)}:00 kickoff (${higher ? "later" : "earlier"} than usual)`;
  let label = s.label.toLowerCase();
  if (s.value === 1) label = label.replace(/\b(cards|corners|shots|fouls)\b/, (w) => w.slice(0, -1));
  return `${fmtVal(s.value)} ${label} (usual ${fmt(s.typical, 1)})`;
}

function renderRecent() {
  const root = $("#recent-list");
  root.innerHTML = "";
  for (const g of [...NOW.recent_games].reverse()) {
    const above = g.points - g.expected_points;
    const card = htmlEl("div", { class: "recent-card" }, root);
    const head = htmlEl("div", { class: "recent-head" }, card);
    htmlEl("span", { class: `result-pill r${g.points}`, text: g.points === 3 ? "W" : g.points === 1 ? "D" : "L" }, head);
    htmlEl("b", { text: `${g.home ? "vs" : "at"} ${g.opponent} ${g.score}` }, head);
    htmlEl("span", { class: "sub", text: formatDate(g.date) }, head);
    const meta = htmlEl("div", { class: "recent-meta" }, card);
    htmlEl("span", { text: `Pre-match win chance ${pct(g.p_win)}` }, meta);
    htmlEl("span", { class: above >= 0 ? "delta-pos" : "delta-neg", text: `${signed(above, 1)} pts vs odds` }, meta);
    if (g.xg !== null) htmlEl("span", { text: `xG ${fmt(g.xg, 1)}–${fmt(g.xg_against, 1)}` }, meta);
    const list = htmlEl("ul", { class: "standouts" }, card);
    if (!g.standouts.length) htmlEl("li", { text: "Nothing unusual: a typical Barça game on these stats." }, list);
    for (const s of g.standouts) htmlEl("li", { text: describeStandout(s) }, list);
  }
}

// ---------- trust ----------
function renderTrust() {
  const b = NOW.backtest;
  const root = $("#trust-tiles");
  root.innerHTML = "";
  tile(root, pct(b.share_of_market_edge), "of the bookmakers' edge over guessing", "highlight");
  tile(root, pct(b.accuracy.model), `picks the right result (bookmakers ${pct(b.accuracy.market)})`);
  tile(root, pct(b.barca_accuracy.model), `right in Barça games (bookmakers ${pct(b.barca_accuracy.market)})`);
  tile(root, b.matches.toLocaleString(), "matches tested, 2023/24 to now");

  renderCalibration();
  renderMinuteChart();

  const c = NOW.inplay_checks;
  $("#trust-analysis").innerHTML = `
    <h3>Close to the bookmakers, not better</h3>
    <p>Before kick-off the model's error (log loss) is ${fmt(b.log_loss.model, 3)}, against ${fmt(b.log_loss.market, 3)} for the bookmakers and
      ${fmt(b.log_loss.base, 3)} for always guessing the league's usual home/draw/away split. So it captures ${pct(b.share_of_market_edge)} of what the
      bookmakers know. The gap is the information that isn't in results data: injuries, rotation, line-ups and the weight of money.</p>
    <h3>The live model earns its keep</h3>
    <p>Knowing the half-time score cuts the error from ${fmt(c.league_pre, 3)} to ${fmt(c.league_ht, 3)} across the league, and from
      ${fmt(c.barca_pre, 3)} to ${fmt(c.barca_ht, 3)} in Barça games. Getting there took two corrections, both checked on matches the fixes weren't fitted on:
      goals cluster late in games, and Barça games have more goals than ratings predict. Without the second one, the model wrote off Barça far too early when they were behind.</p>`;
}

function renderCalibration() {
  const svg = $("#calibration-chart");
  svg.innerHTML = "";
  const size = Math.max(240, Math.min(420, svg.clientWidth || svg.parentNode.clientWidth - 36));
  const pad = 34;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const s = (v) => pad + v * (size - pad - 10);
  const yv = (v) => size - pad - v * (size - pad - 10);
  const grid = svgEl("g", { class: "grid" }, svg);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    svgEl("line", { x1: s(t), x2: s(t), y1: yv(0), y2: yv(1) }, grid);
    svgEl("line", { x1: s(0), x2: s(1), y1: yv(t), y2: yv(t) }, grid);
    svgEl("text", { x: s(t), y: size - 12, "text-anchor": "middle" }, svg).textContent = pct(t);
    svgEl("text", { x: pad - 6, y: yv(t) + 4, "text-anchor": "end" }, svg).textContent = pct(t);
  }
  svgEl("line", { x1: s(0), y1: yv(0), x2: s(1), y2: yv(1), stroke: css("--ink-3"), "stroke-dasharray": "4 3" }, svg);
  const maxN = Math.max(...NOW.calibration.map((c) => c.n));
  for (const c of NOW.calibration) {
    const dot = svgEl("circle", { cx: s(c.predicted), cy: yv(c.actual), r: 4 + 7 * Math.sqrt(c.n / maxN),
      fill: css("--pos"), "fill-opacity": 0.85, stroke: css("--surface"), "stroke-width": 1.5 }, svg);
    dot.addEventListener("pointermove", (e) => showTooltip(e, `Forecasts around ${pct(c.predicted)}`, [
      ["Happened", pct(c.actual)], ["Forecasts", c.n.toLocaleString()]]));
    dot.addEventListener("pointerleave", hideTooltip);
  }
}

function renderMinuteChart() {
  const svg = $("#minute-chart");
  svg.innerHTML = "";
  const data = NOW.inplay_checks.by_minute;
  const width = Math.max(260, svg.clientWidth || svg.parentNode.clientWidth - 36);
  const height = 200, left = 40, right = 14, top = 12, bottom = 26;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const pts = data;
  const maxY = Math.ceil(Math.max(...pts.map((d) => d.log_loss)) * 10) / 10;
  const x = (m) => left + (m / 90) * (width - left - right);
  const y = (v) => top + (1 - v / maxY) * (height - top - bottom);
  const grid = svgEl("g", { class: "grid" }, svg);
  for (const t of niceTicks(0, maxY, 4)) {
    svgEl("line", { x1: left, x2: width - right, y1: y(t), y2: y(t) }, grid);
    svgEl("text", { x: left - 6, y: y(t) + 4, "text-anchor": "end" }, svg).textContent = fmt(t, 1);
  }
  for (const m of [0, 15, 30, 45, 60, 75, 90]) svgEl("text", { x: x(m), y: height - 8, "text-anchor": "middle" }, svg).textContent = `${m}'`;
  svgEl("path", { d: pts.map((d, i) => `${i ? "L" : "M"}${x(d.minute)},${y(d.log_loss)}`).join(""), fill: "none", stroke: css("--pos"), "stroke-width": 2.2 }, svg);
  for (const d of pts) {
    const dot = svgEl("circle", { cx: x(d.minute), cy: y(d.log_loss), r: 4.5, fill: css("--pos"), stroke: css("--surface"), "stroke-width": 1.5 }, svg);
    dot.addEventListener("pointermove", (e) => showTooltip(e, d.minute === 0 ? "Before kick-off" : `At ${d.minute}'`, [["Log loss", fmt(d.log_loss, 3)]]));
    dot.addEventListener("pointerleave", hideTooltip);
  }
}

// ---------- wiring ----------
function renderAll() {
  renderHero();
  renderNext();
  renderLive();
  renderSeasons();
  renderSurpriseBars();
  renderSplits();
  renderDriversAnalysis();
  renderRecent();
  renderTrust();
}

fetch("data/now.json")
  .then((r) => r.json())
  .then((data) => {
    NOW = data;
    populateLiveFixtures();
    wireLive();
    renderAll();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
    let lastWidth = window.innerWidth;
    window.addEventListener("resize", () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      renderLive(); renderTrust();
    });
  })
  .catch((err) => {
    document.querySelector("main").insertAdjacentHTML("afterbegin",
      `<p class="note">Couldn't load the data (${escapeHtml(err.message)}). Serve the folder instead: <code>python -m http.server -d docs</code>.</p>`);
  });
