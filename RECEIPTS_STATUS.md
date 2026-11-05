# Receipts, Schedule and Xero loop: where we are (updated 6 Nov 2026)

Plain-language status so Seb can read it on his phone. Technical detail is in CHANGES_PENDING.md.

## Live and working
- **Schedule tab:** jobs appear automatically when a project is Won (Xero quote accepted, or status set by hand). Hours come from the project card's quoted hours; address, phone, email from the Xero contact. Calendar opens on today, past days blank, undated jobs show as dashed placeholders to drag. "✕ Not won" takes a job off. Sent quotes no longer create a booking.
- **Project statuses:** Won and Lost added. Filter default: Active, Won, Finished.
- **Price library** (table `price_list`, ex GST): fed by every saved receipt line (database trigger), by `save_price` from the quoting chat, and by hand. Chat tools `search_prices` / `save_price` are on the Xero connector (xero-mcp). Quoting-project instruction text: seb-hq/knowledge/quoting-project-instructions.md (paste into the claude.ai project; Claude cannot edit it).
- **Receipt Inbox** (Hub > Scan Receipt > Inbox): piles Pending / Processed / Personal / Not a cost / Missing receipts. Card: PDF or photo shown inline, supplier, date, total, invoice number, category, GST (read from invoice, else learned per supplier, else 10%), job (suggested from that day's timesheets, learned "no project" suppliers), line editor with a discreet per-line job override. Duplicate protection (matches saved expenses by supplier/date/lines/invoice number; link only / add missing lines / different). 📚 Combined PDF import (one PDF of many receipts becomes one card each; untested on a real Bunnings printout).
- **Xero batch** (function receipt-xero): Save & next queues; "Send N to Xero now" creates Spend Money (Xero refuses drafts, so it posts as approved) from the bank account containing "CBA #1035", attaches the original file; before creating it looks for an existing payment (same amount within 5 days, any contact) and attaches to that instead. 10 receipts have gone through. The GitHub workflow receipts-to-xero.yml is MANUAL only (cron lines commented out).
- **Missing receipts pile:** asks Xero for payments (last 90 days) with no file attached and offers matching Inbox receipts.
- **Data fixes done:** PolyGuru missing shipping line added (EXP-280); duplicate Anthropic receipt removed (EXP-276); Apple receipts corrected to GST-included; own sales invoices (Matiere) go to "Not a cost".

## Numbers on 5 Nov 2026 (CBA export 1 Jan to 3 Nov)
248 payments need a receipt; 46 have one; **202 missing, about $47,200** (Bunnings 60 payments, $18,400). 11 payments not in Xero yet (Reconcile). Inbox: 40 receipts (all by email), 0 from photos.
Tracker page: https://claude.ai/artifact/Pm1DXKPFC3aYcmskFAwTjZ (snapshot, ask Claude to refresh).

## Open items, in order
1. **Send the Bunnings email** (Gmail draft "PowerPass portal error - please send my tax invoices...", details filled). When the PDFs arrive: Inbox > 📚 Combined PDF. PowerPass portal error ref 5792239 (their fault). Portal: www.bunningspowerpass.com.au > Transactions > Print Selected (steps in seb-hq/knowledge/bunnings-receipts-export.md).
2. **Comms Hub session:** run the 90-day backfill (it only looked back 14 days; include Hotmail), cleaner email-to-PDF rendering, skip own sales invoices, `vault fill comms-hub --go` for RECEIPT_INBOX_KEY. All in seb-hq/knowledge/receipt-inbox-handoff.md.
3. **Phone photos (not working yet):** iPhone Shortcut recipe (knowledge/receipt-photos-shortcut.md) or the MyVA app feature (prompt in knowledge/myva-receipt-photos-prompt.md). The Hub endpoint is ready and tested by email.
4. **Check the first Xero entries:** open 3 in Xero, confirm the file is attached and GST/account look right. Then say "turn on the schedule" to run the Xero batch twice a day.
5. **Rotate SYNC_SECRET** (value is written in CLAUDE.md; weak). It is used by the GitHub Actions syncs and the scheduled batch.
6. Reload the Hub fully on the phone to see the latest build (an open tab keeps the old page).
7. Later: multi-device memory for description/GST (now partly per device), keep single-line subscription entries out of the price library, personal receipts sorting (Personal pile is parked), MyVA native photo pickup.

## Where things live (names only)
- Tables: receipt_inbox, receipt_ignore, price_list, bookings, expense_log (+reference, receipt_id). Storage bucket: receipts (private).
- Functions: receipt-inbox (add, list, url, update, reread, read_multi, ignore_rule), receipt-xero (push, status, banks, needs_receipt), hub-read, smart-note, claude-parse, xero-mcp.
- Vault names: SUPABASE_FOR_MATIERE_HUB (SQL via Supabase management API: see seb-hq lessons), RECEIPT_INBOX_KEY (add-only, for Comms Hub / Shortcut / MyVA), MATIERE_ABN, BUNNINGS_POWERPASS (the account number).
- Netlify env added: RECEIPT_INBOX_KEY, XERO_RECEIPTS_BANK_NAME ("CBA #1035"). Existing: HUB_API_KEY, HUB_ADMIN_PASSWORD, SYNC_SECRET, ANTHROPIC_API_KEY, SUPABASE_*, XERO_*.
