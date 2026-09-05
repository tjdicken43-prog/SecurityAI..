// SecurityAI — persistent monitoring engine.
//
// This is what makes "runs nonstop until you stop it from the website"
// actually true. A browser tab can't do that — close it, let the laptop
// sleep, or lose focus, and any JS timer running inside it dies. This
// module runs inside the Node process started by `node server.js`, which
// keeps going independently of any browser window, and only stops when
// you call /monitor/stop (or kill the process).
//
// WHAT THIS NEEDS THAT server.js's PAYMENT SIDE DIDN'T:
//   - ffmpeg installed on this machine (a system binary, not an npm
//     package) — used to grab a single JPEG frame from a camera URL.
//       macOS:   brew install ffmpeg
//       Ubuntu:  sudo apt install ffmpeg
//       Windows: https://ffmpeg.org/download.html
//   - A real Anthropic API key in .env as ANTHROPIC_API_KEY. The browser
//     demo on securityai.html could call Claude without one because
//     claude.ai proxies that call for pages rendered inside it — a
//     standalone Node process has no such proxy and needs a real key
//     from console.anthropic.com.
//   - Optional: SMTP credentials (for email alerts) and/or Twilio
//     credentials (for SMS alerts). Both are optional independently —
//     configure either, both, or neither. With neither, flags still show
//     up in the log and on the dashboard, just without a push notification.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let twilioLib = null;
try { twilioLib = require('twilio'); } catch { /* optional dep not installed */ }

const state = {
  running: false,
  timer: null,
  startedAt: null,
  config: null,
  log: [],          // most recent first, capped
  lastError: null,
  captureCount: 0,
};

const MAX_LOG = 200;

function getStatus() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    config: state.config,
    captureCount: state.captureCount,
    lastError: state.lastError,
  };
}

function getLog() {
  return state.log;
}

// Grabs one JPEG frame using ffmpeg, from one of two source types:
//
//   'url'    — an RTSP stream or HTTP snapshot URL. This path is fully
//              OS-independent: ffmpeg reads it as a network source, same
//              command on Windows, macOS, or Linux. This is what most
//              real IP cameras and NVR software expose, so it's the
//              recommended source for most gyms regardless of what
//              computer runs this server.
//
//   'webcam' — a USB/built-in camera plugged directly into the machine
//              running this server. Unlike a network URL, grabbing a
//              frame from a local device uses a different ffmpeg input
//              format per OS (v4l2 on Linux, avfoundation on macOS,
//              dshow on Windows), and the device identifier itself
//              (e.g. "/dev/video0" vs "0" vs "USB2.0 Camera") is
//              specific to the machine, not something we can guess
//              reliably — see listDevices() below, which runs the
//              right ffmpeg/OS command to help find it.
function buildCaptureArgs(cfg, outPath) {
  if (cfg.sourceType === 'webcam') {
    const platform = os.platform();
    const device = cfg.deviceId || '';
    if (!device) {
      throw new Error('No webcam device specified. Use "Detect connected cameras" on the dashboard to find the right value for this OS.');
    }
    if (platform === 'darwin') {
      // avfoundation device index, e.g. "0". framerate is required by
      // avfoundation even though we only keep one frame.
      return ['-y', '-f', 'avfoundation', '-framerate', '30', '-i', device, '-frames:v', '1', '-q:v', '2', outPath];
    }
    if (platform === 'win32') {
      // dshow expects "video=<device name>" exactly as listed by
      // -list_devices, quotes and all if the name has spaces.
      const input = device.startsWith('video=') ? device : `video=${device}`;
      return ['-y', '-f', 'dshow', '-i', input, '-frames:v', '1', '-q:v', '2', outPath];
    }
    // Linux and anything else falls back to v4l2, the standard Linux
    // webcam driver interface.
    return ['-y', '-f', 'v4l2', '-i', device, '-frames:v', '1', '-q:v', '2', outPath];
  }

  // 'url' source — RTSP needs an explicit transport flag for reliability
  // behind NAT/firewalls; anything else (HTTP snapshot, local file) is
  // read as-is.
  const cameraUrl = cfg.cameraUrl;
  return cameraUrl.startsWith('rtsp://')
    ? ['-y', '-rtsp_transport', 'tcp', '-i', cameraUrl, '-frames:v', '1', '-q:v', '2', outPath]
    : ['-y', '-i', cameraUrl, '-frames:v', '1', '-q:v', '2', outPath];
}

