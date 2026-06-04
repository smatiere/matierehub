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

    // ── 3. Prompt — build dynamic examples from live project list ───────────
    // Use the first active project as the "mark" example so examples never go stale
    const exampleProject = projectList[0] || 'Mark Shippen – Nth Balgowlah';
    const exampleProject2 = projectList.find(p => p.toLowerCase().includes('rob')) || projectList[1] || exampleProject;
    const exampleProject3 = projectList.find(p => p.toLowerCase().includes('ibk') || p.toLowerCase().includes('mosman')) || projectList[2] || exampleProject;
    const exampleProject4 = projectList.find(p => p.toLowerCase().includes('neil')) || projectList[3] || exampleProject;

    const systemPrompt = `You are a data entry parser for a carpentry business. Output ONE JSON object only — no explanation, no markdown, no extra text.

TODAY: ${todayStr}
YESTERDAY: ${yesterdayStr}
ACTIVE PROJECTS: ${projectNames}
NON-BILLABLE: Admin, Office, Wasted time, Holidays, Sick days, Carer days

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

Schema: {"action":"new","type":"expense","date":"YYYY-MM-DD","description":"full description","category":"Category","project":"Project or empty","amount":125.50}

Examples:
"$280 bunnings materials"                    → {"action":"new","type":"expense","date":"${todayStr}","description":"Bunnings - materials","category":"Materials","project":"","amount":280}
"spent 85 on screws and nails at Mitre 10"  → {"action":"new","type":"expense","date":"${todayStr}","description":"Mitre 10 - screws and nails","category":"Materials","project":"","amount":85}
"$62 fuel"                                   → {"action":"new","type":"expense","date":"${todayStr}","description":"Fuel","category":"Vehicle","project":"","amount":62}
"160 parking fine seaforth"                  → {"action":"new","type":"expense","date":"${todayStr}","description":"Parking fine - Seaforth","category":"Vehicle","project":"","amount":160}
"sub 400 for neil plasterer"                 → {"action":"new","type":"expense","date":"${todayStr}","description":"Subcontractor - plasterer","category":"Subcontractor","project":"${exampleProject4}","amount":400}

EXPENSE CATEGORIES: Materials, Vehicle, Subcontractor, Equipment, Office, Other
Dollar sign is optional — a number with a $ or near a store/item name = expense.
If no project is obvious from context, leave project as empty string "".

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
- If unsure, pick the closest name from ACTIVE PROJECTS. Do NOT invent a new name.
- "mark", "nth balgo", "mark shippen", "balgowlah" (without "walkway") → "${exampleProject}"
- "rob" → project containing "Rob"
- "ibk", "mosman" → project containing "IBK" or "Mosman"
- "neil" → project containing "Neil"
- "walkway" → project containing "Walkway"
- "admin", "office", "sick", "holiday", "carer" → matching NON-BILLABLE category
- Only set "new_project":true if input explicitly contains the words "new project"

If you cannot confidently parse the input: {"action":"unclear","message":"brief plain-english reason"}`;

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
    const NON_BILLABLE = ['Admin', 'Office', 'Wasted time', 'Holidays', 'Sick days', 'Carer days'];
    if (parsed.action === 'new' && parsed.type === 'timesheet' && parsed.project) {
      const validProjects = [...projectList, ...NON_BILLABLE];

      if (parsed.new_project) {
        // "new project" intent — create it if not already in the list
        const alreadyExists = validProjects.some(p => p.toLowerCase() === parsed.project.toLowerCase());
        if (!alreadyExists) {
          current.projects = current.projects || [];
          current.projects.push({
            name: parsed.project,
            status: 'Active',
            quoted: 0,
            notes: `Created ${new Date().toISOString().slice(0,10)}`
          });
          // Refresh projectList after adding
          projectList.push(parsed.project);
        }
        // Use the exact name as given (or normalise to existing if duplicate)
        const canonical = [...projectList, ...NON_BILLABLE].find(p => p.toLowerCase() === parsed.project.toLowerCase());
        if (canonical) parsed.project = canonical;
      } else {
        // Try exact match first (case-insensitive)
        const exactMatch = validProjects.find(p => p.toLowerCase() === parsed.project.toLowerCase());
        if (exactMatch) {
          parsed.project = exactMatch;
        } else {
          // Fuzzy consolidation: score each valid project by token overlap with the returned name
          // This catches "Mark - Nth Balgowlah" → "Mark Shippen – Nth Balgowlah"
          const tokenise = str => str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
          const returnedTokens = tokenise(parsed.project);
          let bestMatch = null;
          let bestScore = 0;
          for (const p of validProjects) {
            const pTokens = tokenise(p);
            const overlap = returnedTokens.filter(t => pTokens.includes(t)).length;
            // Score = overlap / max(returned length, project length) — penalises short spurious matches
            const score = overlap / Math.max(returnedTokens.length, pTokens.length);
            if (score > bestScore) { bestScore = score; bestMatch = p; }
          }
          // Accept the fuzzy match only if overlap is meaningful (>50% token match)
          if (bestMatch && bestScore >= 0.5) {
            console.log(`Fuzzy match: "${parsed.project}" → "${bestMatch}" (score ${bestScore.toFixed(2)})`);
            parsed.project = bestMatch;
          } else {
            return { statusCode: 200, headers, body: JSON.stringify({
              status: 'unclear',
              message: `Unknown project "${parsed.project}". Valid projects: ${projectList.join(', ')}`
            })};
          }
        }
      }
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

    // ── 6. Push to GitHub (with retry on SHA conflict) ──────────────────────
    let pushData;
    let currentForPush = current;
    let shaForPush = sha;

    for (let attempt = 0; attempt < 3; attempt++) {
      const newContent = Buffer.from(JSON.stringify(currentForPush, null, 2)).toString('base64');
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
            sha: shaForPush,
            branch: 'main'
          })
        }
      );

      pushData = await pushRes.json();

      if (pushRes.ok) break; // success

      // 409 or 422 = SHA conflict — someone else pushed between our read and write.
      // GitHub returns 422 "sha does not match" for stale SHAs (not 409).
      // Re-fetch the latest version, re-apply our action on top of it, then retry.
      if ((pushRes.status === 409 || pushRes.status === 422) && attempt < 2) {
        console.log(`SHA conflict on attempt ${attempt + 1}, re-fetching and retrying...`);
        const ghRetry = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
          { headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'MatiereHub' } }
        );
        if (!ghRetry.ok) throw new Error(`GitHub re-fetch failed: ${ghRetry.status}`);
        const ghRetryData = await ghRetry.json();
        const freshData = JSON.parse(Buffer.from(ghRetryData.content, 'base64').toString('utf-8'));
        shaForPush = ghRetryData.sha;

        // Re-apply our action onto the fresh copy
        if (parsed.action === 'new' && parsed.type === 'timesheet') {
          freshData.timesheets = freshData.timesheets || [];
          // Avoid duplicate if somehow already applied
          if (!freshData.timesheets.find(t => t.id === responseExtra.entry?.id)) {
            freshData.timesheets.push(responseExtra.entry);
          }
        } else if (parsed.action === 'new' && parsed.type === 'expense') {
          freshData.expense_log = freshData.expense_log || [];
          freshData.expense_log.push(responseExtra.entry);
        } else if (parsed.action === 'delete') {
          const idx = (freshData.timesheets || []).findIndex(t => t.id === parsed.id);
          if (idx !== -1) freshData.timesheets.splice(idx, 1);
        } else if (parsed.action === 'edit') {
          for (const ts of (freshData.timesheets || [])) {
            if (ts.date !== parsed.date) continue;
            if (parsed.project && ts.project !== parsed.project) continue;
            Object.assign(ts, parsed.changes || {});
            if (parsed.changes?.hours) {
              ts.hours = parseFloat(ts.hours);
              ts.value = Math.round(ts.hours * (ts.rate || 100) * 100) / 100;
            }
          }
        }
        freshData.meta = freshData.meta || {};
        freshData.meta.last_updated = new Date().toISOString();
        currentForPush = freshData;
        continue; // retry loop
      }

      // Any other error — bail out
      throw new Error(`GitHub push failed: ${pushData.message}`);
    }

    if (!pushData?.commit) throw new Error(`GitHub push failed after retries: ${pushData?.message}`);

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
