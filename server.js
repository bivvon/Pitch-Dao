const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const EP     = 'https://api.elementpay.net/api/v1';
const KEY    = 'is_live_Q5IIZHv75XpYt7P2hA0XUc9au7jmBFwygdU2cLLZKGk';
const HDR    = { 'Content-Type': 'application/json', 'X-API-Key': KEY };
const WALLET = '0x40C2f2e0326bD1f647fbeB8732529e08B4DB309f';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ep = (path, opts) =>
  fetch(EP + path, { headers: HDR, ...opts }).then(r => r.json());

app.get('/pay/quote/:amt', async (req, res) => {
  const d = await ep(`/quote?amount_fiat=${req.params.amt}&token=USDC&order_type=OnRamp`);
  res.json({ ok: d.status === 'success', rate: d.data?.rate });
});

app.post('/pay/deposit', async (req, res) => {
  const { amount, phone } = req.body;
  const d = await ep('/orders/create', { method: 'POST', body: JSON.stringify({
    user_address: WALLET, token: USDC, order_type: 0,
    fiat_payload: { amount_fiat: amount, cashout_type: 'PHONE',
      phone_number: phone, currency: 'KES',
      narrative: 'PitchDAO deposit', client_ref: 'DEP-' + Date.now() }
  })});
  res.json({ ok: d.status === 'success', tx: d.data?.tx_hash, status: d.data?.status, error: d.message });
});

app.post('/pay/withdraw', async (req, res) => {
  const { amount, phone } = req.body;
  const d = await ep('/orders/create', { method: 'POST', body: JSON.stringify({
    user_address: WALLET, token: USDC, order_type: 1,
    fiat_payload: { amount_fiat: amount, cashout_type: 'PHONE',
      phone_number: phone, currency: 'KES',
      narrative: 'PitchDAO withdrawal', client_ref: 'WDR-' + Date.now() }
  })});
  res.json({ ok: d.status === 'success', tx: d.data?.tx_hash, status: d.data?.status, error: d.message });
});

app.get('/pay/order/:tx', async (req, res) => {
  const d = await ep(`/orders/tx/${req.params.tx}`);
  const st = (d.data?.status || '').toLowerCase();
  res.json({ ok: d.status === 'success', status: st,
    settled: ['settled', 'complete', 'completed'].includes(st) });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PitchDAO backend on port ${PORT}`));