// Runs the OS-appropriate command to list connected cameras, so a gym
// owner can find the exact device identifier this platform needs — that
// value genuinely can't be guessed reliably in advance; it depends on
// what's plugged into that specific machine. Returns raw command output
// for the dashboard to display as-is, since the format differs by OS
// and isn't worth normalizing into a fake-unified shape.
function listDevices() {
  return new Promise((resolve) => {
    const platform = os.platform();

    if (platform === 'darwin') {
      const ff = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
      let out = '';
      ff.stderr.on('data', d => { out += d.toString(); });
      ff.on('error', err => resolve({ platform, ok: false, output: `ffmpeg not found: ${err.message}` }));
      ff.on('close', () => resolve({ platform, ok: true, output: out || 'No output — ffmpeg may not support avfoundation on this build.' }));
      return;
    }

    if (platform === 'win32') {
      const ff = spawn('ffmpeg', ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']);
      let out = '';
      ff.stderr.on('data', d => { out += d.toString(); });
      ff.on('error', err => resolve({ platform, ok: false, output: `ffmpeg not found: ${err.message}` }));
      ff.on('close', () => resolve({ platform, ok: true, output: out || 'No output — ffmpeg may not support dshow on this build.' }));
      return;
    }

    // Linux: v4l2 devices show up as /dev/video*. There's no single
    // universal "list devices" ffmpeg subcommand for v4l2 the way there
    // is for avfoundation/dshow, so this lists the device files directly.
    fs.readdir('/dev', (err, files) => {
      if (err) return resolve({ platform, ok: false, output: `Could not read /dev: ${err.message}` });
      const videoDevices = files.filter(f => f.startsWith('video')).map(f => `/dev/${f}`);
      resolve({
        platform,
        ok: true,
        output: videoDevices.length
          ? `Found: ${videoDevices.join(', ')}\nTry the first one (usually /dev/video0). If a device doesn't respond, try the next.`
          : 'No /dev/video* devices found. Is a camera connected, and do you have permission to access it (try running with the right group membership, e.g. "video" group on most distros)?',
      });
    });
  });
}

function captureFrame(cfg) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `securityai-frame-${Date.now()}.jpg`);
    let args;
    try {
      args = buildCaptureArgs(cfg, outPath);
    } catch (err) {
      return reject(err);
    }

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });

    ff.on('error', err => {
      reject(new Error(`ffmpeg failed to start — is it installed and on your PATH? (${err.message})`));
    });

    ff.on('close', code => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        return reject(new Error(`ffmpeg exited with code ${code}. Last output: ${stderr.slice(-300)}`));
      }
      fs.readFile(outPath, (err, data) => {
        fs.unlink(outPath, () => {}); // best-effort cleanup, don't block on it
        if (err) return reject(err);
        resolve(data.toString('base64'));
      });
    });
  });
}

const vision = require('./vision');
const mailer = require('./mailer');

let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  if (!twilioLib || !process.env.TWILIO_SID) return null;
  twilioClient = twilioLib(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}

async function sendAlert(cfg, message) {
  const results = { email: null, sms: null };

  if (cfg.alertEmail) {
    const result = await mailer.sendMail({
      to: cfg.alertEmail,
      subject: 'SecurityAI alert — unscanned entry detected',
      text: message,
    });
    results.email = result.delivered ? 'sent' : `skipped/failed — ${result.reason}`;
  }

  if (cfg.alertPhone) {
    const client = getTwilioClient();
    if (!client) {
      results.sms = 'skipped — Twilio not configured in .env';
    } else if (!process.env.TWILIO_FROM_NUMBER) {
      results.sms = 'skipped — TWILIO_FROM_NUMBER not set in .env';
    } else {
      try {
        await client.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: cfg.alertPhone,
          body: message,
        });
        results.sms = 'sent';
      } catch (err) {
        results.sms = `failed — ${err.message}`;
      }
    }
  }

  return results;
}

function pushLog(entry) {
  state.log.unshift(entry);
  if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
}

