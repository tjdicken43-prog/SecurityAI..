// SecurityAI — real payment backend using Stripe Checkout, plus the
// persistent camera-monitoring engine (see monitor.js).
//
// PAYMENTS: genuine, runnable code — not a mockup — but it needs YOUR OWN
// Stripe account to actually process a payment. Card numbers never touch
// this server or checkout.html; Stripe's own hosted page collects them,
// which is what makes this PCI-compliant out of the box.
//
// MONITORING: also genuine and runnable, but needs ffmpeg installed and a
// real Anthropic API key — see the comment at the top of monitor.js for
// full requirements, and monitor.html for the control panel.
//
// SETUP:
//   1. npm install
//   2. Create a .env file next to this one — see .env.example
//   3. node server.js
//   4. Open http://localhost:4242/securityai.html (marketing site + browser demo)
//      or http://localhost:4242/monitor.html (persistent monitoring control panel)
//      — not by double-clicking the files, they need to be served by this backend.

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const Stripe = require('stripe');
const monitor = require('./monitor');
const mailer = require('./mailer');

// Stripe is only initialized if a key is present. This matters because
// someone might run this server purely for the monitoring feature and
// not have Stripe configured yet — a hard crash at startup would take
// the monitoring endpoints down too, which have nothing to do with Stripe.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = Stripe(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn('STRIPE_SECRET_KEY not set — /create-checkout-session and /webhook will return an error until it is configured. Monitoring endpoints are unaffected.');
}
const app = express();
const DOMAIN = process.env.DOMAIN || 'http://localhost:4242';

app.use(cors());
// The /webhook route needs the exact raw, unparsed request body to verify
// Stripe's signature — if the global JSON parser touches it first, the
// raw bytes are gone by the time express.raw() runs on that route below,
// and signature verification will always fail. So this skips JSON
// parsing for that one path and lets its own route-level middleware
// handle it.
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  // Raised from the default 100kb — screen-capture frames pushed by
  // monitor.html's browser-push source can be a few MB as base64.
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.static(__dirname)); // serves securityai.html / checkout.html / monitor.html directly

// Without this, visiting the bare domain (just "/") 404s with "Cannot GET /",
// because the homepage is named securityai.html, not index.html — the one
// filename express.static automatically serves at "/". This makes the
// root URL work the way a visitor actually expects.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'securityai.html'));
});

// --- Persistent monitoring controls (see monitor.js for the actual loop) ---
// These are the endpoints monitor.html's Start/Stop buttons call. Once
// started, this keeps running in this Node process — independent of any
// browser tab — until /monitor/stop is called or the process is killed.

app.post('/monitor/start', (req, res) => {
  try {
    monitor.start(req.body || {});
    res.json({ ok: true, status: monitor.getStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/monitor/stop', (req, res) => {
  monitor.stop();
  res.json({ ok: true, status: monitor.getStatus() });
});

app.get('/monitor/status', (req, res) => {
  res.json(monitor.getStatus());
});

app.get('/monitor/log', (req, res) => {
  res.json(monitor.getLog());
});

app.get('/monitor/platform', (req, res) => {
  res.json({ platform: monitor.platform });
});

app.get('/monitor/devices', async (req, res) => {
  try {
    const result = await monitor.listDevices();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called by monitor.html's own screen-share loop (browser-push source
// type) — the browser captured the frame itself via getDisplayMedia,
// this just runs it through the same analysis/alert/log path as any
// server-captured frame. Raised limit: screen frames can be larger than
// a typical camera snapshot.
app.post('/monitor/push-frame', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'image (base64 JPEG) is required.' });
    await monitor.pushFrame(image);
    res.json({ ok: true, status: monitor.getStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Called by securityai.html's support form. Emails SUPPORT_EMAIL (falls
// back to SMTP_USER) via the shared mailer if SMTP is configured; if not,
// still logs the message server-side and tells the front end honestly
// that delivery didn't happen, rather than pretending it did.
app.post('/support/contact', async (req, res) => {
  const { name, email, topic, message } = req.body || {};
  if (!email || !message) {
    return res.status(400).json({ error: 'email and message are required.' });
  }

  const to = process.env.SUPPORT_EMAIL || process.env.SMTP_USER;
  const body = `From: ${name || '(no name given)'} <${email}>\nTopic: ${topic || '(none given)'}\n\n${message}`;

  if (!to) {
    console.log('--- Support request received (no SUPPORT_EMAIL/SMTP_USER configured to forward to) ---\n' + body);
    return res.json({ ok: true, delivered: false });
  }

  const result = await mailer.sendMail({
    to,
    subject: `SecurityAI support: ${topic || 'New message'}`,
    text: body,
    replyTo: email,
  });

  if (!result.delivered) {
    console.log(`--- Support request received (email delivery skipped: ${result.reason}) ---\n${body}`);
  }

  res.json({ ok: true, delivered: result.delivered });
});

// Creates a real Stripe Checkout Session for a subscription.
// The front end redirects the browser to the returned URL — Stripe hosts
// the actual card form there, so this server never sees a card number.
app.post('/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured — set STRIPE_SECRET_KEY in .env.' });
  }
  try {
    const { planName, unitAmountCents, gyms } = req.body;

    if (!planName || !unitAmountCents) {
      return res.status(400).json({ error: 'planName and unitAmountCents are required' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `SecurityAI — ${planName}` },
            unit_amount: unitAmountCents, // e.g. 14900 = $149.00
            recurring: { interval: 'month' },
          },
          quantity: gyms || 1,
        },
      ],
      // These consent facts get carried into Stripe's own records for this
      // subscription, alongside whatever you log on your own checkout page.
      metadata: {
        recurring_billing_ack: 'true',
        camera_data_ack: 'true',
      },
      success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/checkout.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe calls this whenever something happens on a subscription
// (payment succeeded, card declined, customer canceled, etc). This is
// where you'd update your own database — Checkout alone doesn't do that.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).send('Stripe is not configured.');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      console.log('New subscription started:', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      console.log('Payment failed for subscription:', event.data.object.subscription);
      break;
    case 'customer.subscription.deleted':
      console.log('Subscription canceled:', event.data.object.id);
      break;
  }

  res.json({ received: true });
});

// Render (and most hosting platforms) assign the port dynamically via
// the PORT environment variable and expect the app to listen on
// whatever that is — a hardcoded port means the platform never sees
// anything answering and reports the deploy as failed. Falls back to
// 4242 for local development, where PORT usually isn't set.
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`SecurityAI payment server running on port ${PORT}`));
