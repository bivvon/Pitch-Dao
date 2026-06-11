const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const app        = express();

app.use(cors());
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const EP        = 'https://api.elementpay.net/api/v1';
const EP_KEY    = 'is_live_Q5IIZHv75XpYt7P2hA0XUc9au7jmBFwygdU2cLLZKGk';
const HDR       = { 'Content-Type': 'application/json', 'X-API-Key': EP_KEY };
const WALLET    = '0x40C2f2e0326bD1f647fbeB8732529e08B4DB309f';
const USDC      = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ADMIN_KEY = process.env.ADMIN_KEY || 'pitchdao-admin-2026';

// SMS removed — email-only auth

// Nodemailer — set GMAIL_USER and GMAIL_PASS (app password) in Render env vars
let mailer = null;
if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  console.log('[EMAIL] Nodemailer ready');
} else {
  console.log('[EMAIL] No GMAIL_USER/GMAIL_PASS — email OTP will log to console.');
}

// ─── IN-MEMORY STORES ────────────────────────────────────────────────────────
const otps             = {};  // { [contact]: { otp, expiresAt, name, mode } }
const sessions         = {};  // { [token]: { contact, name, createdAt } }
const resolutions      = {};
const suspendedMarkets = {};
const customMarkets    = [];
let   announcement     = null;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const ep = (path, opts) =>
  fetch(EP + path, { headers: HDR, ...opts }).then(r => r.json());

const adminAuth = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
};

const authRequired = (req, res, next) => {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions[token])
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  req.user = sessions[token];
  next();
};

const genOTP   = () => String(Math.floor(100000 + Math.random() * 900000));
const genToken = () => crypto.randomBytes(32).toString('hex');

// ─── AUTH ENDPOINTS ───────────────────────────────────────────────────────────

