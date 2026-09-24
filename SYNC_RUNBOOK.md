# MatiereHub Sync Runbook

How scheduled Xero syncs work, what we learned building them, and how to extend them.

---

## Architecture: why GitHub Actions

Claude's workspace shell routes outbound HTTPS through a local proxy that blocks external URLs. This means any scheduled task that runs a `curl` to `matierehub2.netlify.app` from inside Claude will silently fail with a 403.

**The fix:** use GitHub Actions instead. GitHub's runners have unrestricted outbound internet access and are free for public repos. Claude pushes a workflow file to the repo, GitHub runs it on schedule — no Claude sandbox involved at runtime.

---

## Scheduled syncs

### 1. Daily — invoice_items (7am AEST)

**File:** `.github/workflows/xero-sync.yml`  
**Cron:** `0 21 * * *` (9pm UTC = 7am AEST, UTC+10)  
**Scopes (in order):** `invoice_items`, `contacts`  
**What it does:**
- `invoice_items` — pulls all ACCREC invoices, upserts every line item. Refreshes payment statuses across all invoices, picks up new invoices.
- `contacts` — pulls all 400+ Xero contacts, upserts name/email/phone/address/abn/is_customer. HUB-only fields (`note`, `rating`, `categories`, `is_supplier`) are excluded from the payload and never overwritten.

**Why full pull (not date-limited):** Payment status can update on any invoice regardless of age. With ~720 line items + 400 contacts the full pull takes ~30s — no reason to optimise.  
**Typical runtime:** ~30–40s total (7s runner spin-up + ~12s invoice_items + ~15s contacts)

**Protected fields (HUB-only, never synced):** `note`, `rating`, `categories`, `is_supplier`

### 2. Weekly — full Xero refresh (Sunday 6am AEST)

**Status:** ⚠️ NOT YET ON GITHUB ACTIONS — still set up as a Claude scheduled task (broken, same proxy issue)  
**File:** `.github/workflows/xero-weekly-sync.yml` ← needs to be created  
**Cron:** `0 20 * * 0` (8pm UTC Saturday = 6am AEST Sunday, UTC+10)  
**Endpoints to call (in order):**
1. `POST /xero-sync?scope=quotes`
2. `POST /xero-sync?scope=invoices`
3. `POST /xero-sync?scope=pnl`
4. `POST /xero-sync?scope=bank`
5. `POST /xero-sync?scope=invoice_items`

**What it does:** Refreshes all Xero-cached dashboard data — pipeline (quotes), invoice totals, P&L chart, bank balance — plus the invoice_items line-item table. This is what keeps the Business Health, Pipeline, Financials, and P&L tabs current.

---

## Process: adding a new scope to an existing GitHub Actions workflow

1. Open `.github/workflows/xero-sync.yml` (or the weekly equivalent)
2. Add a new `curl` step for the new scope, following the same pattern as existing steps
3. Push via Claude (it has the GitHub token with `repo + workflow` scope)
4. Manually trigger the workflow from GitHub → Actions → Run workflow to test

---

## Process: creating a new GitHub Actions sync from scratch

Follow these steps exactly — we learned each one the hard way.

### Step 1: Check the GitHub token has `workflow` scope

```bash
curl -s -I \
  -H "Authorization: token <TOKEN>" \
  "https://api.github.com/user" | grep -i "x-oauth-scopes"
```

Expected output must include `workflow`:
```
x-oauth-scopes: repo, workflow
```

If it only shows `repo`, the push will silently return `404 Not Found` with no useful error message. You need to regenerate the token on GitHub with the `workflow` scope ticked.

**How to regenerate:**
- github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)
- Click the token → Edit → tick `workflow` under Select scopes → Update token

### Step 2: Write the workflow file

Key things to get right:
- Use `secrets.SYNC_SECRET` for the bearer token — never hardcode `matiere2026` in the file
- Include `workflow_dispatch:` so you can manually trigger it from the GitHub UI for testing
- Capture both the response body and HTTP status code separately (the `-w "\n%{http_code}"` pattern)
- Fail the job (`exit 1`) on non-200 so GitHub marks the run as failed and you get notified

```yaml
name: <Descriptive Name>

on:
  schedule:
    - cron: "<UTC cron expression>"
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: <Step name>
        run: |
          response=$(curl -s -w "\n%{http_code}" -X POST \
            "https://matierehub2.netlify.app/.netlify/functions/xero-sync?scope=<SCOPE>" \
            -H "Authorization: Bearer ${{ secrets.SYNC_SECRET }}" \
            -H "Content-Type: application/json")
          http_code=$(echo "$response" | tail -1)
          body=$(echo "$response" | head -n -1)
          echo "HTTP status: $http_code"
          echo "Response: $body"
          if [ "$http_code" != "200" ]; then
            echo "Sync failed with HTTP $http_code"
            exit 1
          fi
          echo "Sync completed successfully"
```

### Step 3: Push via GitHub Contents API

Claude does this autonomously using the stored token. The PUT request goes to:
```
PUT https://api.github.com/repos/smatiere/matierehub/contents/.github/workflows/<filename>.yml
```

With a JSON body:
```json
{
  "message": "Add GitHub Actions <description>",
  "content": "<base64-encoded workflow YAML>",
  "branch": "main"
}
```

### Step 4: Add `SYNC_SECRET` to GitHub repo secrets (one-time, already done)

- github.com/smatiere/matierehub → Settings → Secrets and variables → Actions
- Name: `SYNC_SECRET` / Value: `matiere2026`
- This is already set — no action needed for future workflows

### Step 5: Test manually

- GitHub → Actions → click the workflow name → Run workflow → Run workflow
- Check the run completes with green tick
- Typical healthy runtimes: 15–30s for a single scope, 60–90s for multi-scope weekly

---

## AEST timezone cron reference

GitHub Actions cron runs in UTC. Northern Beaches is UTC+10 (AEST, no daylight saving in June).

| Desired time (AEST) | UTC cron |
|---|---|
| 6am Sunday | `0 20 * * 0` |
| 7am daily | `0 21 * * *` |
| 8am daily | `0 22 * * *` |
| 6pm daily | `0 8 * * *` |

Note: during daylight saving (Oct–Apr) AEDT is UTC+11, so the above run 1 hour early. Not a problem for background syncs.

---

## Available xero-sync scopes

| Scope | What it refreshes | Dashboard tabs affected |
|---|---|---|
| `invoice_items` | `invoice_items` table — all line items, payment status | Materials, Pipeline detail |
| `quotes` | `xero_cache.quotes` | Pipeline |
| `invoices` | `xero_cache.open_invoices`, `xero_cache.top_customers`, `xero_cache.kpis` | Business Health, Financials |
| `pnl` | `xero_cache.monthly`, `xero_cache.cost_detail_monthly`, `xero_cache.fy_summary`, `xero_cache.account_categories` | Financials, P&L |
| `bank` | `xero_cache.kpis` (cash balance) | Business Health |

---

## Next action

Create `.github/workflows/xero-weekly-sync.yml` calling scopes in this order:
`quotes` → `invoices` → `pnl` → `bank` → `invoice_items`

Use the same pattern as the daily workflow. Schedule: `0 20 * * 0` (Sunday 6am AEST).
Then delete or disable the broken Claude scheduled task for the weekly run.
