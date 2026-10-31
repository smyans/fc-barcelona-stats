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

function niceTicks(min, max, count) {
  const span = max - min || 1;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || mag * 10;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}
const formatTick = (v) => (Math.abs(v) >= 10 ? fmt(v, 0) : Math.abs(v) >= 1 ? fmt(v, 1) : fmt(v, 2));
