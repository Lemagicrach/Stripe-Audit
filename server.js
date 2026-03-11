'use strict';

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const nodemailer = require('nodemailer');
const Stripe     = require('stripe');

const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;

// ── Stripe ────────────────────────────────────────────────────────────────────

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

// ── Database ──────────────────────────────────────────────────────────────────

const db = new DatabaseSync(path.join(__dirname, 'data', 'revpilot.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY,
    email           TEXT    NOT NULL,
    mrr_band        INTEGER,
    score_dunning   INTEGER,
    score_pricing   INTEGER,
    score_churn     INTEGER,
    score_expansion INTEGER,
    score_trial     INTEGER,
    score_alerts    INTEGER,
    risk_score      INTEGER,
    risk_label      TEXT,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id                    INTEGER PRIMARY KEY,
    stripe_event_id       TEXT UNIQUE NOT NULL,
    stripe_session_id     TEXT,
    stripe_payment_intent TEXT,
    customer_email        TEXT,
    amount_total          INTEGER,
    currency              TEXT,
    created_at            TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
`);

// ── Mailer ────────────────────────────────────────────────────────────────────

let transporter = null;

if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendMail(opts) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'RevPilot <support@revpilot.net>',
      ...opts,
    });
  } catch (err) {
    console.error('[mail] Failed:', err.message);
  }
}

// ── Scoring helpers ───────────────────────────────────────────────────────────

const MRR_MAP = { 1: 7000, 2: 30000, 3: 90000, 4: 180000 };
const MULT_MAP = { low: 0.012, medium: 0.026, high: 0.05 };

const STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/bJe6oJgsH56d93w2unbbG00';

function getEstimate(mrrBand, riskLabel) {
  const base = MRR_MAP[mrrBand] || 7000;
  const mult = MULT_MAP[riskLabel]  || 0.012;
  const mid  = base * mult;
  return {
    low:  Math.round(mid * 0.7),
    high: Math.round(mid * 1.3),
  };
}

function fmtCurrency(n) {
  return '$' + n.toLocaleString('en-US');
}

const REC_MAP = {
  dunning:   [
    'Keep tuning retry intervals and reminder sequences to recover failed renewals faster.',
    'Tighten retry timing and customer notifications to reduce avoidable involuntary churn.',
    'Build a full dunning flow: smart retries, reminder emails, and card update nudges.',
  ],
  pricing:   [
    'Maintain your quarterly plan cleanup and watch for discount edge cases.',
    'Consolidate legacy plans and remove exception-heavy pricing paths.',
    'Run a plan architecture cleanup to eliminate revenue leakage from outdated pricing logic.',
  ],
  churn:     [
    'Your cadence is strong — add deeper cohort diagnostics for early warning signals.',
    'Create a monthly segmented churn review by plan, tenure, and acquisition channel.',
    'Set up a formal churn review process and assign owner-level retention actions.',
  ],
  expansion: [
    'Continue mapping expansion by plan and account behavior for better forecasting.',
    'Track expansion by segment to identify where upsell motion is underperforming.',
    'Instrument expansion metrics so upgrade opportunities are visible and repeatable.',
  ],
  trial:     [
    'Use your segmented conversion data to optimize activation bottlenecks.',
    'Break trial conversion down by source and product usage milestone.',
    'Set up consistent trial-to-paid reporting to uncover hidden conversion drag.',
  ],
  alerts:    [
    'Keep refining alert thresholds to catch billing anomalies earlier.',
    'Expand alert coverage and add a weekly billing events review loop.',
    'Set proactive alerts for failed invoices, refund spikes, and subscription anomalies.',
  ],
};

function getTopRecommendations(scores) {
  return Object.entries(scores)
    .filter(([k]) => k in REC_MAP)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, score]) => REC_MAP[key][score >= 3 ? 2 : score >= 2 ? 1 : 0]);
}

// ── Email templates ───────────────────────────────────────────────────────────

function assessmentEmail({ email, risk_label, risk_score, mrr_band, recommendations }) {
  const { low, high } = getEstimate(mrr_band, risk_label);
  const badgeColor = risk_label === 'high' ? '#cc3c2f' : risk_label === 'medium' ? '#9a5608' : '#0d7f68';
  const badgeBg    = risk_label === 'high' ? '#ffe3e0' : risk_label === 'medium' ? '#ffeed8' : '#e5f6ef';
  const labelText  = risk_label === 'high' ? 'High Leak Risk' : risk_label === 'medium' ? 'Medium Leak Risk' : 'Low Leak Risk';
  const recItems   = recommendations
    .map(r => `<li style="padding:8px 0;border-bottom:1px solid #e8f0ec;color:#3b526a;font-size:14px;line-height:1.5;">${r}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#edf4f1;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#edf4f1;padding:32px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:18px;border:1px solid rgba(15,30,46,.09);overflow:hidden;">
      <tr><td style="background:#0b7d66;padding:20px 32px;">
        <span style="font-size:17px;font-weight:800;color:#fff;letter-spacing:-.01em;">RevPilot</span>
      </td></tr>
      <tr><td style="padding:28px 32px 24px;">
        <span style="display:inline-block;background:${badgeBg};color:${badgeColor};border-radius:999px;padding:5px 12px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;">${labelText}</span>
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f1e2e;line-height:1.2;">Your Stripe Leak Score: ${risk_score}/18</h1>
        <p style="margin:0 0 20px;font-size:14px;color:#4a647e;line-height:1.65;">Here's your assessment summary. Review the top opportunities below before booking the full audit.</p>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbf4;border:1px solid #f0d0a0;border-radius:12px;margin-bottom:20px;">
          <tr><td style="padding:16px 18px;">
            <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#8a6030;margin-bottom:4px;">Estimated Recoverable Revenue</div>
            <div style="font-size:22px;font-weight:800;color:#0f1e2e;">${fmtCurrency(low)} – ${fmtCurrency(high)} / month</div>
            <div style="font-size:12px;color:#9a6a30;margin-top:4px;">Directional estimate based on your MRR range and risk score</div>
          </td></tr>
        </table>

        <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#2c4258;margin-bottom:8px;">Top areas to address first</div>
        <ul style="margin:0 0 22px;padding:0;list-style:none;">${recItems}</ul>

        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:4px 0 20px;">
          <a href="${STRIPE_CHECKOUT_URL}" style="display:inline-block;background:#f57f17;color:#fff;text-decoration:none;font-weight:800;font-size:15px;border-radius:10px;padding:14px 28px;">Book Full Audit — $1,200 →</a>
        </td></tr></table>

        <p style="margin:0;font-size:13px;color:#6b8a9a;line-height:1.5;">Questions? <a href="mailto:support@revpilot.net" style="color:#0b7d66;font-weight:700;">support@revpilot.net</a></p>
      </td></tr>
      <tr><td style="padding:14px 32px;border-top:1px solid #e8f0ec;background:#f4fbf8;">
        <p style="margin:0;font-size:12px;color:#7a9aaa;">RevPilot · Sent because you completed the free Stripe leak assessment.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function onboardingEmail() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#e8f3ef;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#e8f3ef;padding:32px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:18px;border:1px solid rgba(15,30,46,.09);overflow:hidden;">
      <tr><td style="background:#0b7d66;padding:20px 32px;">
        <span style="font-size:17px;font-weight:800;color:#fff;letter-spacing:-.01em;">RevPilot</span>
      </td></tr>
      <tr><td style="padding:28px 32px 24px;">
        <span style="display:inline-block;background:#e4f5f0;color:#0b7d66;border-radius:999px;padding:5px 12px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px;">Payment Confirmed</span>
        <h1 style="margin:0 0 10px;font-size:22px;font-weight:800;color:#0f1e2e;line-height:1.2;">Your audit is officially queued.</h1>
        <p style="margin:0 0 22px;font-size:14px;color:#4a647e;line-height:1.65;">Thanks for booking the Stripe Revenue Audit. Here's exactly what to expect next.</p>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4fbf8;border:1px solid #d0e4de;border-radius:12px;margin-bottom:20px;">
          <tr><td style="padding:18px 20px 12px;">
            <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#2c4258;margin-bottom:14px;">What Happens Next</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding:0 0 11px;font-size:14px;color:#2c4258;"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#e4f5f0;border:1px solid #b0ddd4;color:#0b7d66;font-weight:800;font-size:11px;text-align:center;line-height:22px;margin-right:9px;vertical-align:middle;">1</span>Check your inbox for your Stripe receipt and this onboarding email.</td></tr>
              <tr><td style="padding:0 0 11px;font-size:14px;color:#2c4258;"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#e4f5f0;border:1px solid #b0ddd4;color:#0b7d66;font-weight:800;font-size:11px;text-align:center;line-height:22px;margin-right:9px;vertical-align:middle;">2</span>Complete the short intake and grant read-only Stripe access (~10 min, no code needed).</td></tr>
              <tr><td style="padding:0 0 11px;font-size:14px;color:#2c4258;"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#e4f5f0;border:1px solid #b0ddd4;color:#0b7d66;font-weight:800;font-size:11px;text-align:center;line-height:22px;margin-right:9px;vertical-align:middle;">3</span>We audit your billing, churn, and expansion patterns in 4–5 business days.</td></tr>
              <tr><td style="padding:0 0 4px;font-size:14px;color:#2c4258;"><span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#e4f5f0;border:1px solid #b0ddd4;color:#0b7d66;font-weight:800;font-size:11px;text-align:center;line-height:22px;margin-right:9px;vertical-align:middle;">4</span>You receive your report, operating dashboard, and prioritized fix list.</td></tr>
            </table>
          </td></tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#e4f5f0;border:1px solid #b0ddd4;border-radius:10px;margin-bottom:20px;">
          <tr><td style="padding:14px 16px;">
            <div style="font-size:13px;font-weight:700;color:#0f1e2e;margin-bottom:3px;">7-Day Full Refund Guarantee</div>
            <div style="font-size:13px;color:#3b6a5c;line-height:1.55;">If the recommendations aren't actionable, email us within 7 days for a complete refund — no questions asked.</div>
          </td></tr>
        </table>

        <p style="margin:0;font-size:13px;color:#6b8a9a;line-height:1.5;">Questions before kickoff? <a href="mailto:support@revpilot.net" style="color:#0b7d66;font-weight:700;">support@revpilot.net</a> — we typically reply within a few hours.</p>
      </td></tr>
      <tr><td style="padding:14px 32px;border-top:1px solid #e8f0ec;background:#f4fbf8;">
        <p style="margin:0;font-size:12px;color:#7a9aaa;">RevPilot · You're receiving this because you purchased a Stripe Revenue Audit.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

// Webhook MUST be registered before express.json() so it receives the raw body.
// stripe.webhooks.constructEvent() needs the raw Buffer — parsing it as JSON first
// breaks the HMAC signature check.
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
      console.error('[webhook] STRIPE_WEBHOOK_SECRET not configured');
      return res.status(500).send('Webhook secret not configured');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error('[webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    // Acknowledge every event; only act on checkout.session.completed
    if (event.type !== 'checkout.session.completed') {
      return res.json({ received: true });
    }

    const session       = event.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email || null;

    // Idempotency — Stripe retries on non-2xx; ignore already-processed events
    const already = db.prepare('SELECT id FROM payments WHERE stripe_event_id = ?').get(event.id);
    if (already) {
      return res.json({ received: true });
    }

    db.prepare(`
      INSERT INTO payments
        (stripe_event_id, stripe_session_id, stripe_payment_intent, customer_email, amount_total, currency)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      session.id,
      session.payment_intent,
      customerEmail,
      session.amount_total,
      session.currency,
    );

    const amountFmt = `$${((session.amount_total || 0) / 100).toFixed(2)} ${(session.currency || 'usd').toUpperCase()}`;

    if (customerEmail) {
      await sendMail({
        to:      customerEmail,
        subject: "You're in — Stripe Revenue Audit booked",
        html:    onboardingEmail(),
      });
    } else {
      console.warn('[webhook] No customer email on session', session.id);
    }

    await sendMail({
      to:      process.env.ADMIN_EMAIL,
      subject: `New payment: ${amountFmt} from ${customerEmail || 'unknown'}`,
      text:    [
        'New audit purchase received.',
        `Email:           ${customerEmail || 'N/A'}`,
        `Amount:          ${amountFmt}`,
        `Session ID:      ${session.id}`,
        `Payment intent:  ${session.payment_intent}`,
      ].join('\n'),
    });

    res.json({ received: true });
  },
);

// JSON middleware for all other routes
app.use(express.json());

// Serve static HTML files from the project root
app.use(express.static(path.join(__dirname)));

// ── POST /api/assessment ──────────────────────────────────────────────────────

app.post('/api/assessment', async (req, res) => {
  const { email, mrr, dunning, pricing, churn, expansion, trial, alerts } = req.body;

  // Validate
  if (!email || !String(email).includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const mrrBand = Number(mrr);
  if (![1, 2, 3, 4].includes(mrrBand)) {
    return res.status(400).json({ error: 'mrr must be 1, 2, 3, or 4' });
  }
  const rawScores = { dunning, pricing, churn, expansion, trial, alerts };
  for (const [key, val] of Object.entries(rawScores)) {
    if (![0, 2, 3].includes(Number(val))) {
      return res.status(400).json({ error: `${key} must be 0, 2, or 3` });
    }
  }

  const scores     = Object.fromEntries(Object.entries(rawScores).map(([k, v]) => [k, Number(v)]));
  const riskScore  = Object.values(scores).reduce((s, v) => s + v, 0);
  const riskLabel  = riskScore >= 14 ? 'high' : riskScore >= 8 ? 'medium' : 'low';

  try {
    db.prepare(`
      INSERT INTO leads
        (email, mrr_band, score_dunning, score_pricing, score_churn, score_expansion, score_trial, score_alerts, risk_score, risk_label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      email, mrrBand,
      scores.dunning, scores.pricing, scores.churn,
      scores.expansion, scores.trial, scores.alerts,
      riskScore, riskLabel,
    );
  } catch (err) {
    console.error('[db] Lead insert failed:', err.message);
    return res.status(500).json({ error: 'Failed to save assessment' });
  }

  const recommendations = getTopRecommendations(scores);

  // Emails are fire-and-forget — don't block or fail the response if they error
  sendMail({
    to:      email,
    subject: 'Your Stripe Leak Score — RevPilot',
    html:    assessmentEmail({ email, risk_label: riskLabel, risk_score: riskScore, mrr_band: mrrBand, recommendations }),
  });

  sendMail({
    to:      process.env.ADMIN_EMAIL,
    subject: `New lead: ${email} — ${riskLabel} risk (${riskScore}/18)`,
    text:    [
      'New assessment submitted.',
      `Email:      ${email}`,
      `MRR band:   ${mrrBand} (${MRR_MAP[mrrBand] ? '$' + MRR_MAP[mrrBand].toLocaleString() : '?'}/mo)`,
      `Risk:       ${riskLabel} (${riskScore}/18)`,
      `Scores:     ${JSON.stringify(scores)}`,
    ].join('\n'),
  });

  res.json({ ok: true, risk_score: riskScore, risk_label: riskLabel });
});

// ── GET /api/admin/leads ──────────────────────────────────────────────────────

app.get('/api/admin/leads', (req, res) => {
  const auth     = req.headers['authorization'];
  const expected = `Bearer ${process.env.ADMIN_TOKEN}`;

  if (!process.env.ADMIN_TOKEN || auth !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  res.json({ count: leads.length, leads });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`RevPilot running on http://localhost:${PORT}`);
  if (!process.env.SMTP_HOST)              console.warn('[mail]   SMTP_HOST not set — emails disabled');
  if (!process.env.STRIPE_WEBHOOK_SECRET)  console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set');
  if (!process.env.ADMIN_TOKEN)            console.warn('[admin]  ADMIN_TOKEN not set — /api/admin/leads inaccessible');
});
