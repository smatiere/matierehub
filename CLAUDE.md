# MatiereHub — Claude Context File

Read this at the start of every session before making any changes.

---

## What this is

A single-page business operating system for **Matiere Pty Ltd**, a carpentry and handyman business on the Northern Beaches of Sydney, owned by Sebastien Benoit.

- Live URL: **https://matierehub2.netlify.app**
- GitHub repo: **smatiere/matierehub** (branch: `main`)
- Netlify auto-deploys on every push to `main`
- Claude chat is the primary interface for all data entry

---

## File map

| File | Purpose |
|------|---------|
| `index.html` | The entire front-end — all tabs, charts, CSS, JS in one file |
| `data.json` | The database — all live business data, read by the front-end and updated by the Netlify function |
| `netlify/functions/claude-parse.js` | Parses natural language input via Claude Haiku API, writes updates back to `data.json` via GitHub API |
| `netlify/functions/xero-sync.js` | Syncs financial data from Xero into `data.json` |
| `netlify.toml` | Netlify build config |
| `BUGS.md` | Known issues tracker — check before suggesting fixes |
| `DECISIONS.md` | Architectural decisions log — check before suggesting alternatives |

---

## data.json schema

```
{
  meta: { last_updated, source, invoice_count, bank_tx_count }
  kpis: { fy26_revenue, fy26_materials, fy26_gross_profit, fy26_gp_margin, fy26_opex }
  monthly: { labels[], periods[], revenue[], materials[], wages_owner[] }
  open_invoices: [{ invoice, contact, date, amount, days_old }]   ← days_old is STALE, computed dynamically in browser
  top_customers: [{ name, revenue, invoices }]
  quotes: [{ number, contact, date, status, total, line_items[] }]
  projects: [{ name, status, quoted, notes }]
  timesheets: [{ id, date, project, hours, rate, value, employee, notes }]
  expense_log: [{ date, description, category, project, amount }]
  fy_summary: { fy24: {}, fy25: {}, fy26: {} }
  cost_detail_monthly: { [category]: [monthly values] }
  account_categories: { [category]: [monthly values] }
}
```

**Important:** `expense_log` only contains entries logged via Claude chat. It does NOT contain the 1,046 Xero transactions — those feed `monthly` and `cost_detail_monthly` via xero-sync.

---

## Active projects (as of June 2026)

- Mark - Nth Balgowlah
- Rob - Balgowlah
- IBK - Mosman
- Neil - Balgowlah
- Admin (non-billable)

Seb's hourly rate: **$100/hr ex GST**

---

## How data entry works

1. User types or speaks into the Claude bar at the bottom of `index.html`
2. `claudeBarSend()` POSTs text to `/.netlify/functions/claude-parse`
3. The function calls **Claude Haiku** to parse the natural language into a JSON action
4. The function applies the action to `data.json` and pushes back to GitHub via the GitHub API
5. The front-end does an optimistic in-memory update (no re-fetch needed)

---

## Environment variables (set in Netlify dashboard)

- `ANTHROPIC_API_KEY` — Claude API key
- `GITHUB_TOKEN` — GitHub personal access token with `repo` scope

---

## What has been tried and FAILED — do not retry

- **Google Sheets row-level writing** via Drive connector — connector can only create new files, cannot append rows
- **Netlify serverless functions for Xero OAuth write bridge** — failed due to ES module/CommonJS conflicts and GitHub folder upload limitations
- **Google Apps Script web endpoints** — robots.txt blocks Claude from fetching script.google.com
- **Airtable** — not pursued, no paid subscriptions

---

## Key constraints

- No paid subscriptions beyond existing Claude Pro
- Seb is not a developer — keep everything simple and explainable
- Accountant has separate Xero access — do not disrupt that
- All solutions must be maintainable without a developer on call
- One HTML file for the front-end — do not split into separate CSS/JS files
