// Andistride by Andifusion — website + checkout backend
// Serves the shop from /public, reads products & prices from data/products.json,
// and takes orders paid by M-Pesa (manual paybill now, automatic STK Push later).
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const {
  PAYMENT_MODE = 'manual', // manual | stk
  MPESA_ENV = 'sandbox', MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE, MPESA_PASSKEY, PUBLIC_URL, TEST_AMOUNT,
  ADMIN_TOKEN, PORT = 3000,
} = process.env;

const DARAJA = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const VAT_RATE = 0.16;

// ---------- Catalogue (edit data/products.json to change products, prices, stock, delivery) ----------
const CATALOGUE_FILE = path.join(__dirname, 'data', 'products.json');
const catalogue = () => JSON.parse(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
const priceForSize = (cat, size) => (cat.priceBands.find((b) => size >= b.min && size <= b.max) || {}).price;

// ---------- Orders store (JSON file; move to a database before heavy use) ----------
const DB_FILE = path.join(__dirname, 'orders.json');
const load = () => (fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {});
const save = (db) => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const newOrderNo = (db) => {
  let n;
  do { n = 'AND-' + Math.floor(10000 + Math.random() * 90000); } while (db[n]);
  return n;
};

function normalisePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
  if (/^254[17]\d{8}$/.test(d)) return d;
  return null;
}
function timestamp() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}
async function getToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await fetch(`${DARAJA}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`Token request failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
async function stkPush({ phone, amount, orderNo }) {
  const ts = timestamp();
  const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + ts).toString('base64');
  const token = await getToken();
  const r = await fetch(`${DARAJA}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: MPESA_SHORTCODE, Password: password, Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline', Amount: amount,
      PartyA: phone, PartyB: MPESA_SHORTCODE, PhoneNumber: phone,
      CallBackURL: `${PUBLIC_URL}/api/mpesa/callback`,
      AccountReference: orderNo, TransactionDesc: 'Andistride order',
    }),
  });
  const data = await r.json();
  if (!r.ok || data.ResponseCode !== '0') throw new Error(`STK push failed: ${JSON.stringify(data)}`);
  return data;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Public catalogue for the website
app.get('/api/catalogue', (_req, res) => {
  const cat = catalogue();
  res.json({ ...cat, paymentMode: PAYMENT_MODE === 'stk' ? 'stk' : 'manual' });
});

// Place an order. Prices are always worked out here, never trusted from the browser.
app.post('/api/order', async (req, res) => {
  try {
    const cat = catalogue();
    const { code, size, qty = 1, name, town, stage = '', phone } = req.body || {};
    const product = cat.products.find((p) => p.code === code);
    const s = Number(size), q = Number(qty);
    const msisdn = normalisePhone(phone);
    if (!product || !product.inStock) return res.status(400).json({ error: 'That style is not available.' });
    if (!Number.isInteger(s) || s < product.minSize || s > product.maxSize || product.soldOutSizes.includes(s))
      return res.status(400).json({ error: 'That size is not available.' });
    if (!Number.isInteger(q) || q < 1 || q > 10) return res.status(400).json({ error: 'Invalid quantity.' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Please enter your name.' });
    if (!(town in cat.delivery)) return res.status(400).json({ error: 'Please choose your town.' });
    if (!msisdn) return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });

    const unit = priceForSize(cat, s);
    const deliveryFee = cat.delivery[town];
    const total = unit * q + deliveryFee;
    const db = load();
    const orderNo = newOrderNo(db);
    const order = {
      orderNo, key: require('crypto').randomBytes(6).toString('hex'),
      status: 'AWAITING_CONFIRMATION', mode: PAYMENT_MODE, createdAt: new Date().toISOString(),
      customer: { name: String(name).trim(), phone: msisdn, town, stage: String(stage).slice(0, 80) },
      item: { code, name: product.name, size: s, qty: q, unitPrice: unit },
      deliveryFee, total,
    };

    db[orderNo] = order;
    save(db);
    console.log(`New order ${orderNo}: ${product.name} size ${s} x${q} → ${town}, KSh ${total} (${PAYMENT_MODE})`);
    res.json({ orderNo, key: order.key, total });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not place the order. Please try again or WhatsApp us.' });
  }
});

// Safaricom result (used when PAYMENT_MODE=stk)
app.post('/api/mpesa/callback', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const cb = req.body?.Body?.stkCallback;
  if (!cb) return;
  const db = load();
  const order = Object.values(db).find((o) => o.checkoutRequestId === cb.CheckoutRequestID);
  if (!order || order.status === 'PAID') return;
  if (cb.ResultCode === 0) {
    const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
    order.status = Number(meta.Amount) === Number(order.chargedAmount) ? 'PAID' : 'AMOUNT_MISMATCH';
    order.mpesaReceipt = meta.MpesaReceiptNumber;
    order.paidAt = new Date().toISOString();
    console.log(`\n=== PAID ${order.orderNo} — issue eTIMS invoice ===\n` + JSON.stringify(etimsLines(order), null, 2));
  } else {
    order.status = 'FAILED';
    order.failReason = cb.ResultDesc;
  }
  db[order.orderNo] = order;
  save(db);
});

// Customer's private order page (needs the order's key)
function customerOrder(req) {
  const o = load()[req.params.orderNo];
  return o && o.key && req.query.k === o.key ? o : null;
}
app.get('/api/orders/:orderNo', (req, res) => {
  const o = customerOrder(req);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const cat = catalogue();
  const product = cat.products.find((p) => p.code === o.item.code);
  res.json({
    orderNo: o.orderNo, status: o.status, mode: PAYMENT_MODE === 'stk' ? 'stk' : 'manual',
    item: o.item, image: product ? product.image : null, town: o.customer.town, name: o.customer.name,
    deliveryFee: o.deliveryFee, total: o.total, note: o.note || null, failReason: o.failReason || null,
    paybill: cat.business.paybill, account: cat.business.account, whatsapp: cat.business.whatsapp,
  });
});
app.post('/api/orders/:orderNo/pay', async (req, res) => {
  const o = customerOrder(req);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (PAYMENT_MODE !== 'stk') return res.status(400).json({ error: 'Pay using the paybill details shown.' });
  if (!['AWAITING_PAYMENT', 'FAILED'].includes(o.status)) return res.status(400).json({ error: 'This order is not ready for payment.' });
  try {
    o.chargedAmount = TEST_AMOUNT ? Number(TEST_AMOUNT) : o.total;
    const push = await stkPush({ phone: o.customer.phone, amount: o.chargedAmount, orderNo: o.orderNo });
    const db = load();
    db[o.orderNo] = { ...db[o.orderNo], status: 'PENDING', chargedAmount: o.chargedAmount, checkoutRequestId: push.CheckoutRequestID, failReason: null };
    save(db);
    res.json({ status: 'PENDING' });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not send the M-Pesa prompt. Please try again.' });
  }
});

// Admin: list orders and update their status
const isAdmin = (req) => {
  if (!ADMIN_TOKEN) return false;
  const q = typeof req.query.token === 'string' ? req.query.token.replace(/ /g, '+') : '';
  return q === ADMIN_TOKEN || req.get('x-admin-token') === ADMIN_TOKEN;
};
const STATUSES = ['AWAITING_CONFIRMATION', 'UNAVAILABLE', 'AWAITING_PAYMENT', 'PENDING', 'PAID', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'FAILED', 'AMOUNT_MISMATCH'];
app.get('/api/admin/orders', (req, res) => {
  if (!isAdmin(req)) return res.sendStatus(401);
  const orders = Object.values(load()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(orders.map((o) => ({ ...o, etims: etimsLines(o) })));
});
app.post('/api/admin/orders/:orderNo/status', (req, res) => {
  if (!isAdmin(req)) return res.sendStatus(401);
  const { status, mpesaCode, etimsNo, note } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const db = load();
  const o = db[req.params.orderNo];
  if (!o) return res.sendStatus(404);
  o.status = status;
  if (mpesaCode) o.mpesaReceipt = String(mpesaCode).toUpperCase().slice(0, 20);
  if (etimsNo !== undefined) o.etimsNo = String(etimsNo).slice(0, 40);
  if (note !== undefined) o.note = String(note).slice(0, 200);
  o[status.toLowerCase() + 'At'] = new Date().toISOString();
  save(db);
  res.json({ ...o, etims: etimsLines(o) });
});
// Kept for older links
app.post('/api/admin/orders/:orderNo/paid', (req, res) => {
  req.body = { ...(req.body || {}), status: 'PAID' };
  req.url = `/api/admin/orders/${req.params.orderNo}/status`;
  app.handle(req, res);
});

function etimsLines(o) {
  const split = (gross) => { const net = +(gross / (1 + VAT_RATE)).toFixed(2); return { gross, net, vat: +(gross - net).toFixed(2) }; };
  return {
    customer: o.customer.name,
    reference: `${o.orderNo} / M-Pesa ${o.mpesaReceipt || '-'}`,
    lines: [
      { item: `${o.item.name} (${o.item.code}) size ${o.item.size}`, qty: o.item.qty, unitPriceInclVAT: o.item.unitPrice, ...split(o.item.unitPrice * o.item.qty) },
      { item: `Delivery to ${o.customer.town}`, qty: 1, unitPriceInclVAT: o.deliveryFee, ...split(o.deliveryFee) },
    ],
    totalInclVAT: o.total,
  };
}

app.listen(PORT, () => console.log(`Andistride on :${PORT} — payments: ${PAYMENT_MODE}`));
