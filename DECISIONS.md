# MatiereHub — Architectural Decisions

Why things are built the way they are. Read before suggesting alternatives.

---

## Database: `data.json` on GitHub

**Decision:** Use a single `data.json` file committed to GitHub as the database.
**Why:** No backend server, no paid database subscription. Netlify functions read/write via GitHub API. Netlify auto-deploys on push so the front-end always gets fresh data on page load.
**Trade-off:** Not suitable for concurrent writes (two simultaneous saves could conflict). Acceptable for a one-person business.

---

## Front-end: single `index.html` file

**Decision:** All HTML, CSS, and JavaScript lives in one file.
**Why:** Seb is not a developer. One file = easy to understand, easy to deploy, easy to ask Claude to edit. No build step, no npm, no bundler.
**Trade-off:** File gets long (~2,000+ lines). Manageable with ctrl+F.

---

## AI parsing: Claude Haiku via Netlify function

**Decision:** Natural language input is parsed by Claude Haiku (not Sonnet) via a Netlify serverless function.
**Why:** Haiku is fast and cheap for structured JSON extraction. The API key lives server-side in Netlify env vars, never exposed in the browser.
**Trade-off:** Haiku can hallucinate on ambiguous input. Mitigated by tight prompt + server-side validation.

---

## Xero: read for financials, write for quotes/invoices

**Decision:** Xero is used in two directions:
1. **Read** — `xero-sync.js` pulls P&L, cash, receivables into `data.json` for the dashboard
2. **Write** — Claude can create DRAFT quotes and invoices directly in Xero by injecting JavaScript into the Hub browser tab via the Chrome extension

**How write-back works:**
- The Hub defines `xeroApiCall(endpoint, method, body)` which proxies all calls through `netlify/functions/xero-api.js`
- Claude runs `xeroApiCall("Quotes", "POST", payload)` or `xeroApiCall("Invoices", "POST", payload)` via `mcp__Claude_in_Chrome__javascript_tool`
- Results land as DRAFT in Xero — Seb reviews and sends from within Xero
- **Always use `TaxType: "OUTPUT"`** (GST on Income, 10%) for all sales line items
- **Always use `AccountCode: "200"`** (Sales) for job income

**Constraints:**
- Hub tab must be open at `https://matierehub2.netlify.app` with green ⚡ Xero button visible
- ContactID must be looked up via `xeroApiCall("Contacts", "GET")` — never guess
- Mark Shippen ContactID: `d79444a2-34cf-40ee-bf53-fc2fed4bad89` (cached — verify before use)

**What failed earlier (don't retry):**
- Direct browser calls to `api.xero.com` — blocked by CORS
- `OUTPUT2` tax type — does not exist in this Xero org
- `payroll.*` and `app.connections` scopes — Xero gates these, causes `access_denied`
- See `reference_xero_connection.md` in memory for full OAuth2 setup history

---

## No Google Sheets, no Airtable

**Decision:** Not used.
**Why:** Google Sheets Drive connector can only create new files, cannot append rows. Airtable requires a paid subscription. See CLAUDE.md failed approaches for full history.