function sourceLabelFor(cfg) {
  if (cfg.label) return cfg.label;
  if (cfg.sourceType === 'webcam') return `webcam ${cfg.deviceId}`;
  if (cfg.sourceType === 'browser-push') return 'screen share (browser tab)';
  return cfg.cameraUrl;
}

// Shared by both acquisition paths: ffmpeg pulling a frame on its own
// timer (tick, below), and a browser tab pushing a screen-share frame it
// captured itself (pushFrame, below). Either way, once we have a base64
// JPEG, analysis/alerting/logging is identical.
async function processFrame(base64) {
  const cfg = state.config;
  const ts = new Date().toISOString();
  try {
    const result = await vision.analyzeEntry(base64, cfg);
    state.captureCount += 1;
    state.lastError = null;

    let alertResult = null;
    if (result.tailgate_flag) {
      const message = `SecurityAI: unscanned entry at ${sourceLabelFor(cfg)} — ${result.people_count} seen, ${cfg.expectedCount} expected. "${result.note}"`;
      alertResult = await sendAlert(cfg, message);
    }

    pushLog({
      timestamp: ts,
      people_count: result.people_count,
      queued_count: result.queued_count,
      accessible_gate_used: result.accessible_gate_used,
      tailgate_flag: result.tailgate_flag,
      note: result.note,
      alertResult,
    });
  } catch (err) {
    state.lastError = err.message;
    pushLog({ timestamp: ts, error: err.message });
  }
}

// ffmpeg-driven acquisition, used for 'url' and 'webcam' sources — the
// server pulls a frame on its own timer, independent of any browser.
async function tick() {
  const cfg = state.config;
  try {
    const base64 = await captureFrame(cfg);
    await processFrame(base64);
  } catch (err) {
    state.lastError = err.message;
    pushLog({ timestamp: new Date().toISOString(), error: err.message });
  }
}

// Browser-driven acquisition, used for 'browser-push' (screen share).
// A screen share is fundamentally a browser-mediated permission — there
// is no way for a headless server process to capture a screen without
// an active, consenting browser tab doing the sharing. So for this
// source only, the browser tab itself captures each frame and POSTs it
// here on its own timer; this function just runs the same analysis/
// alert/log path once a frame arrives. If that browser tab closes, this
// source stops receiving frames — which is an inherent property of
// screen-sharing, not a bug specific to this implementation.
async function pushFrame(base64) {
  if (!state.running || state.config.sourceType !== 'browser-push') {
    throw new Error('Monitoring is not running with a browser-push source.');
  }
  await processFrame(base64);
}

function start(cfg) {
  if (state.running) throw new Error('Monitoring is already running — stop it first.');

  const validTypes = ['url', 'webcam', 'browser-push'];
  const sourceType = validTypes.includes(cfg.sourceType) ? cfg.sourceType : 'url';
  if (sourceType === 'url' && !cfg.cameraUrl) {
    throw new Error('cameraUrl is required for an IP camera / stream source.');
  }
  if (sourceType === 'webcam' && !cfg.deviceId) {
    throw new Error('deviceId is required for a webcam source — use "Detect connected cameras" to find it.');
  }
  // browser-push needs no server-side address — the browser tab captures
  // and posts frames itself, so there's nothing to validate here beyond
  // the shared fields below.

  let secs = parseInt(cfg.intervalSeconds, 10);
  if (!secs || secs < 5) secs = 5; // floor — this hits a real API on a real bill every tick/push

  state.config = {
    sourceType,
    cameraUrl: cfg.cameraUrl || null,
    deviceId: cfg.deviceId || null,
    label: cfg.label || '',
    expectedCount: parseInt(cfg.expectedCount, 10) || 1,
    accessibleGate: !!cfg.accessibleGate,
    alertEmail: cfg.alertEmail || null,
    alertPhone: cfg.alertPhone || null,
    intervalSeconds: secs,
  };
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.captureCount = 0;
  state.lastError = null;
  state.log = [];

  if (sourceType === 'browser-push') {
    // No server-side timer — the browser tab drives its own interval and
    // hits /monitor/push-frame directly. We just sit and wait.
    return;
  }

  tick(); // run one immediately
  state.timer = setInterval(tick, secs * 1000);
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
}

module.exports = { start, stop, getStatus, getLog, listDevices, pushFrame, platform: os.platform() };
