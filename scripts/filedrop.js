#!/usr/bin/env node
// The file drop: agents save photos and documents from a chat here, so the Matiere Xero
// connector can attach them to a quote or invoice later (tools find_files / attach_file).
// Files live in the private Netlify Blobs store "file-drop". Nothing goes in git.
//   node scripts/filedrop.js add <file> --label "Frances cupboard before photo" [--job "..."] [--note "..."]
//   node scripts/filedrop.js list [words]
//   node scripts/filedrop.js get <id> <out-file>
//   node scripts/filedrop.js remove <id>        (only when Seb asked)
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const SITE = 'c5358d04-2f41-4b7f-bcef-f132c44476d7', STORE = 'file-drop', MAX = 10 * 1024 * 1024;
const TYPES = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx'];

function netlify(args) {
  try {
    return execFileSync('npx', ['-y', 'netlify-cli', ...args], { env: { ...process.env, NETLIFY_SITE_ID: SITE }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { throw new Error(`Netlify did not answer: ${String(e.stderr || e.message).trim().slice(0, 300)}`); }
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'filedrop-')); }
// Values are stored as plain text (files as base64), so nothing gets mangled on the way.
function put(key, text) {
  const d = tmpDir(), f = path.join(d, 'v');
  try { fs.writeFileSync(f, text, { mode: 0o600 }); netlify(['blobs:set', STORE, key, '--input', f, '--force']); } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function read(key) {
  const d = tmpDir(), f = path.join(d, 'v');
  try { netlify(['blobs:get', STORE, key, '--output', f]); return fs.readFileSync(f, 'utf8'); } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function keys() {
  const out = netlify(['blobs:list', STORE, '--json']);
  const j = JSON.parse(out.slice(out.indexOf('{')));
  return (j.blobs || []).map(b => b.key);
}
const allMeta = () => keys().filter(k => k.startsWith('meta/')).map(k => JSON.parse(read(k))).sort((a, b) => b.added.localeCompare(a.added));
const slug = s => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const when = iso => new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });

// Phone photos: HEIC becomes JPEG, and big pictures are shrunk (2400 px on the long side).
function prepare(file) {
  let ext = path.extname(file).slice(1).toLowerCase();
  if (!TYPES.includes(ext)) throw new Error(`This kind of file cannot go to Xero from here (.${ext}). Allowed: ${TYPES.join(', ')}.`);
  const size = fs.statSync(file).size;
  if (ext === 'heic' || (['jpg', 'jpeg', 'png', 'webp'].includes(ext) && size > 3 * 1024 * 1024)) {
    const d = tmpDir(), out = path.join(d, 'p.jpg');
    execFileSync('sips', ['-Z', '2400', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', out], { stdio: 'ignore' });
    const buf = fs.readFileSync(out); fs.rmSync(d, { recursive: true, force: true });
    return { buf, ext: 'jpg' };
  }
  return { buf: fs.readFileSync(file), ext: ext === 'jpeg' ? 'jpg' : ext };
}

function main(argv) {
  const [cmd, ...rest] = argv, opts = {}, words = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[++i] || ''; else words.push(rest[i]); }
  if (cmd === 'add') {
    if (!words[0] || !opts.label || !slug(opts.label)) throw new Error('Use: add <file> --label "who and what it is" [--job "..."] [--note "..."]');
    const { buf, ext } = prepare(words[0]);
    if (!buf.length) throw new Error('The file is empty.');
    if (buf.length > MAX) throw new Error(`The file is ${(buf.length / 1048576).toFixed(1)} MB; the limit is 10 MB.`);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const have = allMeta();
    const same = have.find(m => m.sha === sha);
    if (same) { console.log(`Already in the file drop: ${same.id}  "${same.label}" (${same.filename})`); return; }
    // Xero replaces an attachment that has the same name, so every file gets its own name.
    const taken = new Set(have.map(m => m.filename.toLowerCase()));
    let filename = `${slug(opts.label)}.${ext}`;
    for (let n = 2; taken.has(filename.toLowerCase()); n++) filename = `${slug(opts.label)}-${n}.${ext}`;
    const id = 'fd-' + crypto.randomBytes(4).toString('hex');
    const meta = { id, label: opts.label, job: opts.job || '', note: opts.note || '', filename, size: buf.length, sha, added: new Date().toISOString(), attached_to: [] };
    put(`data/${id}`, buf.toString('base64'));
    // Read it back before listing it, so a half-saved file is never offered for a quote.
    if (crypto.createHash('sha256').update(Buffer.from(read(`data/${id}`).trim(), 'base64')).digest('hex') !== sha) throw new Error('The saved copy does not match the file. Nothing was filed; try again.');
    put(`meta/${id}`, JSON.stringify(meta));
    console.log(`Filed ${id}  "${meta.label}"  ${filename}  ${Math.ceil(buf.length / 1024)} KB`);
  } else if (cmd === 'list') {
    const want = words.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
    const rows = allMeta().filter(m => want.every(w => `${m.id} ${m.label} ${m.job} ${m.note} ${m.filename}`.toLowerCase().includes(w)));
    if (!rows.length) console.log('Nothing in the file drop matches.');
    for (const m of rows) console.log(`${m.id}  ${when(m.added)}  "${m.label}"${m.job ? `  job: ${m.job}` : ''}  ${m.filename}  ${Math.ceil(m.size / 1024)} KB${(m.attached_to || []).length ? `  attached to ${m.attached_to.join(', ')}` : ''}`);
  } else if (cmd === 'get') {
    if (!words[1]) throw new Error('Use: get <id> <out-file>');
    fs.writeFileSync(words[1], Buffer.from(read(`data/${words[0]}`).trim(), 'base64'));
    console.log(`Saved ${words[1]}`);
  } else if (cmd === 'remove') {
    if (!words[0] || !keys().includes(`meta/${words[0]}`)) throw new Error('No file with that id.');
    netlify(['blobs:delete', STORE, `meta/${words[0]}`, '--force']);
    netlify(['blobs:delete', STORE, `data/${words[0]}`, '--force']);
    console.log(`Removed ${words[0]}`);
  } else throw new Error('Use: add | list | get | remove');
}
try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
