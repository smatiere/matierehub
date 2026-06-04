# MatiereHub — Known Bugs

Format: **[Status]** Description → Fix applied

---

## Open

*(none currently — see Fixed below)*

---

## Fixed (2026-06-04)

**[FIXED]** Timesheet ID collision after delete
- **Problem:** New IDs were generated as `TS-${timesheets.length + 1}`. After any delete, the count drops and the next entry gets a duplicate ID. Breaks delete/edit targeting.
- **Fix:** Changed `claude-parse.js` to scan all existing IDs and use `max + 1` instead of `length + 1`.

**[FIXED]** Stale `days_old` on open invoices
- **Problem:** `days_old` values in `data.json` were calculated at Xero import time and never updated. Every day they get more wrong.
- **Fix:** `days_old` is now computed dynamically in the browser from the `date` field at render time.

**[FIXED]** Race condition wipes entries when two saves happen close together
- **Problem:** The Netlify function fetches `data.json`, spends ~3s calling Claude API, then pushes back. If another entry was saved during those 3 seconds, the push overwrites it. Retry logic existed but checked for HTTP 409 — GitHub actually returns 422 for stale SHA conflicts, so the retry never fired.
- **Fix:** Changed the retry condition to catch both 409 and 422. On conflict, the function now re-fetches the latest data, re-applies the new entry on top, and retries up to 3 times.
- **Note:** Claude also contributed to this by pushing `data.json` directly with a stale snapshot. Claude should never push `data.json` directly — only the Netlify function should write it.

**[FIXED]** No server-side project validation
- **Problem:** Claude Haiku could hallucinate a project name that doesn't exist in the project list. The fabricated project would be silently written to `data.json`.
- **Fix:** `claude-parse.js` now validates the returned project name against `current.projects` and returns `unclear` if not matched.

---

## Known limitations (not bugs, by design)

- `expense_log` only stores chat-logged expenses, not the full Xero transaction history
- `data.json` is the entire database — no relational queries possible
- Quotes data (280 records) is read-only from Xero; cannot be updated via chat
