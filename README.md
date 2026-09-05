# SecurityAI — running the real parts

Three things in this project are genuinely functional, not scripted. Here's what's real, what each needs, and — honestly — what has and hasn't actually been tested.

## 1. Live camera analysis (securityai.html → "Working demo" section)

Fully working as downloaded, in a browser, with no setup. Click "Enable camera" or "Share a screen or window," set how many people you expect, then "Capture & analyze." That sends a real frame to Claude and gets back a real person count and tailgate flag.

**This runs in your browser tab.** Close the tab, let your laptop sleep, or lose focus for long enough, and it stops. That's fine for trying the concept, but it is not what you want for actually running unattended — that's what #3 below is for.

**Important — this needs `ANTHROPIC_API_KEY` set once deployed anywhere outside Claude's own interface.** The browser demo calls `/analyze-frame` and `/scan-cameras` on this server (see `vision.js`), not Anthropic directly — it used to call `api.anthropic.com` straight from the browser, which only worked while this page was being built and previewed inside Claude's own interface (which proxies that exact call). On any real, independently-hosted domain, that proxy doesn't exist, the browser has no API key, and the request fails before it gets a response — showing up as "Failed to fetch." Routing through this server fixes that, but it means the demo genuinely does not work on a live deployment until `ANTHROPIC_API_KEY` is set in that deployment's environment variables, same as the persistent monitor needs in #3.

### Testing on a phone during development

Camera and screen-share APIs only work over a "secure context" — `https://`, or `http://localhost` on the same machine. A phone can't use "localhost" to mean your computer, so `http://192.168.x.x:4242` from your phone still counts as insecure and both buttons will fail, even though the same page works fine on the computer running the server. This is a browser platform rule, not a bug in this code.

Two ways to actually test on a phone before you deploy anywhere:
1. **A tunnel** (fastest for dev): run `ngrok http 4242` (free tier at ngrok.com) or `cloudflared tunnel --url http://localhost:4242` alongside `node server.js`. Either gives you a real `https://` URL that forwards to your local server — open that URL on your phone.
2. **Deploy for real** — see the hosting section further down. Once it's on a real domain with HTTPS, phones work the same as computers, no special steps.

**One more thing worth knowing: screen sharing is desktop-only, permanently.** iOS Safari and virtually all mobile browsers don't implement `getDisplayMedia` at all — this isn't a permissions issue or something a tunnel/HTTPS fixes, the API simply doesn't exist on phones. The page now detects this and tells a phone visitor to use "Enable camera" instead, rather than showing a generic "unavailable" that looks like a bug. Camera capture itself works fine on phones once you're on a real secure context.

## 2. Real payment processing (checkout.html + server.js)

Genuine Stripe Checkout integration. Needs your own Stripe account:

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `STRIPE_SECRET_KEY` (test-mode key from dashboard.stripe.com — free, uses fake cards) and `STRIPE_WEBHOOK_SECRET` if testing webhooks
3. `node server.js`
4. Open **http://localhost:4242/securityai.html** through the server — not by double-clicking the file
5. Click a pricing plan → checkout → check the consent boxes → "Start subscription" → real Stripe Checkout page. Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

**Current pricing:** $250/month for a single gym, $225/gym/month on a multi-gym contract (3+ locations, a 10% discount) — set in securityai.html's pricing section and carried through checkout via URL parameters.

## 3. Persistent monitoring (monitor.html + server.js + monitor.js) — new

This is the part that actually runs "nonstop until you stop it," because it lives in the Node process, not a browser tab. Start it from monitor.html, close the browser, and it keeps capturing and analyzing on your interval until you press Stop (or kill the process).