// Step 1: Request OTP — sends via SMS (Africa's Talking) or email (Nodemailer)
app.post('/auth/request-otp', async (req, res) => {
  const { contact, name, mode } = req.body;
  if (!contact) return res.status(400).json({ ok: false, error: 'Contact required' });

  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  if (!isEmail)
    return res.status(400).json({ ok: false, error: 'Enter a valid email address' });

  // Throttle: max 1 OTP per minute per contact
  const existing = otps[contact];
  if (existing && (Date.now() - (existing.expiresAt - 5*60*1000)) < 60*1000)
    return res.status(429).json({ ok: false, error: 'Please wait 60 seconds before requesting another code' });

  const otp       = genOTP();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  otps[contact]   = { otp, expiresAt, name: name?.trim() || '', mode };

  const message = `Your PitchDAO verification code is: ${otp}\n\nValid for 5 minutes. Do not share this code.`;

  try {
    if (isEmail && mailer) {
      // Send via Gmail SMTP
      await mailer.sendMail({
        from: `"PitchDAO" <${process.env.GMAIL_USER}>`,
        to:      contact,
        subject: `Your PitchDAO code: ${otp}`,
        text:    message,
        html:    `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto">
            <h2 style="color:#0A0A0A">Your PitchDAO code</h2>
            <div style="background:#F5F5F5;border-radius:8px;padding:24px;text-align:center;margin:20px 0">
              <div style="font-size:40px;font-weight:800;letter-spacing:8px;font-family:monospace;color:#0A0A0A">${otp}</div>
            </div>
            <p style="color:#666;font-size:14px">Valid for 5 minutes. Do not share this code with anyone.</p>
            <p style="color:#999;font-size:12px">PitchDAO — World Cup 2026 Prediction Markets</p>
          </div>`,
      });
      console.log(`[OTP] Email sent to ${contact}`);
    } else {
      // No email configured — log OTP to Render console for testing
      console.log(`[OTP DEV] Code for ${contact}: ${otp}`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[OTP] Send error:', err.message);
    // Still return ok in dev so testing works; in production you'd return an error
    if (process.env.NODE_ENV === 'production') {
      res.status(500).json({ ok: false, error: 'Failed to send code. Check your number and try again.' });
    } else {
      console.log(`[OTP FALLBACK] Code for ${contact}: ${otp}`);
      res.json({ ok: true });
    }
  }
});

// Step 2: Verify OTP — returns session token
app.post('/auth/verify-otp', (req, res) => {
  const { contact, otp } = req.body;
  if (!contact || !otp)
    return res.status(400).json({ ok: false, error: 'Contact and OTP required' });

  const stored = otps[contact];
  if (!stored)
    return res.status(400).json({ ok: false, error: 'No code found. Request a new one.' });
  if (Date.now() > stored.expiresAt)
    return res.status(400).json({ ok: false, error: 'Code expired. Request a new one.' });
  if (stored.otp !== String(otp).trim())
    return res.status(400).json({ ok: false, error: 'Wrong code. Check and try again.' });

  delete otps[contact];

  const token = genToken();
  const user  = { contact, name: stored.name || contact, createdAt: new Date().toISOString() };
  sessions[token] = { ...user, token };

  console.log(`[AUTH] Verified: ${contact} (${stored.mode})`);
  res.json({ ok: true, token, user });
});

// Validate existing token (called on app mount)
app.get('/auth/me', authRequired, (req, res) => {
  res.json({ ok: true, user: { contact: req.user.contact, name: req.user.name } });
});

// ─── PAYMENT ROUTES ───────────────────────────────────────────────────────────
app.get('/pay/quote/:amt', async (req, res) => {
  try {
    const d = await ep(`/quote?amount_fiat=${req.params.amt}&token=USDC&order_type=OnRamp`);
    res.json({ ok: d.status === 'success', rate: d.data?.rate });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/pay/deposit', authRequired, async (req, res) => {
  try {
    const { amount, phone } = req.body;
    if (!amount || !phone) return res.status(400).json({ ok: false, error: 'amount and phone required' });
    const d = await ep('/orders/create', { method: 'POST', body: JSON.stringify({
      user_address: WALLET, token: USDC, order_type: 0,
      fiat_payload: { amount_fiat: amount, cashout_type: 'PHONE', phone_number: phone,
        currency: 'KES', narrative: 'PitchDAO deposit', client_ref: `DEP-${Date.now()}` }
    })});
    res.json({ ok: d.status === 'success', tx: d.data?.tx_hash, status: d.data?.status, error: d.message });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/pay/withdraw', authRequired, async (req, res) => {
  try {
    const { amount, phone } = req.body;
    if (!amount || !phone) return res.status(400).json({ ok: false, error: 'amount and phone required' });
    const d = await ep('/orders/create', { method: 'POST', body: JSON.stringify({
      user_address: WALLET, token: USDC, order_type: 1,
      fiat_payload: { amount_fiat: amount, cashout_type: 'PHONE', phone_number: phone,
        currency: 'KES', narrative: 'PitchDAO withdrawal', client_ref: `WDR-${Date.now()}` }
    })});
    res.json({ ok: d.status === 'success', tx: d.data?.tx_hash, status: d.data?.status, error: d.message });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/pay/order/:tx', async (req, res) => {
  try {
    const d  = await ep(`/orders/tx/${req.params.tx}`);
    const st = (d.data?.status || '').toLowerCase();
    res.json({ ok: d.status === 'success', status: st,
      settled: ['settled','complete','completed'].includes(st) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
app.get('/admin/resolutions', (req, res) => {
  res.json({ ok: true, resolutions, suspendedMarkets });
});
app.post('/admin/resolve', adminAuth, (req, res) => {
  const { mid, winOid } = req.body;
  if (!mid || !winOid) return res.status(400).json({ ok: false, error: 'mid and winOid required' });
  resolutions[mid] = winOid;
  console.log(`[RESOLVE] ${mid} → ${winOid}`);
  res.json({ ok: true });
});
app.post('/admin/suspend', adminAuth, (req, res) => {
  const { mid, suspend } = req.body;
  if (!mid) return res.status(400).json({ ok: false, error: 'mid required' });
  if (suspend) suspendedMarkets[mid] = true; else delete suspendedMarkets[mid];
  res.json({ ok: true });
});
app.post('/admin/clear-resolutions', adminAuth, (req, res) => {
  Object.keys(resolutions).forEach(k => delete resolutions[k]);
  res.json({ ok: true });
});
app.get('/admin/orders', adminAuth, async (req, res) => {
  try {
    const d = await ep('/orders/me');
    res.json({ ok: true, orders: d.data || d.orders || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message, orders: [] }); }
});
app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const d       = await ep('/orders/me');
    const orders  = d.data || d.orders || [];
    const deps    = orders.filter(o => o.order_type === 0 && (o.status||'').toLowerCase() === 'settled');
    const wdrs    = orders.filter(o => o.order_type === 1 && (o.status||'').toLowerCase() === 'settled');
    const pending = orders.filter(o => ['pending','processing','submitted'].includes((o.status||'').toLowerCase()));
    const totalDeposited = deps.reduce((s,o) => s+(o.amount_fiat||0), 0);
    const totalWithdrawn = wdrs.reduce((s,o) => s+(o.amount_fiat||0), 0);
    res.json({ ok: true, totalDeposited, totalWithdrawn,
      feeEarned: +(totalDeposited * 0.02).toFixed(2),
      depositCount: deps.length, withdrawalCount: wdrs.length, pendingOrders: pending.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── CUSTOM MARKETS + ANNOUNCEMENT ───────────────────────────────────────────
app.get('/markets/custom', (req, res) => res.json({ ok: true, markets: customMarkets }));
app.get('/announcement',   (req, res) => res.json({ ok: true, announcement }));
app.post('/admin/markets/create', adminAuth, (req, res) => {
  const { cat, q, sub, opts, closesAt } = req.body;
  if (!q || !opts || opts.length < 2)
    return res.status(400).json({ ok: false, error: 'Question and at least 2 outcomes required' });
  const id  = 'custom_' + Date.now();
  const mkt = { id, cat: cat||'Custom', q: q.trim(), sub: sub?.trim()||'',
    closesAt: closesAt||null, isCustom: true,
    opts: opts.map((o,i) => ({ id:`${id}_opt${i}`, l: o.l?.trim()||`Option ${i+1}`, p: parseFloat(o.p)||Math.round(100/opts.length) })),
    createdAt: new Date().toISOString() };
  customMarkets.push(mkt);
  console.log(`[CREATE MARKET] ${id}: ${q}`);
  res.json({ ok: true, market: mkt });
});
app.post('/admin/markets/delete', adminAuth, (req, res) => {
  const { id } = req.body;
  const idx = customMarkets.findIndex(m => m.id === id);
  if (idx >= 0) { customMarkets.splice(idx, 1); delete resolutions[id]; }
  res.json({ ok: true });
});
app.post('/admin/announcement', adminAuth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ ok: false, error: 'Text required' });
  announcement = { text: text.trim(), ts: new Date().toISOString() };
  console.log(`[ANNOUNCEMENT] ${text.trim().slice(0,60)}`);
  res.json({ ok: true });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ ok: true, service: 'PitchDAO Backend', sessions: Object.keys(sessions).length, ts: new Date().toISOString() }));

// ─── KEEP-ALIVE (prevents Render free tier sleep) ────────────────────────────
setInterval(() => { fetch(`http://localhost:${process.env.PORT||3001}/`).catch(()=>{}); }, 14*60*1000);

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PitchDAO backend on :${PORT}`));
 
