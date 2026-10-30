// Vercel function: video lessons backend.
// action "get"    (student, Bearer token): checks login + plan on the server, returns the video URL.
// action "upload" (admin, x-admin-key): returns a presigned PUT URL so you can upload an MP4 to Cloudflare R2 / any S3 storage.
// action "script" (admin, x-admin-key): drafts a teaching script with Claude for you to review.
// Env: FIREBASE_API_KEY, ANTHROPIC_API_KEY, ADMIN_KEY. Optional storage: S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET, S3_REGION(auto).
const crypto = require('crypto');
const PROJECT = () => process.env.FIREBASE_PROJECT_ID || 'admin-panel-d9ffa';
const OWNER = () => (process.env.OWNER_EMAIL || 'examplanner.pack@gmail.com').toLowerCase();
const FS = () => `https://firestore.googleapis.com/v1/projects/${PROJECT()}/databases/(default)/documents`;
const hm = (k, d, enc) => crypto.createHmac('sha256', k).update(d).digest(enc);
const sha = d => crypto.createHash('sha256').update(d).digest('hex');

function presign(method, key, secs) { // AWS SigV4 query-string signing, no dependencies
  const ep = new URL(process.env.S3_ENDPOINT), reg = process.env.S3_REGION || 'auto', host = ep.host;
  const t = new Date().toISOString().replace(/[-:]|\.\d+/g, ''), day = t.slice(0, 8), scope = `${day}/${reg}/s3/aws4_request`;
  const path = '/' + process.env.S3_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': process.env.S3_KEY + '/' + scope, 'X-Amz-Date': t, 'X-Amz-Expires': String(secs), 'X-Amz-SignedHeaders': 'host' };
  const qs = Object.keys(q).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
  const canon = [method, path, qs, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', t, scope, sha(canon)].join('\n');
  const k = hm(hm(hm(hm('AWS4' + process.env.S3_SECRET, day), reg), 's3'), 'aws4_request');
  return `${ep.origin}${path}?${qs}&X-Amz-Signature=${hm(k, sts, 'hex')}`;
}
const s3on = () => process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_KEY && process.env.S3_SECRET;
const signed = v => (s3on() && v && v.startsWith('r2:')) ? presign('GET', v.slice(3), 6 * 3600) : v; // "r2:path/file.mp4" -> short-lived link

async function who(token) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  const j = await r.json(); const u = r.ok && j.users && j.users[0];
  return u ? String(u.email || '').toLowerCase() : null;
}
async function subscribed(token, email, exam) { // same rule as tutor.js
  if (email === OWNER()) return true;
  const r = await fetch(`${FS()}/entitlements/${encodeURIComponent(email)}`, { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) return false;
  const f = (await r.json()).fields || {}, until = (f.until || {}).stringValue;
  if (until && new Date(until + 'T23:59:59Z') < new Date()) return false;
  return (((f.exams || {}).arrayValue || {}).values || []).some(v => String(v.stringValue).toLowerCase() === String(exam).toLowerCase());
}
async function cfgLesson(id) { // public metadata lives in site_config/main (the same config your admin panel saves)
  const r = await fetch(`${FS()}/site_config/main`); if (!r.ok) return null;
  const c = JSON.parse(((await r.json()).fields.config || {}).stringValue || '{}');
  return (c.vlessons || []).find(x => x.id === id && x.status === 'published') || null;
}
async function media(token, id) { // private doc: readable only through Firestore rules (see README)
  const r = await fetch(`${FS()}/lesson_private/${encodeURIComponent(id)}`, { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) return null; const f = (await r.json()).fields || {};
  return { url: (f.url || {}).stringValue || '', lo: (f.lo || {}).stringValue || '' };
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = req.body || {}, act = b.action || 'get';
  if (act !== 'get') {
    if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Wrong admin key' });
    try {
      if (act === 'upload') {
        if (!s3on()) return res.status(501).json({ error: 'Storage not configured. Set S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET, or paste a video URL instead.' });
        const key = 'lessons/' + String(b.id || Date.now()).replace(/[^\w-]/g, '') + '-' + Date.now() + '.mp4';
        return res.status(200).json({ put: presign('PUT', key, 3600), ref: 'r2:' + key });
      }
      if (act === 'script') {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 2500, messages: [{ role: 'user', content: `Write a classroom video script for the ${String(b.exam).slice(0, 40)} exam (India), subject ${String(b.subject).slice(0, 60)}, topic "${String(b.topic).slice(0, 100)}", in ${b.lang === 'Hindi' ? 'Hindi (Devanagari)' : 'English'}, about 5 minutes. Format: numbered scenes. Each scene: NARRATION (spoken, simple, short sentences) and SCREEN (exact on-screen text, numbers, formulas, animation). Include a hook, concept, shortcut (say when it fails), 2 solved examples step by step, common traps, a recap. Never invent facts or claim exact exam counts.` }] }) });
        const j = await r.json(); if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'AI error' });
        return res.status(200).json({ script: ((j.content || [])[0] || {}).text || '' });
      }
      return res.status(400).json({ error: 'Unknown action' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  let email = null; try { email = token && await who(token); } catch (e) {}
  if (!email) return res.status(401).json({ error: 'Please log in to watch lessons.' });
  try {
    const L = await cfgLesson(String(b.id || ''));
    if (!L) return res.status(404).json({ error: 'This lesson is not available.' });
    if (!L.free && !(await subscribed(token, email, L.exam))) return res.status(403).json({ error: `This lesson is for ${L.exam} plan subscribers. Open Plans & Pricing to subscribe.` });
    const m = await media(token, L.id);
    if (!m || !m.url) return res.status(404).json({ error: 'The video for this lesson is not uploaded yet.' });
    res.setHeader('cache-control', 'private, no-store');
    res.status(200).json({ url: signed(m.url), lo: m.lo ? signed(m.lo) : '' });
  } catch (e) { res.status(500).json({ error: 'Could not load the lesson. Try again.' }); }
};
