# MatiereHub — Xero Bridge Setup

## What this is
A set of Netlify serverless functions that connect MatiereHub to Xero's
full API — reading AND writing bills, contacts, invoices, quotes, and
pulling receipt attachments.

## Step 1 — Add to your existing Netlify site

1. Download and unzip this folder
2. Copy the following into your existing matierehub folder:
   - netlify/functions/xero-auth.js
   - netlify/functions/xero-api.js
   - netlify/functions/xero-attachment.js
   - xero-callback.html
   - netlify.toml (replace existing)
   - package.json (replace existing)
3. Drag the updated matierehub folder to Netlify → Deploys

## Step 2 — Add environment variables in Netlify

1. Go to app.netlify.com → your MatiereHub site
2. Site settings → Environment variables → Add variable

Add these three:

  XERO_CLIENT_ID      = 3854892E5C3B490EAE24E3B1A79E668D
  XERO_CLIENT_SECRET  = [paste your NEW secret here — not in chat]
  XERO_REDIRECT_URI   = https://matierehub.netlify.app/xero-callback

3. Click Save — Netlify encrypts these, they are never exposed

## Step 3 — Add redirect URI in Xero developer portal

1. Go to developer.xero.com → MatiereHub app → Configuration
2. Under OAuth 2.0 redirect URIs, add:
   https://matierehub.netlify.app/xero-callback
3. Save

## Step 4 — Add Xero scopes in developer portal

Under your app configuration, make sure these scopes are enabled:
  openid profile email
  accounting.transactions
  accounting.transactions.read
  accounting.contacts
  accounting.contacts.read
  accounting.attachments
  accounting.attachments.read
  accounting.settings.read
  offline_access

## Step 5 — Connect

1. Go to https://matierehub.netlify.app
2. Click "Connect Xero" (will appear after deploy)
3. Sign in with your Xero account
4. You'll be redirected back — connected

## What Claude can do once connected

READ from Xero:
- All bills and their line items
- Receipt attachments (photos) on any bill
- All contacts / suppliers
- All invoices and quotes

WRITE to Xero (always as Draft first):
- New bills from receipt photos
- New contacts
- New quotes with full line items and scope of work
- New invoices
- Attach receipt photos to bills

Everything lands as Draft so your accountant reviews before finalising.
