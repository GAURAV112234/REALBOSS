// Vercel serverless function: turns PDF text into MCQ JSON using Claude.
// Needs env vars: ANTHROPIC_API_KEY and ADMIN_KEY (a password you choose).
const PROMPT = `Extract every complete multiple-choice question from the text below.
Return ONLY a JSON array, no other text. Each item:
{"section":"","topic":"","question":"","options":["A text","B text","C text","D text"],"answer":"A","explanation":"","solved":false}
Rules: exactly 4 options without the "A)" prefixes. If an answer key is in the text, use it. If not, solve the question yourself and set "solved":true. Skip incomplete or non-MCQ items. Keep the original language (English or Hindi). Do not invent questions.

TEXT:
`;
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'Wrong admin key' });
  const text = String((req.body || {}).text || '').slice(0, 40000);
  if (!text.trim()) return res.status(400).json({ error: 'No text' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 6000, messages: [{ role: 'user', content: PROMPT + text }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'AI error' });
    const out = ((j.content || [])[0] || {}).text || '[]';
    const m = out.match(/\[[\s\S]*\]/);
    res.status(200).json({ questions: m ? JSON.parse(m[0]) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
