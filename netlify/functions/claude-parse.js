// claude-parse.js — Supabase edition
// Parses natural language input via Claude Haiku and writes directly to Supabase.
// No more GitHub push / Netlify redeploy cycle.

const SUPABASE_URL        = process.env.SUPABASE_URL;        // https://nwpzjqblhywclqharggu.supabase.co
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role JWT

// ── Supabase helpers ────────────────────────────────────────────────────────────
async function sbGet(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbPost(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbPatch(table, query, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbDelete(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=representation'
    }
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Salvage helper ───────────────────────────────────────────────────────────────
// Scans a string and returns every top-level, individually-parseable {...} object.
// Tolerant of a truncated trailing object and of surrounding array brackets/commas —
// so a receipt whose JSON array got cut off mid-way still yields all complete lines.
function extractJsonObjects(str) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try { objs.push(JSON.parse(str.slice(start, i + 1))); } catch (e) { /* skip malformed */ }
          start = -1;
        }
      }
    }
  }
  return objs;
}

// ── Main handler ───────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env vars not configured' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { text, pendingAction, images } = body;
    const hasImages = images && images.length > 0;
    if (!text && !pendingAction && !hasImages) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No input provided' }) };

    // ── 1. Fetch context from Supabase ────────────────────────────────────────
    const [projectRows, recentTimesheets, allTsIds, allExpIds, categoryRows] = await Promise.all([
      sbGet('projects', '?select=id,name,status&order=id.asc'),
      sbGet('timesheets', '?select=id,date,project,hours,notes&order=date.desc,id.desc&limit=15'),
      sbGet('timesheets', '?select=id'),
      sbGet('expense_log', '?select=id'),
      sbGet('category_list', '?select=name&order=name.asc')
    ]);
    const categoryList = categoryRows.map(c => c.name);

    const projectList  = projectRows.map(p => p.name);
    const projectNames = projectList.join(', ');

    // Safe next IDs
    const existingTsNums = allTsIds
      .map(t => parseInt((t.id || '').replace('TS-', ''), 10))
      .filter(n => !isNaN(n));
    const nextTsNum = existingTsNums.length ? Math.max(...existingTsNums) + 1 : 1;
    const nextTsId  = `TS-${String(nextTsNum).padStart(3, '0')}`;

    const existingExpNums = allExpIds
      .map(e => parseInt((e.id || '').replace('EXP-', ''), 10))
      .filter(n => !isNaN(n));
    const nextExpNum = existingExpNums.length ? Math.max(...existingExpNums) + 1 : 1;
    const nextExpId  = `EXP-${String(nextExpNum).padStart(3, '0')}`;

    // ── 2. Date context ─────────────────────────────────────────────────────────
    const todayStr     = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const yesterdayStr = new Date(new Date(todayStr + 'T12:00:00').getTime() - 86400000)
                           .toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    // Recent entries for delete matching
    const recentTs = recentTimesheets
      .map(t => `${t.id} | ${t.date} | ${t.project} | ${t.hours}h | notes: "${t.notes||''}"`)
      .join('\n');

    // Dynamic example projects
    const exampleProject  = projectList[0] || 'Mark - Nth Balgowlah';
    const exampleProject2 = projectList.find(p => p.toLowerCase().includes('rob'))    || projectList[1] || exampleProject;
    const exampleProject3 = projectList.find(p => p.toLowerCase().includes('ibk') || p.toLowerCase().includes('mosman')) || projectList[2] || exampleProject;
    const exampleProject4 = projectList.find(p => p.toLowerCase().includes('neil'))   || projectList[3] || exampleProject;

    const systemPrompt = `You are a data entry parser for a carpentry business. Output ONE JSON object only — no explanation, no markdown, no extra text.

TODAY: ${todayStr}
YESTERDAY: ${yesterdayStr}
ACTIVE PROJECTS: ${projectNames}
NON-BILLABLE: Admin, Wasted Time, Holidays, Sick days, Carer days

CRITICAL: You MUST use project names EXACTLY as they appear in ACTIVE PROJECTS above. Do NOT invent or abbreviate project names.

---
## ACTION 1 — Log hours (timesheet entry)

Schema: {"action":"new","type":"timesheet","date":"YYYY-MM-DD","project":"Exact Project Name","hours":4,"notes":"","employee":"Seb"}

Examples (project names taken from ACTIVE PROJECTS above):
"4h mark today"                    → {"action":"new","type":"timesheet","date":"${todayStr}","project":"${exampleProject}","hours":4,"notes":"","employee":"Seb"}
"logged 6 hours on ibk yesterday"  → {"action":"new","type":"timesheet","date":"${yesterdayStr}","project":"${exampleProject3}","hours":6,"notes":"","employee":"Seb"}
"full day rob balgo"               → {"action":"new","type":"timesheet","date":"${todayStr}","project":"${exampleProject2}","hours":8,"notes":"","employee":"Seb"}
"half day admin friday"            → {"action":"new","type":"timesheet","date":"<last friday>","project":"Admin","hours":4,"notes":"","employee":"Seb"}
"3.5h neil installing shelves"     → {"action":"new","type":"timesheet","date":"${todayStr}","project":"${exampleProject4}","hours":3.5,"notes":"installing shelves","employee":"Seb"}
"sick day today"                   → {"action":"new","type":"timesheet","date":"${todayStr}","project":"Sick days","hours":8,"notes":"","employee":"Seb"}
"8h today on new project Smith - Manly Deck" → {"action":"new","type":"timesheet","date":"${todayStr}","project":"Smith - Manly Deck","hours":8,"notes":"","employee":"Seb","new_project":true}

HOURS CONVERSION: "4h"=4, "half day"=4, "full day"=8, "3 and a half"=3.5, "couple hours"=2, "90 min"=1.5
Notes: anything after the hours/project that sounds like a description of work → put in notes field.

---
## ACTION 2 — Log an expense

Schema: {"action":"new","type":"expense","date":"YYYY-MM-DD","supplier":"Shop name","description":"Product name","category":"Category","project":"Project or empty","qty":1,"unit_price":125.50,"amount":125.50}

Rules:
- One entry per product line. A single receipt = multiple expense actions if it has multiple products.
- description = product name only (no qty, no price — those are separate fields)
- qty × unit_price = amount (all ex GST)
- qty defaults to 1 if not specified
- unit_price = amount / qty (ex GST)
- A receipt can have items for different projects — assign project per line based on context
- If project is unclear, leave as ""

Examples:
"$280 bunnings materials"                    → {"action":"new","type":"expense","date":"${todayStr}","supplier":"Bunnings","description":"Materials","category":"Materials","project":"","qty":1,"unit_price":254.55,"amount":254.55}
"3x deck screws $94.95 each at Bunnings"    → {"action":"new","type":"expense","date":"${todayStr}","supplier":"Bunnings","description":"Deck Screws","category":"Materials","project":"","qty":3,"unit_price":86.32,"amount":258.95}
"$62 fuel"                                  → {"action":"new","type":"expense","date":"${todayStr}","supplier":"","description":"Fuel","category":"Motor Vehicles - Fuel & Oil","project":"","qty":1,"unit_price":56.36,"amount":56.36}
"160 parking fine seaforth"                 → {"action":"new","type":"expense","date":"${todayStr}","supplier":"","description":"Parking fine - Seaforth","category":"Fines & Penalties","project":"","qty":1,"unit_price":145.45,"amount":145.45}
"sub 400 for neil plasterer"                → {"action":"new","type":"expense","date":"${todayStr}","supplier":"","description":"Subcontractor - plasterer","category":"Subcontractors","project":"${exampleProject4}","qty":1,"unit_price":363.64,"amount":363.64}

IMPORTANT: amounts are always ex GST. If given an inc-GST price, divide by 1.1 to get ex-GST.

EXPENSE CATEGORIES (use these exact strings):
- Materials           → timber, plasterboard, fixings, adhesives, anything installed
- Consumables         → blades, sandpaper, cutting discs, tape — used up on the job
- Tools               → power tools, hand tools, accessories
- Hire of Plant & Equipment → scaffold hire, equipment rental
- Motor Vehicles - Fuel & Oil → petrol, diesel
- Motor Vehicles - Repairs & Maintenance → servicing, tyres, repairs
- Motor Vehicles - Registration & Insurance → rego, CTP, insurance
- Motor Vehicles - Tolls → toll charges
- Fines & Penalties   → parking fines, infringement notices
- Subcontractors      → payments to subbies
- Uniforms            → workwear, boots, PPE
- Staff Amenities     → coffee, food on site
- Subscriptions & Memberships → software, trade memberships
- Sundry Expenses     → anything that doesn't fit above

Dollar sign is optional — a number with a $ or near a store/item name = expense.
If project is obvious from context use exact name from ACTIVE PROJECTS. Otherwise leave project as empty string "".

---
## ACTION 3 — Edit an existing entry

Schema: {"action":"edit","date":"YYYY-MM-DD","project":"Name or null","changes":{"field":"value"}}

Examples:
"add note to today mark — installed top rail"  → {"action":"edit","date":"${todayStr}","project":"${exampleProject}","changes":{"notes":"installed top rail"}}
"fix yesterday hours to 6"                     → {"action":"edit","date":"${yesterdayStr}","project":null,"changes":{"hours":6}}
"change hours on ibk yesterday to 7.5"         → {"action":"edit","date":"${yesterdayStr}","project":"${exampleProject3}","changes":{"hours":7.5}}

Use for: "add note", "note that", "fix hours", "change", "update", "correct".
project: exact name to target one entry, or null to update all entries on that date.

---
## ACTION 4 — Delete an entry

Schema: {"action":"delete","id":"TS-010"}

Use when: "delete TS-010", "remove that entry", "undo last entry" (use most recent ID from list below).

RECENT ENTRIES:
${recentTs || '(none yet)'}

---
## DATE RULES
- DATE:YYYY-MM-DD prefix → use that exact date (added by calendar popup)
- "today" → ${todayStr}
- "yesterday" → ${yesterdayStr}
- Day name ("Monday", "last Friday") → calculate from today ${todayStr}
- No date mentioned → ${todayStr}

## PROJECT MATCHING — ALWAYS pick from ACTIVE PROJECTS list above
- Match by keyword — first name, suburb, or any distinctive word in the project name
- Copy the full exact project name from ACTIVE PROJECTS — never paraphrase or shorten it
- "admin", "wasted", "sick", "holiday", "carer" → matching NON-BILLABLE category
- Only set "new_project":true if input explicitly contains the words "new project"
- If a project cannot be confidently identified, output {"action":"unclear","message":"brief reason"}

---
## ACTION 5 — Add a note to an invoice

Schema: {"action":"note","type":"invoice_item","invoice_number":"INV-0345","notes":"client requested revision"}

Triggers: "INV-XXXX note:", "note on INV-", "add note to INV-", or any input that contains an invoice number (INV-followed by 4 digits) and a note/comment.

Examples:
"INV-0345 note: client requested revision"   → {"action":"note","type":"invoice_item","invoice_number":"INV-0345","notes":"client requested revision"}
"add note to INV-0312 — paid in cash"        → {"action":"note","type":"invoice_item","invoice_number":"INV-0312","notes":"paid in cash"}
"note on INV-0287: warranty claim pending"   → {"action":"note","type":"invoice_item","invoice_number":"INV-0287","notes":"warranty claim pending"}
"INV-0300 client asked for receipt copy"     → {"action":"note","type":"invoice_item","invoice_number":"INV-0300","notes":"client asked for receipt copy"}

Invoice numbers always match INV-XXXX (4 digits, zero-padded). Extract the note after "note:", "—", ":", or similar separator.

---
## ACTION 6 — Rate a contact/supplier

Schema: {"action":"rate","contact_name":"Bunnings","rating":8}

Triggers: "rate [name] [0-10]", "[name] [score]/10", "give [name] a [score]", "[name] is a [score] out of 10"
Rating must be an integer 0–10.

Examples:
"rate Bunnings 8"          → {"action":"rate","contact_name":"Bunnings","rating":8}
"give Bunnings 9/10"       → {"action":"rate","contact_name":"Bunnings","rating":9}
"Aussie Timber 7 out of 10" → {"action":"rate","contact_name":"Aussie Timber","rating":7}

---
## ACTION 7 — Assign category to a contact/supplier

Schema: {"action":"category","contact_name":"Bunnings","categories":["Hardware"]}
If no category is specified by the user, set categories to null (Claude will auto-suggest from past receipts).

VALID CATEGORIES: ${categoryList.join(', ')}

Triggers: "category [name]: [cat]", "[name] is a [cat] supplier", "add [cat] to [name]", "tag [name] as [cat]", "categorise [name]"

Examples:
"category Bunnings: Hardware"              → {"action":"category","contact_name":"Bunnings","categories":["Hardware"]}
"add Hardware and Tools to Bunnings"       → {"action":"category","contact_name":"Bunnings","categories":["Hardware","Tools & Equipment"]}
"Aussie Timber is a timber supplier"       → {"action":"category","contact_name":"Aussie Timber","categories":["Timber & Sheet"]}
"categorise Bunnings"                      → {"action":"category","contact_name":"Bunnings","categories":null}

Only use categories from the VALID CATEGORIES list above. If the user's category doesn't match exactly, pick the closest valid one.

---
## ACTION 8 — Tag a bank transaction with project and/or notes

Schema: {"action":"bank_tx_tag","date":"YYYY-MM-DD","contact":"partial name","project":"Exact Project Name or empty","notes":"free text or empty"}

Triggers: "tx [date] [contact] project:", "tag tx", "bank tx", "mark tx", "tx [date] [contact] note:"
At least one of project or notes must be set. Both can be set together.
date: resolve same as other actions (today, yesterday, day name, explicit date).
contact: the payee name (or partial) as it appears in the bank — e.g. "Bunnings", "ATO", "Mariane".

Examples:
"tx today Bunnings project: Mark"                       → {"action":"bank_tx_tag","date":"${todayStr}","contact":"Bunnings","project":"${exampleProject}","notes":""}
"tx 2026-06-01 ATO project: Admin note: BAS Q3 payment" → {"action":"bank_tx_tag","date":"2026-06-01","contact":"ATO","project":"Admin","notes":"BAS Q3 payment"}
"tag tx yesterday plasterer note: subcontractor Rob job" → {"action":"bank_tx_tag","date":"${yesterdayStr}","contact":"plasterer","project":"${exampleProject2}","notes":"subcontractor Rob job"}
"bank tx 14/06/2026 Bunnings note: wrong screws returned"→ {"action":"bank_tx_tag","date":"2026-06-14","contact":"Bunnings","project":"","notes":"wrong screws returned"}

project: exact name from ACTIVE PROJECTS, or empty string "". Apply same matching rules as ACTION 1.
notes: free text, or empty string "" if none.

---
## ACTION 9 — Link a project to a contact and/or quote number

Schema: {"action":"link_project","project":"Exact Project Name","contact_name":"Full Contact Name or empty","quote_number":"QU-0259 or empty"}

At least one of contact_name or quote_number must be non-empty.

Triggers: "link [project] to [QU-XXXX]", "link [project] to contact [name]", "set quote for [project]", "set contact for [project]", "connect [project] to [name]", "assign quote [QU-XXXX] to [project]"

Examples:
"link Mark project to QU-0259"                   → {"action":"link_project","project":"${exampleProject}","contact_name":"","quote_number":"QU-0259"}
"set contact for Rob project: Rob Anderson"       → {"action":"link_project","project":"${exampleProject2}","contact_name":"Rob Anderson","quote_number":""}
"link IBK project to contact IBK Constructions and quote QU-0241" → {"action":"link_project","project":"${exampleProject3}","contact_name":"IBK Constructions","quote_number":"QU-0241"}

Quote numbers always start with QU- followed by digits. Use exact project name from ACTIVE PROJECTS.

---
If you cannot confidently parse the input at all: {"action":"unclear","message":"brief plain-english reason"}`;

    // ── 3. Call Haiku (skipped if pendingAction already set) ──────────────────
    let parsed = pendingAction || null;

    if (!parsed) {
      // Build user message — vision content blocks if images are attached
      let userContent;
      if (hasImages) {
        userContent = [];
        for (const img of images) {
          if (img.mediaType && img.mediaType.startsWith('image/')) {
            userContent.push({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data }
            });
          } else if (img.mediaType === 'application/pdf') {
            // PDF document block (supported by claude-haiku-4-5+)
            userContent.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: img.data }
            });
          }
        }
        // A user-typed note must NEVER replace the line-item extraction directive —
        // it only adds project/context guidance. (Previously, any accompanying text
        // overwrote the whole instruction, so the model returned one summarised entry
        // instead of every line.)
        const userHint = (text && text.trim() && text.trim() !== 'Parse this receipt and log the expense.')
          ? text.trim() : '';
        const imageInstruction =
