// claude-parse.js — simplified prompt, claude-sonnet-4-6 for reliability

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

    // ── 1. Fetch current data.json ──────────────────────────────────────────
    const ghRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
      { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'MatiereHub' } }
    );
    if (!ghRes.ok) throw new Error(`GitHub fetch failed: ${ghRes.status}`);
    const ghData  = await ghRes.json();
    const current = JSON.parse(Buffer.from(ghData.content, 'base64').toString('utf-8'));
    const sha     = ghData.sha;

    // ── 2. Date context ─────────────────────────────────────────────────────
    const todayStr     = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const yesterdayStr = new Date(new Date(todayStr + 'T12:00:00').getTime() - 86400000)
                           .toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    const projectList  = (current.projects || []).map(p => p.name);
    const projectNames = projectList.join(', ');

    // Safe next ID — scan max existing numeric suffix rather than using length
    // (length-based breaks after any delete)
    const existingIds = (current.timesheets || [])
      .map(t => parseInt((t.id || '').replace('TS-', ''), 10))
      .filter(n => !isNaN(n));
    const nextNum = existingIds.length ? Math.max(...existingIds) + 1 : 1;
    const nextId  = `TS-${String(nextNum).padStart(3, '0')}`;

    // Recent entries — for delete matching only
    const recentTs = (current.timesheets || []).slice(-15)
      .map(t => `${t.id} | ${t.date} | ${t.project} | ${t.hours}h | notes: "${t.notes||''}"`)
      .join('\n');

    // ── 3. Prompt ───────────────────────────────────────────────────────────
    const systemPrompt = `You are a parser for a carpentry business timesheet app. Output ONE JSON object only — no explanation, no markdown.

TODAY: ${todayStr}
YESTERDAY: ${yesterdayStr}
PROJECTS: ${projectNames}
NON-BILLABLE: Admin, Office, Wasted time, Holidays, Sick days, Carer days

---
THREE POSSIBLE ACTIONS:

ACTION 1 — new entry (logging hours or an expense):
{"action":"new","type":"timesheet","date":"YYYY-MM-DD","project":"Name","hours":4,"notes":"","employee":"Seb"}
{"action":"new","type":"expense","date":"YYYY-MM-DD","description":"desc","category":"Materials","project":"Name","amount":125.50}

ACTION 2 — edit existing entries (change notes, hours, or any field):
{"action":"edit","date":"YYYY-MM-DD","project":"Name or null","changes":{"notes":"the note text"}}
- Use this for: "add note", "note that", "annotate", "change note", "fix hours", "update", "correct"
- project: exact name to target one project only, or null to update all entries on that date
- changes: only include fields that should change e.g. {"notes":"MatiereHub"} or {"hours":3}

ACTION 3 — delete one entry by ID:
{"action":"delete","id":"TS-007"}

---
RECENT ENTRIES (for delete — match by ID):
${recentTs || '(none yet)'}

---
DATE RULES:
- Input starting with DATE:YYYY-MM-DD → use that exact date (e.g. DATE:2026-05-22 4h Admin → date=2026-05-22)
- "today" → ${todayStr}
- "yesterday" → ${yesterdayStr}
- day name e.g. "Monday" → calculate from today ${todayStr}
- no date mentioned → ${todayStr}

PROJECT MATCHING (fuzzy):
"nth balgo" or "mark" → "Mark - Nth Balgowlah"
"rob" or "rob balgo" → "Rob - Balgowlah"
"ibk" or "mosman" → "IBK - Mosman"
"neil" → "Neil - Balgowlah"
"admin" or "office" → "Admin"

HOURS: "4h"=4, "half day"=4, "full day"=8, "3 and a half"=3.5
EXPENSE CATEGORIES: Materials, Vehicle, Subcontractor, Equipment, Office, Other

If you cannot parse the input: {"action":"unclear","message":"brief reason"}`;

    // ── 4. Call Claude Sonnet ───────────────────────────────────────────────
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

    // Parse JSON from response
    let rawText = claudeData.content[0].text.trim();
    console.log('INPUT:', text.trim());
    console.log('MODEL OUTPUT:', rawText);

    rawText = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch(e) {
      // Greedy match — handles nested objects e.g. {"changes":{"notes":"text"}}
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch(e2) { throw new Error(`Bad JSON from model: ${rawText.slice(0, 200)}`); }
      } else {
        throw new Error(`Bad JSON from model: ${rawText.slice(0, 200)}`);
      }
    }
    console.log('PARSED ACTION:', JSON.stringify(parsed));

    if (parsed.action === 'unclear') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: parsed.message }) };
    }

    // ── Server-side project validation ──────────────────────────────────────
    // Non-billable categories that are always valid even if not in projects list
    const NON_BILLABLE = ['Admin', 'Office', 'Wasted time', 'Holidays', 'Sick days', 'Carer days'];
    if (parsed.action === 'new' && parsed.type === 'timesheet' && parsed.project) {
      const validProjects = [...projectList, ...NON_BILLABLE];
      const isValid = validProjects.some(p => p.toLowerCase() === parsed.project.toLowerCase());
      if (!isValid) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `Unknown project "${parsed.project}". Valid projects: ${projectList.join(', ')}`
        })};
      }
      // Normalise casing to match the stored project name exactly
      const match = validProjects.find(p => p.toLowerCase() === parsed.project.toLowerCase());
      if (match) parsed.project = match;
    }

    // ── 5. Apply action ─────────────────────────────────────────────────────
    let entryLabel = '';
    let responseExtra = {};

    if (parsed.action === 'new') {
      if (parsed.type === 'timesheet') {
        const entry = {
          id:       nextId,
          date:     parsed.date,
          project:  parsed.project,
          hours:    parseFloat(parsed.hours),
          employee: parsed.employee || 'Seb',
          notes:    parsed.notes || '',
          rate:     100,
          value:    parseFloat(parsed.hours) * 100
        };
        current.timesheets = current.timesheets || [];
        current.timesheets.push(entry);
        entryLabel = `${entry.hours}h on ${entry.project} (${entry.date})`;
        responseExtra = { entry };

      } else if (parsed.type === 'expense') {
        const entry = {
          date:        parsed.date,
          description: parsed.description,
          category:    parsed.category || 'Other',
          project:     parsed.project || '',
          amount:      parseFloat(parsed.amount)
        };
        current.expense_log = current.expense_log || [];
        current.expense_log.push(entry);
        entryLabel = `$${entry.amount} — ${entry.description.slice(0, 40)}`;
        responseExtra = { entry };

      } else {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'Unknown entry type' }) };
      }

    } else if (parsed.action === 'edit') {
      // Server-side matching by date + optional project
      const targetDate    = parsed.date;
      const targetProject = parsed.project || null;
      const changes       = parsed.changes || {};

      const updated = [];
      for (const ts of (current.timesheets || [])) {
        if (ts.date !== targetDate) continue;
        if (targetProject && ts.project !== targetProject) continue;
        Object.assign(ts, changes);
        if (changes.hours) {
          ts.hours  = parseFloat(ts.hours);
          ts.value  = Math.round(ts.hours * (ts.rate || 100) * 100) / 100;
        }
        updated.push(ts);
      }

      if (!updated.length) {
        return { statusCode: 200, headers, body: JSON.stringify({
          status: 'unclear',
          message: `No timesheet entries found for ${targetDate}${targetProject ? ' / ' + targetProject : ''}`
        })};
      }

      entryLabel = `Updated ${updated.length} entr${updated.length > 1 ? 'ies' : 'y'} on ${targetDate}`;
      responseExtra = { updated };

    } else if (parsed.action === 'delete') {
      const idx = (current.timesheets || []).findIndex(t => t.id === parsed.id);
      if (idx === -1) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: `Entry ${parsed.id} not found` }) };
      }
      const removed = current.timesheets.splice(idx, 1)[0];
      entryLabel = `Deleted ${removed.id}: ${removed.hours}h ${removed.project} (${removed.date})`;
      responseExtra = { deleted: removed };

    } else {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: 'Unrecognised action from model' }) };
    }

    current.meta              = current.meta || {};
    current.meta.last_updated = new Date().toISOString();

    // ── 6. Push to GitHub ───────────────────────────────────────────────────
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
          message: `Hub: ${entryLabel}`,
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
        status: 'success',
        action: parsed.action,
        type:   parsed.type || parsed.action,
        label:  entryLabel,
        commit: pushData.commit.sha.slice(0, 7),
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
