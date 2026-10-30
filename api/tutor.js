// Vercel function: AI tutor for subscribed students.
// Env vars: ANTHROPIC_API_KEY, FIREBASE_API_KEY (public web apiKey from your site). Optional: FIREBASE_PROJECT_ID, OWNER_EMAIL.
const hits = new Map();
const PROJECT = () => process.env.FIREBASE_PROJECT_ID || 'admin-panel-d9ffa';
const OWNER = () => (process.env.OWNER_EMAIL || 'examplanner.pack@gmail.com').toLowerCase();
async function who(token) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }) });
  const j = await r.json();
  const u = r.ok && j.users && j.users[0];
  return u ? { uid: u.localId, email: String(u.email || '').toLowerCase() } : null;
}
async function subscribed(token, email, exam) {
  if (email === OWNER()) return true;
  if (!email) return false;
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT()}/databases/(default)/documents/entitlements/${encodeURIComponent(email)}`, { headers: { authorization: 'Bearer ' + token } });
  if (!r.ok) return false;
  const f = (await r.json()).fields || {};
  const exams = ((f.exams || {}).arrayValue || {}).values || [];
  const until = (f.until || {}).stringValue;
  if (until && new Date(until + 'T23:59:59Z') < new Date()) return false;
  return exams.some(v => String(v.stringValue).toLowerCase() === String(exam).toLowerCase());
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  let me = null;
  try { me = token && await who(token); } catch (e) {}
  if (!me) return res.status(401).json({ error: 'Please log in to use the AI tutor.' });
  const b = req.body || {}, exam = String(b.exam || 'SSC').slice(0, 40);
  if (!(await subscribed(token, me.email, exam))) return res.status(403).json({ error: `The ${exam} AI Tutor is for ${exam} plan subscribers. Open Plans & Pricing to subscribe.` });
  const now = Date.now(), rec = (hits.get(me.uid) || []).filter(t => now - t < 60000);
  if (rec.length >= 10) return res.status(429).json({ error: 'Too many questions at once. Wait a minute and try again.' });
  rec.push(now); hits.set(me.uid, rec);
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2500) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) return res.status(400).json({ error: 'No question' });
  const lang = String(b.language || 'English').slice(0, 30);
  const system = `You are ${String(b.name || 'AI Tutor').slice(0, 40)}, a friendly expert tutor for the ${exam} exam (India). Subject: ${String(b.subject || '').slice(0, 60)}. Topic: ${String(b.topic || '').slice(0, 100)}.
LANGUAGE: write the whole reply in ${lang}. Keep formulas, numbers and standard exam terms clear (add the English term in brackets when helpful).
STYLE: very simple and short, about 150-220 words, short sentences, no jargon, like a kind teacher talking to a beginner.
WHEN TEACHING A TOPIC use exactly this format: 💡 Idea (2-3 simple lines) · ⚡ Shortcut/Trick (say when it works and when it does NOT) · ✅ One solved example, step by step · ⚠️ Common traps · ⭐ Exam pattern (what kinds of questions come from this topic, in plain words; never claim exact counts, years or that a question was asked in a particular exam) · 🧠 One quick check question for the student.
WHEN EXPLAINING A QUESTION use: ✅ Answer · 🪜 Simple solution in steps · ⚡ Faster way if any · ❌ Why the other options are wrong · 📌 Remember this.
WHEN GIVING IMPORTANT QUESTIONS write original exam-style questions with options, the answer and a one-line solution.
RULES: Never invent facts. For current affairs or recent changes, say your knowledge may be outdated and to check an official source. If a question is wrong or unclear, say so. Stay on exam preparation; politely decline anything else.
Owner's extra instructions: ${String(b.extra || '').slice(0, 600)}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1400, system, messages: msgs }) });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'The tutor is busy. Please try again.' });
    res.status(200).json({ reply: ((j.content || [])[0] || {}).text || '' });
  } catch (e) { res.status(500).json({ error: 'The tutor is busy. Please try again.' }); }
};
