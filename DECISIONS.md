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

## Xero: read-only via MCP connector

**Decision:** Xero is read-only. Financial data is pulled into `data.json` via `xero-sync.js` and displayed statically.
**Why:** Writing back to Xero (invoices, quotes) requires OAuth2 write scopes and a server-side token refresh flow. Multiple attempts to build this failed (see CLAUDE.md failed approaches).
**Status:** Write-back to Xero is a future goal, not currently implemented.

---

## No Google Sheets, no Airtable

**Decision:** Not used.
**Why:** Google Sheets Drive connector can only create new files, cannot append rows. Airtable requires a paid subscription. See CLAUDE.md failed approaches for full history.
