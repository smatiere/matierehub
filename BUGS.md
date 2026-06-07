# MatiereHub — Known Bugs

Format: **[Status]** Description → Fix applied

---

## Open

**[OPEN]** `kpis.fy26_owner_drawings` is `0` in Supabase `xero_cache`
- **Where it shows:** Overview tab "Owner Drawings" card and P&L tab "Owner Drawings" card both correctly read `D.kpis.fy26_owner_drawings` — but the value stored in Supabase is `0`, while an older local snapshot of `data.json` had `64421.70`.
- **Likely cause:** `xero-sync.js` isn't categorising/summing owner-drawings transactions into this field during the sync that populates `xero_cache`.
- **Fix needed:** Check `xero-sync.js`'s P&L/category aggregation logic for how `fy26_owner_drawings` is computed and re-run the sync.

---

## Fixed (2026-06-05)

**[FIXED]** Time Distribution treemap showed false "Not logged" hours for today
- **Problem:** The treemap's available-hours loop ran `d <= to` where `to = today`. This added 8h to `avail` for today (an in-progress day), while today's partial hours were subtracted from it, surfacing a "Not logged Xh" block even though the KPI tile correctly showed 0 missing days.
- **Root cause:** The KPI tile loop uses `d < today` (excludes today). The treemap loop used `d <= to` (included today). Inconsistent boundary.
- **Fix:** Added `&& ds(d) < todayStr` to the treemap's avail loop so today is excluded from available hours — matching the KPI tile's logic that an in-progress day is not a gap.

---

## Fixed (2026-06-04)

**[FIXED]** Timesheet ID collision after delete
- **Problem:** New IDs were generated as `TS-${timesheets.length + 1}`. After any delete, the count drops and the next entry gets a duplicate ID. Breaks delete/edit targeting.
- **Fix:** Changed `claude-parse.js` to scan all existing IDs and use `max + 1` instead of `length + 1`.

**[FIXED]** Stale `days_old` on open invoices
- **Problem:** `days_old` values in `data.json` were calculated at Xero import time and never updated. Every day they get more wrong.
- **Fix:** `days_old` is now computed dynamically in the browser from the `date` field at render time.

**[FIXED]** Haiku creates new project instead of matching existing one (fuzzy name input)
- **Problem 1:** Prompt examples hardcoded the old project name "Mark - Nth Balgowlah". Haiku follows examples literally, so it kept outputting the old name even after the canonical name was updated to "Mark Shippen – Nth Balgowlah".
- **Problem 2:** Server-side validation was exact-match only. When Haiku returned a close-but-wrong name, instead of consolidating to the canonical project, it either rejected as "unclear" or (if `new_project` flag was set) created a duplicate project.
- **Fix 1:** Prompt examples are now built dynamically from the live project list, so they always reflect the current canonical names.
- **Fix 2:** Server now runs fuzzy token-overlap scoring when exact match fails. If the returned name shares ≥50% tokens with a real project, it auto-consolidates. Only rejects as "unclear" if no good match found.
- **Rule:** `new_project:true` is only set by Haiku when the user explicitly types the words "new project". Fuzzy inputs never create new projects.

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
