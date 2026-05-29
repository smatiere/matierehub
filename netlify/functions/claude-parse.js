// claude-parse.js
// Receives raw voice/text input → Claude Haiku parses it → writes to data.json via GitHub API
// Deployed as a Netlify serverless function

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
    // Get Sydney date (handles Netlify running in UTC)
    const sydneyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
    const todayStr  = sydneyNow.toISOString().slice(0, 10);

    const projectNames = (current.projects || []).map(p => p.name);
    const projectList  = projectNames.join(' | ');
    const tsCount      = (current.timesheets || []).length;
    const nextTsId     = `TS-${String(tsCount + 1).padStart(3, '0')}`;

    const systemPrompt = `You are a data entry parser for Matiere Pty Ltd, a carpentry and handyman business in Sydney, Australia.

Your job: parse voice or text input (may have transcription errors or abbreviations) into a clean JSON entry.

TODAY: ${todayStr}
PROJECTS: ${projectList}
NON-BILLABLE NAMES: Admin | Office | Wasted time | Holidays | Sick days | Carer days
SEB'S RATE: $100/hr ex GST

PARSING RULES:
- Hours input → type "timesheet". Expense/purchase/cost input → type "expense".
- Fuzzy-match project names aggressively. Examples:
    "nth balgo" or "north balgowlah" or "mark" → "Mark - Nth Balgowlah"
    "rob" or "rob balgo" or "balgowlah" → "Rob - Balgowlah"
    "ibk" or "mosman" → "IBK - Mosman"
    "neil" → "Neil - Balgowlah"
    "admin" or "office" or "admin work" → "Admin"
- If no date mentioned → use today (${todayStr})
- Parse hours flexibly: "4h"=4, "4 hours"=4, "half day"=4, "full day"=8, "3 and a half"=3.5
- For expenses, pick category from: Materials | Vehicle | Subcontractor | Equipment | Office | Other
- Clean descriptions: fix transcription errors, capitalise properly, be concise
- If a project is ambiguous but there's only one reasonable match, use it and note it
- Employee is always "Seb" unless stated otherwise

OUTPUT: Return ONLY a raw JSON object — no markdown, no explanation, no code fences.

Timesheet format:
{"type":"timesheet","date":"YYYY-MM-DD","project":"exact project name","hours":4,"employee":"Seb","notes":""}

Expense format:
{"type":"expense","date":"YYYY-MM-DD","description":"clean description","category":"Materials","project":"project name","amount":125.50}

If genuinely cannot parse (e.g. total gibberish):
{"type":"unclear","message":"brief explanation of what's missing"}`;

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
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: text.trim() }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(`Claude API error: ${claudeData.error?.message || claudeRes.status}`);

    // Parse response — extract JSON robustly
    let rawText = claudeData.content[0].text.trim();
    // Strip markdown code fences if present
    rawText = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch(e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error(`Could not parse Claude response: ${rawText.slice(0, 120)}`);
    }

    // Return if unclear
    if (parsed.type === 'unclear') {
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'unclear', message: parsed.message }) };
    }

    // ── 4. Add entry to data ────────────────────────────────────────────────
    let entryLabel = '';

    if (parsed.type === 'timesheet') {
      parsed.id     = nextTsId;
      parsed.rate   = 100;
      parsed.value  = Math.round(parsed.hours * 100 * 100) / 100;
      parsed.hours  = parseFloat(parsed.hours);
      if (!parsed.notes) parsed.notes = '';
      current.timesheets = current.timesheets || [];
      current.timesheets.push(parsed);
      entryLabel = `${parsed.hours}h on ${parsed.project}`;

    } else if (parsed.type === 'expense') {
      parsed.amount = parseFloat(parsed.amount);
      current.expense_log = current.expense_log || [];
      current.expense_log.push(parsed);
      entryLabel = `$${parsed.amount} — ${parsed.description.slice(0, 40)}`;

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
          message: `Voice entry: ${entryLabel}`,
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
        entry:   parsed,
        label:   entryLabel,
        commit:  pushData.commit.sha.slice(0, 7)
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
