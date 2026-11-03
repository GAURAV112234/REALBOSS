/*
  Automatic access after payment.

  Razorpay calls this function when a payment link is paid. It finds the
  student's email, the exam and the number of months, then writes
  entitlements/<email> in Firestore, the same record the Admin > Subscribers
  tab creates. The student logs in and the plan is already active.

  Put this file in the "api" folder of your repo (api/razorpay-webhook.js).
  No package.json or extra libraries are needed.

  Vercel environment variables (Project > Settings > Environment Variables):
    RAZORPAY_WEBHOOK_SECRET   the secret you type in the Razorpay webhook form
    FIREBASE_SERVICE_ACCOUNT  the full JSON of a Firebase service account key
*/
const crypto = require('crypto');

const PROJECT_ID = 'admin-panel-d9ffa';

// Exam word in the payment link title -> label stored for the student.
const EXAMS = [
  [/\bssc\b/i, 'SSC'],
  [/\brrb\b|railway/i, 'RRB'],
  [/\bbank(ing)?\b|ibps|sbi/i, 'Banking'],
  [/\bdef(ence|ense)?\b|\bnda\b|\bcds\b/i, 'Defence'],
  [/\bupsc\b|\bias\b/i, 'UPSC'],
];

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function b64url(x) {
  return Buffer.from(x).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function googleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key)
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + head + '.' + claim + '.' + sig,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google token failed: ' + JSON.stringify(j));
  return j.access_token;
}

function pick(text) {
  text = String(text || '');
  let exam = null;
  for (const [re, label] of EXAMS) if (re.test(text)) { exam = label; break; }
  const m = text.match(/(\d+)\s*(?:-|\s)?\s*(?:month|mo\b)/i);
  return { exam, months: m ? parseInt(m[1], 10) : null };
}

function addMonths(isoDay, months) {
  const d = new Date(isoDay + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const raw = await readRaw(req);
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = String(req.headers['x-razorpay-signature'] || '');
  const same = want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
  if (!secret || !same) return res.status(401).send('Bad signature');

  let ev;
  try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).send('Bad JSON'); }

  // Only paid payment links grant access. Everything else is acknowledged and ignored.
  if (ev.event !== 'payment_link.paid') return res.status(200).send('ignored');

  const link = (ev.payload && ev.payload.payment_link && ev.payload.payment_link.entity) || {};
  const pay = (ev.payload && ev.payload.payment && ev.payload.payment.entity) || {};
  const email = String(pay.email || (link.customer && link.customer.email) || '').trim().toLowerCase();
  const paymentId = pay.id || '';
  const notes = Object.assign({}, link.notes || {}, pay.notes || {});
  const fromText = pick((link.description || '') + ' ' + (notes.plan || ''));
  const exam = notes.exam ? pick(notes.exam).exam || String(notes.exam) : fromText.exam;
  const months = notes.months ? parseInt(notes.months, 10) : fromText.months;

  if (!email || !exam || !months) {
    // Do not guess. Give access by hand in Admin > Subscribers.
    console.error('NEEDS MANUAL ACCESS', JSON.stringify({ email, exam, months, paymentId, description: link.description }));
    return res.status(200).send('logged for manual access');
  }

  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const token = await googleToken(sa);
    const base = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/entitlements/' + encodeURIComponent(email);
    const auth = { authorization: 'Bearer ' + token };

    let oldExams = [], oldUntil = '', lastPay = '';
    const g = await fetch(base, { headers: auth });
    if (g.ok) {
      const f = (await g.json()).fields || {};
      oldExams = ((f.exams && f.exams.arrayValue && f.exams.arrayValue.values) || []).map((v) => v.stringValue);
      oldUntil = (f.until && f.until.stringValue) || '';
      lastPay = (f.lastPaymentId && f.lastPaymentId.stringValue) || '';
    }
    if (paymentId && lastPay === paymentId) return res.status(200).send('already applied');

    const today = new Date().toISOString().slice(0, 10);
    const start = oldUntil && oldUntil > today ? oldUntil : today; // renewals add on top of the remaining time
    const until = addMonths(start, months);
    const exams = Array.from(new Set(oldExams.concat([exam])));

    const body = { fields: {
      email: { stringValue: email },
      exams: { arrayValue: { values: exams.map((x) => ({ stringValue: x })) } },
      until: { stringValue: until },
      created: { stringValue: new Date().toISOString() },
      lastPaymentId: { stringValue: paymentId },
      source: { stringValue: 'razorpay' },
    } };
    const w = await fetch(base, { method: 'PATCH', headers: Object.assign({ 'content-type': 'application/json' }, auth), body: JSON.stringify(body) });
    if (!w.ok) throw new Error('Firestore write failed: ' + (await w.text()));
    return res.status(200).send('access granted');
  } catch (e) {
    console.error(e);
    return res.status(500).send('error'); // Razorpay will retry
  }
};
