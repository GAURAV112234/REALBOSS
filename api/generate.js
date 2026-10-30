// Vercel function: writes original SSC CGL Tier-1 style MCQs, then re-solves them blind and keeps only matching answers.
const KEY = () => process.env.ANTHROPIC_API_KEY;
async function ask(prompt, max) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: max, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'AI error');
  return ((j.content || [])[0] || {}).text || '';
}
const lastArr = (t) => { const m = [...t.matchAll(/\[[^\[\]]*\]/g)]; return m.length ? JSON.parse(m[m.length - 1][0]) : []; };
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Wrong admin key' });
  const b = req.body || {}, n = Math.min(+b.n || 10, 12), topics = (b.topics || []).slice(0, 4).join(', ');
  try {
    const g = await ask(`You are a senior SSC CGL Tier-1 paper setter. Write ${n + 2} ORIGINAL multiple-choice questions for the section "${b.section}", mixing these topics: ${topics}. Mock test number ${b.mock}: use fresh numbers, names and situations.
Level: real SSC CGL Tier-1 exam. About 20% easy, 50% moderate, 30% hard (top-level, multi-step, the kind that separates 150+ scorers). No trivial questions.
Rules: each question fully self-contained and text-only (no figures, no passages, no tables). Exactly one correct option. Plausible wrong options. Do not copy any real paper. For General Awareness use only stable, well-established facts (no current affairs).
Return ONLY a JSON array: [{"topic":"","question":"","options":["","","",""],"answer":"A","explanation":"short step-by-step solution under 60 words"}]. Options without A/B/C/D prefixes.`, 6000);
    const m = g.match(/\[[\s\S]*\]/);
    const cl = (m ? JSON.parse(m[0]) : []).filter(q => q && q.question && Array.isArray(q.options) && q.options.length === 4 && q.options.every(Boolean) && 'ABCD'.includes(String(q.answer).trim().toUpperCase().charAt(0)));
    const s = await ask(`Solve each question independently and carefully. Work briefly, then end your reply with ONLY a JSON array of answer letters in order, e.g. ["A","C"]. Exactly ${cl.length} letters.\n` + JSON.stringify(cl.map(q => ({ q: q.question, options: q.options }))), 4000);
    const sol = lastArr(s);
    const ok = cl.filter((q, i) => String(sol[i] || '').trim().toUpperCase().charAt(0) === String(q.answer).trim().toUpperCase().charAt(0));
    res.status(200).json({ questions: ok.slice(0, n), generated: cl.length, verified: ok.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
