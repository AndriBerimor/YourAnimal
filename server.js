// ═══════════════════════════════════════════════════════
//  Пухлик — Backend v2
//  Telegram Stars + Push Notifications via Bot API
// ═══════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const axios   = require('axios');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT      = process.env.PORT || 3000;

// ── In-memory stores (replace with MongoDB for production) ──
const users    = new Map();  // userId -> state
const invoices = new Map();  // payload -> { userId, stars }

// ───────────────────────────────────────
//  Telegram signature verification
// ───────────────────────────────────────
function verifyTg(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash'); p.delete('hash');
    const str = [...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
    const key = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    return crypto.createHmac('sha256',key).update(str).digest('hex') === hash;
  } catch { return false; }
}

// ───────────────────────────────────────
//  Bot API helper
// ───────────────────────────────────────
async function botApi(method, data) {
  const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, data);
  return r.data;
}

// ───────────────────────────────────────
//  GET /api/user/:id
// ───────────────────────────────────────
app.get('/api/user/:id', (req, res) => {
  const u = users.get(req.params.id) || { stars:20, pet:null, level:1, xp:0, owned:[], roomItems:[], happy:80, hunger:70, energy:90, clean:60 };
  res.json(u);
});

// ───────────────────────────────────────
//  POST /api/user/:id — save state
// ───────────────────────────────────────
app.post('/api/user/:id', (req, res) => {
  const { initData, ...data } = req.body;
  if (process.env.NODE_ENV === 'production' && !verifyTg(initData))
    return res.status(403).json({ error: 'Forbidden' });
  users.set(req.params.id, { ...users.get(req.params.id), ...data, updatedAt: Date.now() });
  res.json({ ok: true });
});

// ───────────────────────────────────────
//  POST /api/create-invoice — Stars payment
// ───────────────────────────────────────
app.post('/api/create-invoice', async (req, res) => {
  const { userId, stars, tgStars, label, initData } = req.body;
  if (process.env.NODE_ENV === 'production' && !verifyTg(initData))
    return res.status(403).json({ error: 'Forbidden' });
  try {
    const payload = `puhlik_${userId}_${stars}_${Date.now()}`;
    const invoice_url = await botApi('createInvoiceLink', {
      title:       `⭐ ${stars} звёзд для питомца`,
      description: `${label} — ${stars} внутриигровых звёзд`,
      payload,
      currency:    'XTR',
      prices:      [{ label: `${stars} звёзд`, amount: tgStars }],
    });
    invoices.set(payload, { userId: String(userId), stars });
    res.json({ invoice_url: invoice_url.result });
  } catch (e) {
    console.error('Invoice error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Invoice failed' });
  }
});

// ───────────────────────────────────────
//  POST /api/notify — push notification
//  Called by frontend when a stat drops below threshold
// ───────────────────────────────────────
app.post('/api/notify', async (req, res) => {
  const { userId, msg, statKey, val } = req.body;
  if (!userId || !msg) return res.json({ ok: false });

  // Don't spam: check last notify time per user+stat
  const user = users.get(String(userId)) || {};
  const nKey = `notify_${statKey}`;
  const lastNotify = user[nKey] || 0;
  const now = Date.now();
  if (now - lastNotify < 5 * 60 * 1000) return res.json({ ok: false, reason: 'cooldown' }); // 5min cooldown
  user[nKey] = now;
  users.set(String(userId), user);

  try {
    await botApi('sendMessage', {
      chat_id: userId,
      text: `🐾 <b>Питомец нуждается в тебе!</b>\n\n${msg}\n\n<i>Зайди в игру, пока питомцу не стало совсем плохо!</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{
          text: '🐾 Зайти в игру',
          web_app: { url: process.env.FRONTEND_URL || 'https://YOUR_FRONTEND_URL' }
        }]]
      }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Notify error:', e.response?.data?.description || e.message);
    res.json({ ok: false });
  }
});

// ───────────────────────────────────────
//  POST /api/webhook — Telegram updates
// ───────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  const update = req.body;

  // Successful payment
  if (update.message?.successful_payment) {
    const pay     = update.message.successful_payment;
    const inv     = invoices.get(pay.invoice_payload);
    if (inv) {
      const u = users.get(inv.userId) || { stars: 0 };
      u.stars = (u.stars || 0) + inv.stars;
      users.set(inv.userId, u);
      invoices.delete(pay.invoice_payload);
      console.log(`💰 Payment: user ${inv.userId} +${inv.stars} stars`);
      await botApi('sendMessage', {
        chat_id: update.message.chat.id,
        text: `🎉 Оплата прошла! Питомец получил ⭐ ${inv.stars} звёзд!\n\nОткрой игру и порадуй его покупками 🐾`,
        reply_markup: { inline_keyboard: [[{ text:'🐾 Играть', web_app:{ url: process.env.FRONTEND_URL } }]] }
      });
    }
  }

  // /start command
  if (update.message?.text?.startsWith('/start')) {
    const chat = update.message.chat.id;
    const name = update.message.from?.first_name || 'Друг';
    await botApi('sendMessage', {
      chat_id: chat,
      text: `Привет, <b>${name}</b>! 🐾\n\nВ <b>Пухлике</b> тебя ждёт маленький питомец!\nЗаботься о нём — корми, играй, обнимай.\n\n🎁 <b>Стартовый бонус: 20 звёзд!</b>\n\nВыбери питомца и начни заботиться 👇`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text:'🐾 Играть!', web_app:{ url: process.env.FRONTEND_URL } }]] }
    });
  }

  res.json({ ok: true });
});

// ───────────────────────────────────────
//  POST /api/set-webhook
// ───────────────────────────────────────
app.post('/api/set-webhook', async (req, res) => {
  const url = req.body.url || `${process.env.BACKEND_URL}/api/webhook`;
  try {
    const r = await botApi('setWebhook', { url, drop_pending_updates: true });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), users: users.size }));

app.listen(PORT, () => {
  console.log(`\n🐾 Пухлик Backend v2 — port ${PORT}`);
  console.log(`   BOT_TOKEN: ${BOT_TOKEN ? '✅' : '❌ NOT SET'}\n`);
});
