// ── Matiere HUB — iOS home-screen widget (Scriptable) ───────────────────────
// Shows: Hours this week · Cash in (30d) · Net profit (30d)
// Reads live from Supabase (read-only anon key). Best as a MEDIUM widget.

const SB  = "https://nwpzjqblhywclqharggu.supabase.co/rest/v1";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im53cHpqcWJsaHl3Y2xxaGFyZ2d1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MTQ2NjcsImV4cCI6MjA5NjI5MDY2N30.XYgfk5jriDpZVXFW6xkWh-hyaYLsP6ZKpInTMXqk9tc";

// ── helpers ─────────────────────────────────────────────────────────────────
function ymd(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
async function sb(path){
  const r = new Request(SB + path);
  r.headers = { apikey: KEY, Authorization: "Bearer " + KEY };
  return await r.loadJSON();
}
const money = n => "$" + Math.round(n).toLocaleString("en-AU");

// ── date ranges ─────────────────────────────────────────────────────────────
const now = new Date();
const dow = (now.getDay() + 6) % 7;              // 0 = Monday
const monday = new Date(now); monday.setDate(now.getDate() - dow); monday.setHours(0,0,0,0);
const d30 = new Date(); d30.setDate(d30.getDate() - 30);

// ── fetch + compute ─────────────────────────────────────────────────────────
let hours = 0, cashIn = 0, net = 0, ok = true;
try {
  const ts = await sb(`/timesheets?select=hours&date=gte.${ymd(monday)}`);
  hours = ts.reduce((s,r) => s + (Number(r.hours)||0), 0);

  const bt = await sb(`/bank_transactions?select=debit,credit&date=gte.${ymd(d30)}`);
  let out = 0;
  for (const r of bt){ cashIn += Number(r.credit)||0; out += Number(r.debit)||0; }
  net = cashIn - out;
} catch(e){ ok = false; }

// ── colours (match HUB) ─────────────────────────────────────────────────────
const AMBER = new Color("#ffb000");
const GREEN = new Color("#39d98a");
const RED   = new Color("#ff5d5d");
const INK   = new Color("#f2f2f2");
const MUTE  = new Color("#8a8a8a");

// ── build widget ────────────────────────────────────────────────────────────
const w = new ListWidget();
const g = new LinearGradient();
g.colors = [new Color("#1c1c1c"), new Color("#0d0d0d")];
g.locations = [0, 1];
w.backgroundGradient = g;
w.setPadding(16, 18, 16, 18);

// header row: title left, updated time right
const top = w.addStack();
top.centerAlignContent();
const dot = top.addText("●");
dot.font = Font.boldSystemFont(10);
dot.textColor = AMBER;
top.addSpacer(6);
const title = top.addText("MATIERE HUB");
title.font = Font.boldSystemFont(12);
title.textColor = INK;
top.addSpacer();
const upd = top.addText(now.toLocaleTimeString("en-AU",{hour:"2-digit",minute:"2-digit"}));
upd.font = Font.systemFont(10);
upd.textColor = MUTE;

w.addSpacer();   // flexible space pushes stats to vertical centre

// stat block helper (value over label)
function stat(parent, value, label, color, big){
  const c = parent.addStack();
  c.layoutVertically();
  const v = c.addText(value);
  v.font = Font.boldSystemFont(big ? 44 : 23);
  v.textColor = color;
  v.minimumScaleFactor = 0.5;
  v.lineLimit = 1;
  c.addSpacer(big ? 6 : 3);
  const l = c.addText(label.toUpperCase());
  l.font = Font.mediumSystemFont(big ? 11 : 9);
  l.textColor = MUTE;
  l.lineLimit = 1;
}

if (ok){
  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  // left: hours, large
  stat(row, hours.toFixed(1) + "h", "Hours · week", AMBER, true);

  row.addSpacer();

  // right: two dollar figures stacked
  const right = row.addStack();
  right.layoutVertically();
  stat(right, money(cashIn), "Cash in · 30d", GREEN, false);
  right.addSpacer(12);
  stat(right, money(net), "Net · 30d", net >= 0 ? GREEN : RED, false);
} else {
  const e = w.addText("Couldn't load data");
  e.font = Font.systemFont(14); e.textColor = RED;
}

w.addSpacer();   // balances the centre

// refresh roughly every 30 min
w.refreshAfterDate = new Date(Date.now() + 30*60*1000);

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  w.presentMedium();
}
Script.complete();
