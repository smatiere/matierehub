// Turns a quick job note ("electrician Tuesday next week") into a clear note with real dates.
// POST { text, today, job } -> { ok, note }. Uses Claude Haiku; ANTHROPIC_API_KEY lives in Netlify.
const { guardHub } = require('../lib/hub-guard');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-hub-token, x-hub-key',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  const denied = guardHub(event, headers);
  if (denied) return denied;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  try {
    const { text, today, job } = JSON.parse(event.body || '{}');
    if (!text || !String(text).trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No text' }) };
    const todayStr = today || new Date().toISOString().slice(0, 10);
    const dow = new Date(todayStr + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long' });
    const system = `You tidy short job notes for a carpenter's schedule (Sydney, Australia). Today is ${dow} ${todayStr}.
Rewrite the note as clear, short plain English (1-3 lines max). Turn every relative date ("Tuesday next week", "tomorrow", "in 2 weeks") into an exact date like "Tue 10 Nov" using today's date; "next week" means the week starting the coming Monday. Keep who/what is waiting on whom. If something sounds like a follow-up that needs doing, end with a line starting "Follow up:" and the date. Never invent facts, names or times that were not given. Output only the note text, no preface.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300, system,
        messages: [{ role: 'user', content: (job ? 'Job: ' + job + '\n' : '') + 'Note: ' + text }]
      })
    });
    const out = await res.json();
    if (!res.ok) throw new Error((out.error && out.error.message) || 'Claude error ' + res.status);
    const note = ((out.content || []).find(c => c.type === 'text') || {}).text || '';
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, note: note.trim() }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
