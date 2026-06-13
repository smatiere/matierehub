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
    const { text, pendingAction } = body;
    if (!text && !pendingAction) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No input provided' }) };

    // ── 1. Fetch context from Supabase ────────────────────────────────────────
    const [projectRows, recentTimesheets, allTsIds, allExpIds] = await Promise.all([
      sbGet('projects', '?select=id,name,status&order=id.asc'),
      sbGet('timesheets', '?select=id,date,project,hours,notes&order=date.desc,id.desc&limit=15'),
      sbGet('timesheets', '?select=id'),
      sbGet('expense_log', '?select=id')
    ]);

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
If you cannot confidently parse the input at all: {"action":"unclear","message":"brief plain-english reason"}`;

    // ── 3. Call Haiku (skipped if pendingAction already set) ──────────────────
    let parsed = pendingAction || null;

    if (!parsed) {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: 'user', content: text.trim() }]
        })
      });

      const claudeData = await claudeRes.json();
      if (!claudeRes.ok) throw new Error(`Claude API error: ${claudeData.error?.message || claudeRes.status}`);

      let rawText = claudeData.content[0].text.trim();
      console.log('INPUT:', text.trim());
      console.log('MODEL OUTPUT:', rawText);

      rawText = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      try {
        parsed = JSON.parse(rawText);
      } catch(e) {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); }
          catch(e2) { throw new Error(`Bad JSON from model: ${rawText.slice(0, 200)}`); }
        } else {
          throw new Error(`Bad JSON from model: ${rawText.slice(0, 200)}`);
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

    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'Unrecognised action from model' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'success',
        action: parsed.action,
        type:   parsed.type || parsed.action,
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