### What it needs
- **ffmpeg installed on the machine running the server** (a system binary, not an npm package): `brew install ffmpeg` / `sudo apt install ffmpeg` / ffmpeg.org for Windows. This is what grabs a still frame from your camera.
- **A real Anthropic API key** in `.env` as `ANTHROPIC_API_KEY`, from console.anthropic.com. The browser demo (#1) doesn't need this because claude.ai proxies that call for pages it renders — this standalone server has no such proxy and needs a real key that you'll be billed against.
- **Optional:** SMTP credentials (email alerts) and/or Twilio credentials (SMS alerts) in `.env`. Either, both, or neither — each is checked independently and skipped gracefully if not configured. Without either, flags still show up in the on-page log, just without a push notification.

### Setup
1. `npm install` (installs `nodemailer` and `twilio` alongside the existing deps — both are optional at runtime even though they're installed)
2. Fill in `.env` per `.env.example`
3. `node server.js`
4. Open **http://localhost:4242/monitor.html**
5. Enter your camera's URL — an RTSP stream (`rtsp://...`) or an HTTP snapshot URL (`http://camera-ip/snapshot.jpg`) are both supported, since that covers most IP cameras and NVR software. A plain USB webcam needs an extra step (see below).
6. Set expected check-in count, capture interval (5s minimum — each tick is a real API call), and alert email/phone
7. Check the consent box, press Start

### Camera source: two options, both cross-platform
- **IP camera / stream URL** (recommended for most gyms): an RTSP or HTTP snapshot URL. The exact same ffmpeg command works on Windows, macOS, and Linux — this is what most real IP cameras and NVR software already expose, so it's the path most gyms should use regardless of what computer runs the server.
- **USB webcam attached to this computer**: works on all three OSes, but each one needs a different ffmpeg input format under the hood (v4l2 on Linux, avfoundation on macOS, dshow on Windows) — monitor.js now detects the server's OS automatically and picks the right one. What it can't do automatically is know *which* device is your camera, since that's specific to the exact machine. Use the "Detect connected cameras" button on monitor.html, which runs the real OS-appropriate discovery command and shows you the raw output to read the right device identifier from.

### What was actually tested vs. what wasn't
I don't have a camera, a real Anthropic API key, or network access in the sandbox I built this in, so here's the honest split:

**Verified for real, on this actual machine:**
- `monitor.js`'s start/stop/status logic, input validation for both source types, and the 5-second interval floor
- The Linux v4l2 capture path end-to-end: pointed it at `/dev/video0` with monitoring running, and it correctly ran ffmpeg with the real v4l2 flags, correctly reported no such device exists (there's no camera in this sandbox), and logged the failure cleanly without crashing
- The Linux device-discovery path: it read the real `/dev` directory on this machine and correctly reported no video devices found
- The RTSP/HTTP URL capture path: pointed it at a real (nonexistent) URL and it made a real network request, got a real HTTP 403 back from ffmpeg, and logged the failure cleanly
- All JS in every HTML file (syntax, every element ID referenced in code exists in the page, no duplicate IDs, every onclick/onchange handler resolves to a real function) — re-run after every change
- That a missing `STRIPE_SECRET_KEY` can't crash the whole server (including monitoring) at startup — the two are decoupled

**Verified by code review only, not execution (no macOS or Windows machine in this sandbox):**
- The avfoundation (macOS) and dshow (Windows) ffmpeg argument formats are standard, documented ffmpeg usage, but I have not run them against real hardware. If the exact flag syntax has drifted in a newer ffmpeg version on either OS, that's the first place to check if it doesn't work.

**Not tested, because it requires things I don't have here:**
- An actual successful frame capture from any real camera (I've only exercised the failure paths, on all three source types)
- A real call to Claude's API from Node (needs your API key and network)
- Actual email/SMS delivery (needs your SMTP/Twilio credentials)
- The Express server booting at all — installing `express`, `stripe`, `nodemailer`, etc. requires npm registry access, which this sandbox doesn't have (I tried; the registry returned 403). The code is syntactically valid and each module's internal logic checks out under direct testing, but I have not seen this specific server process start and serve an HTTP request end-to-end.

## Before any of this touches a real gym

- The going-live checklist and FAQ on securityai.html aren't decorative — read them. A background-only trial period before anyone acts on a flag is not optional advice.
- Consent checkboxes on this site are UI, not legal compliance. Camera surveillance, biometric-adjacent data (even though this system doesn't do identification), and recurring billing all have real regulatory requirements that vary by state/city — get an actual legal review before going live, not just before going viral.

## 4. Screen sharing as a persistent monitoring source (new)

`monitor.html` now has a third source option — "Share a screen or window" — alongside IP camera and USB webcam, using the same real `getDisplayMedia` capture as the browser demo on securityai.html. It's genuinely wired to the persistent backend: the browser captures a frame, POSTs it to `/monitor/push-frame`, and the server runs it through the exact same analysis/alert/log path as a camera-pulled frame.

**Read this part before relying on it:** screen sharing is a browser permission tied to an open tab — that's true of any screen-mirroring implementation, not a limitation specific to this one. So unlike the IP-camera and webcam sources, which run fully headless on the server, this source stops the moment you close that browser tab or stop the share from your browser's own controls. If you need genuinely unattended 24/7 operation, use the IP camera or webcam source instead; use screen share when you're monitoring live from a desk with the tab open (e.g., watching an existing NVR dashboard) rather than needing it to run in the background indefinitely.

## 5. Customer support form (new)

securityai.html has a real contact form (name, email, topic, message) that POSTs to `/support/contact`. It uses the same SMTP configuration as email alerts (see `.env.example`) via a shared `mailer.js` module, so you only configure SMTP once for both features.

- **SMTP configured:** the message is emailed to `SUPPORT_EMAIL` (or `SMTP_USER` if that's not set), with the customer's address set as reply-to.
- **SMTP not configured:** the message is still logged to the server console and the visitor is told plainly that delivery isn't set up yet — it never claims success it didn't actually achieve.

Tested directly (bypassing the need for Express to be installed): missing-field rejection, the no-config fallback, and the configured-but-SMTP-down case all behave correctly and report honestly.

The phone number and hours on that section (`(555) 010-0142`, "Mon–Fri, 8am–6pm ET") are placeholders — replace them with real ones before this goes live. They're marked as placeholders on the page itself so nobody mistakes them for real.

## 6. Making this an actual public website — domain, hosting, HTTPS

Everything above works locally. To make it something people can actually search for and sign up on, you need three more things, none of which I can do from where I built this (no network access, no ability to register anything on your behalf):

**A domain name.** Register one anywhere (Namecheap, Google Domains successor registrars, Cloudflare Registrar, etc.) — a few dollars a year.

**Hosting for the Node app.** This is a normal Express app, so any Node-friendly host works: Render, Railway, Fly.io, or a plain VPS (DigitalOcean, Linode, etc.) running `node server.js` under a process manager like `pm2` so it restarts if it crashes or the machine reboots. Whichever you pick:
- Set every variable from `.env.example` in that host's environment settings — don't commit `.env` itself anywhere.
- If you're running the persistent monitor (`monitor.html`) on this same host, remember `ffmpeg` needs to be installed on that host's machine too, not just your laptop.
- Point the domain's DNS at the host (an A record or CNAME, depending on what the host tells you to use).

**HTTPS.** Non-negotiable, not just for looking legitimate — the browser camera and screen-share APIs used throughout this project flatly refuse to work over plain HTTP on anything other than localhost (this came up earlier when camera access was silently failing). Most of the hosts above (Render, Railway, Fly.io) provision a free HTTPS certificate automatically once your domain is pointed at them. On a bare VPS, use Let's Encrypt (`certbot`) — it's free and automatic.

**Once that's live, update these placeholders:**
- `securityai.html`'s `<link rel="canonical">` and `og:url`/`twitter` meta tags — currently `your-domain-goes-here.com`
- `robots.txt`'s `Sitemap:` line — same placeholder
- `sitemap.xml`'s `<loc>` — same placeholder
- `.env`'s `DOMAIN` value — needs to be the real `https://yourdomain.com`, since Stripe Checkout uses it to build the redirect URLs after payment
- Swap `STRIPE_SECRET_KEY` from a `sk_test_...` to a live `sk_live_...` key only once you've actually tested the full flow — real cards get charged after that switch

**What "search engine discoverable" honestly means here:** the meta description, Open Graph tags, `robots.txt`, and `sitemap.xml` are the real, standard mechanics that let Google (or anyone) find and correctly preview this page — I've added all of them. What none of that can do is make Google rank it well or index it quickly; that takes time, inbound links, and content, same as any new site. A day-one domain with correct meta tags is discoverable in principle, not necessarily on page one of search results.

## 7. The logo, and why it looks like this

`logo.svg` (and the inline version used in the nav across every page) isn't a generic shield or padlock — those are the default a security-product logo generator reaches for, and they don't say anything about *this* product specifically. Instead it's built from the visual language the site already uses: the four corner brackets are the same camera-viewfinder framing used in the hero's camera wall and every demo feed frame, and the center dot is the same green "live" indicator already sitting next to the wordmark and on the REC light. The mark reads as "a viewfinder, actively watching" — which is literally what the product does — rather than an unrelated icon bolted onto the brand.

## 8. On being "better than any competitor" — an honest answer, with real numbers

I looked this up rather than asserting it, including a fresh re-check this round specifically for pricing. The real market splits into a few camps:

- **Dedicated hardware sensors** (inline tailgating-detection devices, optical turnstiles) — accurate, but a capital cost per door and a physical install, on top of whatever access control you already run. No clean public pricing to cite here; these are typically quote-only.
- **Cloud access-control platforms with camera add-ons, not gym-specific** — **Kisi** is the clear example: **$50–$80/door/month** for its entry tier, *plus* $600–$900+ per door in hardware (reader, controller) and usually an electrician for wiring. A full access-control replacement, not just a tailgating add-on — a much bigger commitment than this project.
- **Camera-based AI sold specifically to gyms for tailgating** — **Camio** is the closest real analogue to what's built here: same mechanism (existing RTSP camera, count vs. your access-control check-in), no hardware required, **$125/door/month**. It also does something this doesn't: automatically emails members a guest fee when a tailgate is confirmed, turning the detection into direct recovered revenue.

**The uncomfortable part of this data, for our own pricing:** at $250/gym flat (up to 4 cameras), a single-entrance gym pays *more* here than Camio's $125/door for their one door. The flat rate only wins once a gym has 3+ cameras (3 doors × $125 = $375 vs. our $250; 4 doors × $125 = $500 vs. our $250) — and most independent gyms have one main entrance. That means current pricing is a good deal for a multi-entrance gym and a worse deal than the closest competitor for the single-door case that's probably more common. Worth considering a cheaper single-camera tier (roughly $100–150/month) alongside the existing "up to 4 cameras for $250" tier, rather than one flat price regardless of camera count. I haven't changed the pricing based on this — that's a real business decision for you to make with the numbers in front of you, not something to change unilaterally mid-build.

Given all that, **"better than everything else" isn't a claim I can honestly make, and it isn't on the site.** What I can point to, specifically:
- **Natural-language rule changes instead of retraining** — probably the most defensible technical difference, covered honestly in the "Why This Approach" section on the site, including the real trade-off against it (Camio has proven accuracy at scale and that automated billing feature this doesn't have).
- **You get the source code**, not a subscription to a closed platform — cuts both ways, also covered on the site.
- **Pricing structure** is flat per gym rather than per-door, which is a genuine advantage for multi-camera locations specifically, not universally.

The honest pitch is "a different, more transparent trade-off for a specific kind of buyer" — not "objectively superior." I'd be skeptical of any single-page site, including this one, that claims otherwise without data behind it.

## 9. Turning this into an actual, legal business

Building the product is maybe a third of what "a real business" requires. In rough order:

1. **Form a real business entity** (an LLC is the usual starting point for something like this) before you take a single real payment — this is what separates your personal assets from a lawsuit if a false flag causes a bad situation with a member.
2. **Get real legal review of everything user-facing**: the consent checkboxes on checkout and monitor.html are UI, not a Terms of Service or Privacy Policy. You need both, written by an actual lawyer familiar with (a) your state's surveillance/biometric-adjacent data laws and (b) recurring-billing disclosure requirements, before charging anyone.
3. **Get liability insurance** (general liability at minimum; ask a broker whether E&O/tech liability makes sense given you're selling software that flags human behavior). A false tailgate flag leading to a wrongly-accused member is a foreseeable claim.
4. **Stripe's live mode requires business verification** — a real EIN/business entity, a bank account, and identity verification, not just an API key swap. Budget time for this before you plan to charge real cards.
5. **Comparative advertising is a real legal category** — if you ever want to publicly claim "cheaper than X" or "better than Y" by name, that needs its own legal sign-off (truth-in-advertising rules vary by what you claim and how you back it up). The "Why This Approach" section on the site deliberately doesn't name competitors for this reason.
6. **Distribution**: gym owners are the buyer, and they're a reachable, fairly concentrated audience — gym owner Facebook groups and forums, direct outreach to independent (non-franchise) gyms and boutique studios who don't already have an access-control vendor relationship, and franchise conventions/trade shows (e.g. the fitness-industry trade show circuit) are all more realistic first channels than general SEO, which takes months regardless of how correct your meta tags are.
7. **Talk to actual gym owners before you finalize pricing** — $250/gym is a reasoned number, not a validated one. A handful of real conversations with the people who'd actually buy this will tell you more than any pricing theory.

None of this is optional if "gyms across the U.S." is the actual goal rather than a working demo — happy to keep going deeper on any one of these whenever you're ready for it.