`This is a receipt/invoice photo (or PDF). Extract EVERY individual product line as its own expense entry — do NOT skip, merge, summarise, or group lines. If the receipt has 25 line items, return 25 objects. Capture small and cheap items too.

OVERRIDE: ignore the "Output ONE JSON object only" rule for this image. Return a JSON ARRAY only — one object per product line, each in this shape:
[{"action":"new","type":"expense","date":"${todayStr}","supplier":"StoreName","description":"Item name","category":"Category","project":"","qty":1,"unit_price":9.09,"amount":9.09}]

Rules:
- One object per physical line item printed on the receipt. Never combine two products into one entry.
- description = the product name/description as printed (no qty, no price).
- qty × unit_price = amount, all EX-GST. If prices are inc-GST, divide by 1.1 and round to 2dp.
- Do NOT create entries for subtotals, totals, GST lines, rounding, change, or payment/tender lines — only actual purchased items.
- category: pick the best fit from the EXPENSE CATEGORIES list in the system prompt. If genuinely unsure, use "Materials" for building supplies else "Sundry Expenses" — never drop a line because the category is unclear.
- supplier: the same store name on every line.
- date: the receipt date if visible, otherwise ${todayStr}.
` + (userHint
  ? `\nUSER NOTE (applies to the whole receipt): "${userHint}"\n- If the user named a project, set "project" to that project on EVERY line.\n- If the user did not name a project, or you are unsure which line belongs to which project, leave "project":"" — it can be corrected later in the Hub. Never skip or drop a line just because the project is unclear.`
  : `\n- Leave "project":"" on every line — it will be assigned later in the Hub.`);
        userContent.push({ type: 'text', text: imageInstruction });
      } else {
        userContent = text.trim();
      }

      // Use Sonnet for image requests (vision-capable); Haiku for text-only
      const model = hasImages ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          // Receipts can have many lines; 800 truncated long ones mid-array, which
          // left only the first salvageable item. 8000 comfortably fits ~40+ lines.
          max_tokens: hasImages ? 8000 : 300,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }]
        })
      });

      const claudeData = await claudeRes.json();
      if (!claudeRes.ok) {
        const errMsg = claudeData.error?.message || JSON.stringify(claudeData).slice(0, 200);
        console.error(`Claude API error (${model}):`, errMsg);
        throw new Error(`Claude API error: ${errMsg}`);
      }

      let rawText = claudeData.content[0].text.trim();
      console.log('INPUT:', (text || '').trim(), '| images:', hasImages ? images.length : 0);
      console.log('MODEL OUTPUT (first 500):', rawText.slice(0, 500));
      console.log('STOP REASON:', claudeData.stop_reason);

      rawText = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

      if (hasImages) {
        // Receipts always become a batch of line items. Be tolerant of a
        // truncated array: salvage every fully-formed {...} object so we never
        // silently collapse to a single line (the old failure mode).
        let items = [];
        try {
          const c = JSON.parse(rawText);
          items = Array.isArray(c) ? c : [c];
        } catch(e) {
          items = extractJsonObjects(rawText);
        }
        if (!items.length) throw new Error(`No line items parsed from receipt: ${rawText.slice(0, 200)}`);
        if (claudeData.stop_reason === 'max_tokens') {
          console.warn(`Receipt output hit max_tokens — salvaged ${items.length} complete line(s); a final partial line may have been dropped.`);
        }
        parsed = { action: 'expense_batch', items };
      } else {
        try {
          const candidate = JSON.parse(rawText);
          parsed = Array.isArray(candidate) ? candidate[0] : candidate;
        } catch(e) {
          const match = rawText.match(/\{[\s\S]*?\}/);
          if (match) {
            try { parsed = JSON.parse(match[0]); }
            catch(e2) { throw new Error(`Bad JSON from model: ${rawText.slice(0, 200)}`); }
          } else {
            throw new Error(`Bad JSON from model: ${rawText.slice(0, 200)}`);
          }
        }
      }
    }

    console.log('PARSED ACTION:', JSON.stringify(parsed));

    if (parsed.action === 'unclear') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: parsed.message }) };
    }

    // ── 4. Server-side project validation (three-tier fuzzy) ─────────────────
    const NON_BILLABLE = ['Admin', 'Wasted Time', 'Holidays', 'Sick days', 'Carer days'];
    const tokenise = str => str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);

    function fuzzyMatchProject(name, validProjects) {
      const exact = validProjects.find(p => p.toLowerCase() === name.toLowerCase());
      if (exact) return { match: exact, score: 1.0 };
      const inputTokens = tokenise(name);
      let bestMatch = null, bestScore = 0;
      for (const p of validProjects) {
        const pTokens = tokenise(p);
        const overlap = inputTokens.filter(t => pTokens.includes(t)).length;
        const score = overlap / Math.max(inputTokens.length, pTokens.length);
        if (score > bestScore) { bestScore = score; bestMatch = p; }
      }
      return { match: bestMatch, score: bestScore };
    }

    const needsProjectCheck = parsed.action === 'new' && parsed.project &&
      (parsed.type === 'timesheet' || parsed.type === 'expense');

    if (needsProjectCheck) {
      const validProjects = [...projectList, ...NON_BILLABLE];

      if (parsed.new_project) {
        const alreadyExists = validProjects.some(p => p.toLowerCase() === parsed.project.toLowerCase());
        if (!alreadyExists) {
          const existingPRNums = projectRows
            .map(p => parseInt((p.id || '').replace('PR-', ''), 10))
            .filter(n => !isNaN(n));
          const nextPRNum = existingPRNums.length ? Math.max(...existingPRNums) + 1 : 1;
          const nextPRId  = `PR-${String(nextPRNum).padStart(3, '0')}`;
          await sbPost('projects', {
            id: nextPRId, name: parsed.project, status: 'Active', quoted: 0,
            notes: `Created ${new Date().toISOString().slice(0,10)}`
          });
          projectList.push(parsed.project);
          console.log(`New project registered: ${nextPRId} "${parsed.project}"`);
        }
        const canonical = [...projectList, ...NON_BILLABLE].find(p => p.toLowerCase() === parsed.project.toLowerCase());
        if (canonical) parsed.project = canonical;

      } else {
        const { match, score } = fuzzyMatchProject(parsed.project, validProjects);
        console.log(`Project lookup: "${parsed.project}" → "${match}" (score ${score?.toFixed(2)})`);

        if (score >= 0.75) {
          parsed.project = match;
        } else if (score >= 0.35) {
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'confirm', message: `Did you mean "${match}"?`,
            suggested: match, pending: { ...parsed, project: match }
          })};
        } else {
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'unclear',
            message: `I don't recognise "${parsed.project}" as a project. Active projects: ${projectList.join(', ')}`
          })};
        }
      }
    }

    // ── 5. Apply action to Supabase ───────────────────────────────────────────
    let entryLabel = '';
    let responseExtra = {};

    if (parsed.action === 'new') {
      if (parsed.type === 'timesheet') {
        const entry = {
          id:       nextTsId,
          date:     parsed.date,
          project:  parsed.project,
          hours:    parseFloat(parsed.hours),
          employee: parsed.employee || 'Seb',
          notes:    parsed.notes || '',
          rate:     100,
          value:    parseFloat(parsed.hours) * 100
        };
        await sbPost('timesheets', entry);
        entryLabel = `${entry.hours}h on ${entry.project} (${entry.date})`;
        responseExtra = { entry };

      } else if (parsed.type === 'expense') {
        const qty       = parseFloat(parsed.qty) || 1;
        const unitPrice = parseFloat(parsed.unit_price) || parseFloat(parsed.amount) / qty;
        const amount    = Math.round(qty * unitPrice * 100) / 100;
        const entry = {
          id:          nextExpId,
          date:        parsed.date,
          supplier:    parsed.supplier || '',
          description: parsed.description,
          category:    parsed.category || 'Sundry Expenses',
          project:     parsed.project || '',
          qty,
          unit_price:  Math.round(unitPrice * 100) / 100,
          amount
        };
        await sbPost('expense_log', entry);
        entryLabel = `$${entry.amount} — ${entry.description.slice(0, 40)}`;
        responseExtra = { entry };

      } else {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'Unknown entry type' }) };
      }

    } else if (parsed.action === 'edit') {
      const targetDate    = parsed.date;
      const targetProject = parsed.project || null;
      const changes       = parsed.changes || {};

      // Find matching entries
      let query = `?date=eq.${targetDate}`;
      if (targetProject) query += `&project=eq.${encodeURIComponent(targetProject)}`;
      const toUpdate = await sbGet('timesheets', query + '&select=id,date,project,hours,rate');

      if (!toUpdate.length) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `No timesheet entries found for ${targetDate}${targetProject ? ' / ' + targetProject : ''}`
        })};
      }

      const updatedEntries = [];
      for (const ts of toUpdate) {
        const patch = { ...changes };
        if (changes.hours) {
          patch.hours = parseFloat(changes.hours);
          patch.value = Math.round(patch.hours * (ts.rate || 100) * 100) / 100;
        }
        const updated = await sbPatch('timesheets', `?id=eq.${encodeURIComponent(ts.id)}`, patch);
        updatedEntries.push(...(Array.isArray(updated) ? updated : [updated]));
      }

      entryLabel = `Updated ${updatedEntries.length} entr${updatedEntries.length !== 1 ? 'ies' : 'y'} on ${targetDate}`;
      responseExtra = { updated: updatedEntries };

    } else if (parsed.action === 'delete') {
      const deleted = await sbDelete('timesheets', `?id=eq.${encodeURIComponent(parsed.id)}`);
      if (!deleted || deleted.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: `Entry ${parsed.id} not found` }) };
      }
      const removed = deleted[0];
      entryLabel = `Deleted ${removed.id}: ${removed.hours}h ${removed.project} (${removed.date})`;
      responseExtra = { deleted: removed };

    } else if (parsed.action === 'rate') {
      // Find the contact by partial name match
      const contactMatches = await sbGet('contacts',
        `?name=ilike.*${encodeURIComponent(parsed.contact_name)}*&select=id,name,rating&limit=5`
      );
      if (!contactMatches.length) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear', message: `No contact found matching "${parsed.contact_name}"`
        })};
      }
      const contact = contactMatches[0];
      const rating  = parseInt(parsed.rating, 10);
      if (isNaN(rating) || rating < 0 || rating > 10) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear', message: `Rating must be 0–10, got "${parsed.rating}"`
        })};
      }
      await sbPatch('contacts', `?id=eq.${encodeURIComponent(contact.id)}`, { rating });
      entryLabel  = `${contact.name}: rated ${rating}/10`;
      responseExtra = { contact: { id: contact.id, name: contact.name, rating } };

    } else if (parsed.action === 'category') {
      // Find the contact by partial name match
      const contactMatches = await sbGet('contacts',
        `?name=ilike.*${encodeURIComponent(parsed.contact_name)}*&select=id,name,categories&limit=5`
      );
      if (!contactMatches.length) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear', message: `No contact found matching "${parsed.contact_name}"`
        })};
      }
      const contact = contactMatches[0];

      let categoriesToAssign = parsed.categories; // array or null

      if (!categoriesToAssign || !categoriesToAssign.length) {
        // Auto-suggest: look up past expense_log entries for this supplier
        const expenses = await sbGet('expense_log',
          `?supplier=ilike.*${encodeURIComponent(parsed.contact_name)}*&select=description,category&limit=20`
        );
        if (!expenses.length) {
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'unclear',
            message: `No past expenses found for "${contact.name}" — please specify a category, e.g. "category ${contact.name}: Hardware"`
          })};
        }
        // Ask Haiku to suggest from the expense history
        const purchaseSummary = expenses.map(e => `- ${e.description} (${e.category})`).join('\n');
        const suggestRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 60,
            messages: [{ role: 'user', content:
              `Based on these past purchases from ${contact.name}:\n${purchaseSummary}\n\nValid categories: ${categoryList.join(', ')}\n\nReply with a JSON array of the best matching categories, e.g. ["Hardware"]. One array only, no explanation.`
            }]
          })
        });
        const suggestData  = await suggestRes.json();
        const suggestRaw   = (suggestData.content?.[0]?.text || '').trim();
        const arrayMatch   = suggestRaw.match(/\[[\s\S]*?\]/);
        try { categoriesToAssign = arrayMatch ? JSON.parse(arrayMatch[0]) : []; }
        catch(e) { categoriesToAssign = []; }

        if (!categoriesToAssign.length) {
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'unclear',
            message: `Couldn't determine a category for "${contact.name}" — please specify: "category ${contact.name}: Hardware"`
          })};
        }

        // Return as confirm so Seb can approve the suggestion
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'confirm',
          message: `Suggest ${categoriesToAssign.map(c => `"${c}"`).join(', ')} for ${contact.name} based on ${expenses.length} past receipts — confirm?`,
          suggested: categoriesToAssign,
          pending: { ...parsed, contact_name: contact.name, categories: categoriesToAssign }
        })};
      }

      // Validate against category_list
      const invalidCats = categoriesToAssign.filter(c => !categoryList.includes(c));
      if (invalidCats.length) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `Unknown categor${invalidCats.length > 1 ? 'ies' : 'y'}: ${invalidCats.join(', ')}. Valid: ${categoryList.join(', ')}`
        })};
      }

      // Merge with existing categories (deduplicate)
      const existing = contact.categories || [];
      const merged   = [...new Set([...existing, ...categoriesToAssign])];
      await sbPatch('contacts', `?id=eq.${encodeURIComponent(contact.id)}`, { categories: merged });
      entryLabel    = `${contact.name}: categories → ${merged.join(', ')}`;
      responseExtra = { contact: { id: contact.id, name: contact.name, categories: merged } };

    } else if (parsed.action === 'bank_tx_tag') {
      // Tag bank transactions with project and/or notes.
      // Matches by date + partial contact name (ilike). Updates ALL matching rows on that date
      // (e.g. two Bunnings receipts on the same day both get tagged). project/notes are
      // HUB-only columns — xero-sync.js never touches them, so tags survive all future syncs.
      const txDate    = parsed.date;
      const txContact = (parsed.contact || '').trim();
      const txProject = (parsed.project || '').trim();
      const txNotes   = (parsed.notes   || '').trim();

      if (!txDate) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'Could not determine a date for the bank transaction' }) };
      }
      if (!txProject && !txNotes) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'Please specify a project, a note, or both' }) };
      }

      // Build search query — date is required; contact is optional but narrows the match
      let txQuery = `?date=eq.${txDate}`;
      if (txContact) txQuery += `&contact=ilike.*${encodeURIComponent(txContact)}*`;
      txQuery += '&select=id,date,contact,gross,description';

      const matches = await sbGet('bank_transactions', txQuery);
      if (!matches.length) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `No bank transactions found for ${txDate}${txContact ? ' / ' + txContact : ''} — try a broader date or contact name`
        })};
      }

      // Validate project against active projects list if provided
      let resolvedProject = txProject;
      if (txProject) {
        const validProjects = [...projectList, ...NON_BILLABLE];
        const { match, score } = fuzzyMatchProject(txProject, validProjects);
        if (score >= 0.75) {
          resolvedProject = match;
        } else if (score >= 0.35) {
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'confirm', message: `Did you mean project "${match}"?`,
            suggested: match,
            pending: { ...parsed, project: match }
          })};
        } else {
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'unclear',
            message: `I don't recognise "${txProject}" as a project. Active projects: ${projectList.join(', ')}`
          })};
        }
      }

      // Build patch — only include fields the user actually set
      const patch = {};
      if (resolvedProject !== '') patch.project = resolvedProject;
      if (txNotes !== '')         patch.notes   = txNotes;

      // Patch all matching transactions
      const updatedTx = [];
      for (const tx of matches) {
        const result = await sbPatch('bank_transactions', `?id=eq.${encodeURIComponent(tx.id)}`, patch);
        updatedTx.push(...(Array.isArray(result) ? result : [result]));
      }

      const tagSummary = [resolvedProject && `project: ${resolvedProject}`, txNotes && `note: "${txNotes}"`].filter(Boolean).join(', ');
      entryLabel  = `Tagged ${updatedTx.length} transaction${updatedTx.length !== 1 ? 's' : ''} on ${txDate} — ${tagSummary}`;
      responseExtra = { tagged: matches.map(t => ({ id: t.id, contact: t.contact, gross: t.gross })) };

    } else if (parsed.action === 'link_project') {
      // Link a project row to a Xero contact_id and/or a quote_number.
      // At least one of contact_name / quote_number must be provided.
      const lpContactName = (parsed.contact_name || '').trim();
      const lpQuoteNum    = (parsed.quote_number || '').trim();
      const lpProjectName = (parsed.project || '').trim();

      if (!lpContactName && !lpQuoteNum) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear', message: 'Please provide a contact name, a quote number (QU-XXXX), or both'
        })};
      }

      // Find the project row
      const lpProject = projectRows.find(p => p.name.toLowerCase() === lpProjectName.toLowerCase());
      if (!lpProject) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `Project "${lpProjectName}" not found. Active projects: ${projectList.join(', ')}`
        })};
      }

      const patch = {};

      // Resolve contact → contact_id via Supabase contacts table
      if (lpContactName) {
        const contactMatches = await sbGet('contacts',
          `?name=ilike.*${encodeURIComponent(lpContactName)}*&select=id,name&limit=5`
        );
        if (!contactMatches.length) {
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'unclear',
            message: `No contact found matching "${lpContactName}" — check the name and try again`
          })};
        }
        if (contactMatches.length > 1) {
          const names = contactMatches.map(c => c.name).join(', ');
          return { statusCode: 200, headers, body: JSON.stringify({
            status: 'confirm',
            message: `Multiple contacts match "${lpContactName}": ${names}. Did you mean "${contactMatches[0].name}"?`,
            suggested: contactMatches[0].name,
            pending: { ...parsed, contact_name: contactMatches[0].name }
          })};
        }
        patch.contact_id = contactMatches[0].id;
        entryLabel = `${lpProject.name}: contact → ${contactMatches[0].name}`;
        responseExtra.contact = { id: contactMatches[0].id, name: contactMatches[0].name };
      }

      if (lpQuoteNum) {
        patch.quote_number = lpQuoteNum.toUpperCase();
        entryLabel = entryLabel
          ? entryLabel + `, quote → ${patch.quote_number}`
          : `${lpProject.name}: quote → ${patch.quote_number}`;
        responseExtra.quote_number = patch.quote_number;
      }

      await sbPatch('projects', `?id=eq.${encodeURIComponent(lpProject.id)}`, patch);
      responseExtra.project = lpProject.name;

    } else if (parsed.action === 'note' && parsed.type === 'invoice_item') {
      // Write a note to all line items on the given invoice.
      // The xero-sync never touches the notes column (it's intentionally excluded from
      // the upsert payload), so manual notes are never overwritten by a sync run.
      const invNum = (parsed.invoice_number || '').trim().toUpperCase();
      if (!invNum || !/^INV-\d{4}$/.test(invNum)) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `Couldn't find a valid invoice number (expected INV-XXXX format)`
        })};
      }
      const updated = await sbPatch('invoice_items', `?invoice_number=eq.${encodeURIComponent(invNum)}`, { notes: parsed.notes || '' });
      if (!updated || updated.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `No invoice items found for ${invNum} — check the invoice number`
        })};
      }
      entryLabel = `Note saved on ${invNum} (${updated.length} line item${updated.length !== 1 ? 's' : ''})`;
      responseExtra = { updated };

    } else if (parsed.action === 'expense_batch') {
      // ── Multi-item receipt scan ───────────────────────────────────────────────
      const items = (parsed.items || []).filter(i => i && (i.type === 'expense' || i.action === 'new'));
      if (!items.length) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'No expense line items found in the receipt image' }) };
      }

      let expIdCounter = nextExpNum;
      const insertedEntries = [];
      const batchValidProjects = [...projectList, ...NON_BILLABLE];

      for (const item of items) {
        const qty       = parseFloat(item.qty) || 1;
        const unitPrice = parseFloat(item.unit_price) || (parseFloat(item.amount) / qty) || 0;
        const amount    = Math.round(qty * unitPrice * 100) / 100;

        // Canonicalise the per-line project to an exact active-project name.
        // If it doesn't confidently match, leave it BLANK rather than dropping
        // the line or writing a bad name — Seb can fix it in the Expenses tab.
        let lineProject = (item.project || '').trim();
        if (lineProject) {
          const { match, score } = fuzzyMatchProject(lineProject, batchValidProjects);
          lineProject = (match && score >= 0.6) ? match : '';
        }

        const entry = {
          id:          `EXP-${String(expIdCounter++).padStart(3, '0')}`,
          date:        item.date || todayStr,
          supplier:    item.supplier || '',
          description: item.description || '',
          category:    item.category   || 'Sundry Expenses',
          project:     lineProject,
          qty,
          unit_price:  Math.round(unitPrice * 100) / 100,
          amount
        };
        await sbPost('expense_log', entry);
        insertedEntries.push(entry);
      }

      const totalAmt  = Math.round(insertedEntries.reduce((s, e) => s + e.amount, 0) * 100) / 100;
      const supplier  = insertedEntries[0]?.supplier || '';
      entryLabel = `${insertedEntries.length} item${insertedEntries.length > 1 ? 's' : ''} from ${supplier} · $${totalAmt} total`;
      responseExtra = { entries: insertedEntries, count: insertedEntries.length, total: totalAmt };

    } else {
      console.error('Unrecognised action:', JSON.stringify(parsed).slice(0, 300));
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: `Unrecognised action "${parsed.action || 'unknown'}" — try describing the expense in words` }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'success',
        action: parsed.action,
        type:   parsed.action === 'expense_batch' ? 'expense_batch' : (parsed.type || parsed.action),
        label:  entryLabel,
        ...responseExtra
      })
    };

  } catch (err) {
    console.error('claude-parse error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ status: 'error', message: err.message })
    };
  }
};
