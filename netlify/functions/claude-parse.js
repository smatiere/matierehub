// claude-parse.js
// Receives raw voice/text input → Claude Haiku parses it → writes to data.json via GitHub API
// Supports: log timesheet, log expense, delete entry, edit entry

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = 'smatiere/matierehub';
const GITHUB_FILE  = 'data.json';

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

  try {
    const { text } = JSON.parse(event.body || '{}');
    if (!text || !text.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No input text provided' }) };

    // ── 1. Fetch current data.json from GitHub ──────────────────────────────
    const ghRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'MatiereHub' } }
    );
    if (!ghRes.ok) throw new Error(`GitHub fetch failed: ${ghRes.status}`);
    const ghData  = await ghRes.json();
    const current = JSON.parse(Buffer.from(ghData.content, 'base64').toString('utf-8'));
    const sha     = ghData.sha;

    // ── 2. Build context ────────────────────────────────────────────────────
    // en-CA locale returns YYYY-MM-DD directly — no UTC round-trip, no date shifting
    const todayStr     = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const yesterdayStr = new Date(new Date(todayStr + 'T12:00:00').getTime() - 86400000)
                           .toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    const projectNames = (current.projects || []).map(p => p.name);
    const projectList  = projectNames.join(' | ');
    const tsCount      = (current.timesheets || []).length;

    // Recent entries — only needed for delete (ID matching) and single-entry edits
    const tsAll = current.timesheets || [];
    const recentTs = tsAll.slice(-20)
      .map(t => `  ID:${t.id} date:${t.date} project:"${t.project}" hours:${t.hours} notes:"${t.notes||''}"`).join('\n');
    const expAll = current.expense_log || [];
    const recentExp = expAll.slice(-10)
      .map((e, i) => `  EXP_IDX:${expAll.length - 10 + i} date:${e.date} desc:"${e.description}" amount:${e.amount}`).join('\n');

    const systemPrompt = `You are a data entry parser for Matiere Pty Ltd, a carpentry and handyman business in Sydney, Australia.

TODAY IS: ${todayStr}
YESTERDAY WAS: ${yesterdayStr}
PROJECTS: ${projectList}
NON-BILLABLE: Admin | Office | Wasted time | Holidays | Sick days | Carer days

RECENT TIMESHEETS (for delete/ID-based edits only):
${recentTs || '  (none)'}

RECENT EXPENSES:
${recentExp || '  (none)'}

━━━ INTENT ━━━
• "delete", "remove", "undo" → delete
• "fix hours", "change hours", "it was X not Y" → edit_timesheet (by ID)
• "note", "add note", "clarify", "annotate", "label" → edit_by_date (DO NOT use IDs)
• everything else → log timesheet or expense

━━━ DATE RULES ━━━
• "DATE:YYYY-MM-DD ..." at start → use that exact date (calendar popup prefix)
• bare date like "2026-05-29" → use it
• "today" → ${todayStr}  ← USE THIS EXACT STRING, do not guess
• "yesterday" → ${yesterdayStr}  ← USE THIS EXACT STRING
• "past two days" → dates: ${yesterdayStr} and ${todayStr}
• day name ("Monday") → calculate back from ${todayStr}
• nothing mentioned → ${todayStr}

━━━ PROJECT MATCHING ━━━
"nth balgo"/"mark" → "Mark - Nth Balgowlah"
"rob"/"rob balgo" → "Rob - Balgowlah"
"ibk"/"mosman" → "IBK - Mosman"
"neil" → "Neil - Balgowlah"
"admin"/"office" → "Admin"

━━━ HOURS ━━━ "4h"=4, "half day"=4, "full day"=8, "3.5"=3.5
━━━ EXPENSE CATEGORIES ━━━ Materials | Vehicle | Subcontractor | Equipment | Office | Other

OUTPUT: raw JSON only — no markdown, no fences.

LOG TIMESHEET:
{"type":"timesheet","date":"YYYY-MM-DD","project":"name","hours":4,"employee":"Seb","notes":""}

LOG EXPENSE:
{"type":"expense","date":"YYYY-MM-DD","description":"desc","category":"Materials","project":"name","amount":125.50}

DELETE TIMESHEET:
{"type":"delete_timesheet","id":"TS-007","reason":"why"}

DELETE EXPENSE:
{"type":"delete_expense","idx":5,"reason":"why"}

EDIT HOURS ON ONE ENTRY (use ID from list above):
{"type":"edit_timesheet","id":"TS-007","changes":{"hours":3},"reason":"why"}

ADD/EDIT NOTE OR FIELD BY DATE — use this for ALL note requests, never use IDs for notes:
{"type":"edit_by_date","date":"YYYY-MM-DD","project":null,"changes":{"notes":"the note text"},"reason":"why"}
  • date must be the resolved date string e.g. "${todayStr}" not the word "today"
  • project: use exact project name to target one project, or null to update all entries on that date
  • For "past two days": return TWO edit_by_date objects wrapped in {"type":"edit_by_date_multi","edits":[...]}

CANNOT PARSE:
{"type":"unclear","message":"brief explanation"}`;

    // ── 3. Call Claude Haiku ────────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: text.trim() }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(`Claude API error: ${claudeData.error?.message || claudeRes.status}`);

    // Parse response
    let rawText = claudeData.content[0].text.trim();
    rawText = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch(e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error(`Could not parse Claude response: ${rawText.slice(0, 120)}`);
    }

    if (parsed.type === 'unclear') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: parsed.message }) };
    }

    // ── 4. Apply action ────────────────────────────────────────────────────
    let entryLabel = '';
    let responseExtra = {};

    if (parsed.type === 'timesheet') {
      const nextTsId = `TS-${String(tsCount + 1).padStart(3, '0')}`;
      parsed.id     = nextTsId;
      parsed.rate   = 100;
      parsed.value  = Math.round(parsed.hours * 100 * 100) / 100;
      parsed.hours  = parseFloat(parsed.hours);
      if (!parsed.notes) parsed.notes = '';
      current.timesheets = current.timesheets || [];
      current.timesheets.push(parsed);
      entryLabel = `${parsed.hours}h on ${parsed.project} (${parsed.date})`;

    } else if (parsed.type === 'expense') {
      parsed.amount = parseFloat(parsed.amount);
      current.expense_log = current.expense_log || [];
      current.expense_log.push(parsed);
      entryLabel = `$${parsed.amount} — ${parsed.description.slice(0, 40)}`;

    } else if (parsed.type === 'delete_timesheet') {
      const idx = (current.timesheets||[]).findIndex(t => t.id === parsed.id);
      if (idx === -1) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: `Could not find timesheet entry ${parsed.id} to delete` }) };
      }
      const removed = current.timesheets.splice(idx, 1)[0];
      entryLabel = `Deleted ${removed.id}: ${removed.hours}h ${removed.project} (${removed.date})`;
      responseExtra = { deleted: removed };

    } else if (parsed.type === 'delete_expense') {
      const expenses = current.expense_log || [];
      const idx = parseInt(parsed.idx);
      if (isNaN(idx) || idx < 0 || idx >= expenses.length) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: `Could not find expense at index ${parsed.idx} to delete` }) };
      }
      const removed = expenses.splice(idx, 1)[0];
      current.expense_log = expenses;
      entryLabel = `Deleted expense: ${removed.description} $${removed.amount}`;
      responseExtra = { deleted: removed };

    } else if (parsed.type === 'edit_timesheet') {
      const ts = (current.timesheets||[]).find(t => t.id === parsed.id);
      if (!ts) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: `Could not find timesheet entry ${parsed.id} to edit` }) };
      }
      const changes = parsed.changes || {};
      Object.assign(ts, changes);
      if (changes.hours) {
        ts.hours  = parseFloat(ts.hours);
        ts.value  = Math.round(ts.hours * (ts.rate||100) * 100) / 100;
      }
      entryLabel = `Updated ${ts.id}: ${ts.hours}h on ${ts.project} (${ts.date})`;
      responseExtra = { updated: ts };

    } else if (parsed.type === 'edit_timesheets') {
      // Bulk edit by ID array (legacy path)
      const edits = parsed.edits || [];
      const updated = [];
      for (const edit of edits) {
        const ts = (current.timesheets||[]).find(t => t.id === edit.id);
        if (!ts) continue;
        const changes = edit.changes || {};
        Object.assign(ts, changes);
        if (changes.hours) { ts.hours = parseFloat(ts.hours); ts.value = Math.round(ts.hours*(ts.rate||100)*100)/100; }
        updated.push(ts);
      }
      if (!updated.length) return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'No matching entries found to update' }) };
      entryLabel = `Updated ${updated.length} entr${updated.length>1?'ies':'y'}: ${updated.map(t=>t.id).join(', ')}`;
      responseExtra = { updated };

    } else if (parsed.type === 'edit_by_date' || parsed.type === 'edit_by_date_multi') {
      // Date-based edit — server does the matching, not Haiku
      // Normalise to an array of {date, project, changes}
      const editOps = parsed.type === 'edit_by_date_multi'
        ? (parsed.edits || [])
        : [{ date: parsed.date, project: parsed.project || null, changes: parsed.changes || {} }];

      const updated = [];
      for (const op of editOps) {
        for (const ts of (current.timesheets || [])) {
          if (ts.date !== op.date) continue;
          if (op.project && ts.project !== op.project) continue;
          Object.assign(ts, op.changes);
          if (op.changes.hours) { ts.hours = parseFloat(ts.hours); ts.value = Math.round(ts.hours*(ts.rate||100)*100)/100; }
          updated.push(ts);
        }
      }
      if (!updated.length) {
        const dates = editOps.map(o=>o.date).join(', ');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: `No timesheet entries found for ${dates}` }) };
      }
      entryLabel = `Updated ${updated.length} entr${updated.length>1?'ies':'y'} on ${[...new Set(editOps.map(o=>o.date))].join(', ')}`;
      responseExtra = { updated };

    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'Unknown entry type returned by parser.' }) };
    }

    current.meta              = current.meta || {};
    current.meta.last_updated = new Date().toISOString();

    // ── 5. Push updated data.json to GitHub ─────────────────────────────────
    const newContent = Buffer.from(JSON.stringify(current, null, 2)).toString('base64');
    const pushRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'MatiereHub'
        },
        body: JSON.stringify({
          message: `Hub entry: ${entryLabel}`,
          content: newContent,
          sha,
          branch: 'main'
        })
      }
    );

    const pushData = await pushRes.json();
    if (!pushRes.ok) throw new Error(`GitHub push failed: ${pushData.message}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status:  'success',
        type:    parsed.type,
        entry:   parsed,
        label:   entryLabel,
        commit:  pushData.commit.sha.slice(0, 7),
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
