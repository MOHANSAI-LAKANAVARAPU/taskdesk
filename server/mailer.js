// Email through the company Zoho mailbox (settings from .env: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
// SMTP_FROM, APP_URL). Used exactly as written, no auto-detection. Emails are queued in memory and sent one at a time in
// the background, so no request ever waits for the mail server; each gets up to 3 attempts. The password is never logged.
// Sending is paced (EMAIL_PER_MINUTE, default 10) to stay inside the mail provider's limits; if the provider answers that
// a limit was reached, everything waits an hour (Zoho's restriction period) and then carries on. See "Email" in CLAUDE.md.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const env = process.env;
const cfg = {
  host: env.SMTP_HOST || '', port: Number(env.SMTP_PORT) || 0, secure: env.SMTP_SECURE === 'true',
  user: env.SMTP_USER || '', from: env.SMTP_FROM || env.SMTP_USER || '',
  appUrl: (env.APP_URL || '').replace(/\/+$/, '')
};
const PASS = env.SMTP_PASS || '';
const configured = !!(cfg.host && cfg.port && cfg.user && PASS);
// Test-only switches (never set in docker-compose.yml): EMAIL_DRY_RUN=1 records instead of sending; EMAIL_OUTBOX=<file>
// appends a copy of every email (to, subject, text) to that file.
const DRY_RUN = env.EMAIL_DRY_RUN === '1';
const OUTBOX = env.EMAIL_OUTBOX || '';
// More test-only switches, honoured only together with EMAIL_DRY_RUN=1: EMAIL_TEST_SPEED=1 shortens the retry waits and
// the limit pause to seconds; EMAIL_TEST_FAIL=<text> makes every email to an address containing it fail ("550 User
// unknown"); EMAIL_TEST_LIMIT_AFTER=<n> makes the (n+1)th email fail once with a "sending limit exceeded" answer.
const TEST = DRY_RUN ? { speed: env.EMAIL_TEST_SPEED === '1', fail: env.EMAIL_TEST_FAIL || '', limitAfter: Number(env.EMAIL_TEST_LIMIT_AFTER) || 0 } : { speed: false, fail: '', limitAfter: 0 };

const fromAddress = (cfg.from.match(/<([^>]+)>/) || [null, cfg.from])[1].trim();
const transport = DRY_RUN ? nodemailer.createTransport({ jsonTransport: true }) : configured ? nodemailer.createTransport({
  host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: PASS },
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
}) : null;
const BANNER = path.join(__dirname, 'email-banner.jpg');

// Pacing: at most EMAIL_PER_MINUTE emails a minute (1-600, default 10), one every 60/n seconds.
const PER_MINUTE = (n => Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 600) : 10)(Number(env.EMAIL_PER_MINUTE));
const GAP_MS = Math.round(60e3 / PER_MINUTE);
const LIMIT_PAUSE_MS = TEST.speed ? 3000 : 60 * 60e3; // Zoho: "limits reset after the 1-hour restriction period"
// A provider answer that means "you sent too much" (a 4xx/5xx reply mentioning a limit), as opposed to a bad address.
const isLimit = err => { const t = String(err && (err.response || err.message) || '');
  return !!err && err.responseCode >= 400 && !/\b(size|attachment|too large)\b/i.test(t) && /\b(limit|limits|too many|rate|quota|exceed|exceeded|restrict|restricted|throttl\w*)\b/i.test(t); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const state = { sent: 0, failed: 0, lastError: null, lastSent: null, pausedUntil: 0 };
const waiting = [];
const RETRY_MS = TEST.speed ? [300, 300] : [60e3, 5 * 60e3]; // before attempt 2 and 3
let busy = false;

// Never let the password reach a log line or the page.
const scrub = s => { let t = String(s || ''); if (PASS) t = t.split(PASS).join('****'); return t.slice(0, 300); };
// A clear reason for the admin ("Sign-in failed: check the app password", "Can't reach smtppro.zoho.com:465").
function reason(err) {
  const code = err && (err.code || '');
  const where = `${cfg.host}:${cfg.port}`;
  if (code === 'EAUTH') return 'Sign-in failed: check the app password' + (err.responseCode ? ` (${err.responseCode})` : '');
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ENOTFOUND', 'ECONNREFUSED', 'EDNS', 'ECONNRESET'].includes(code))
    return `Can't reach ${where} (${scrub(err.message || code)})`;
  if (code === 'ETLS') return `Secure connection to ${where} failed: ${scrub(err.message)}`;
  if (code === 'EENVELOPE') return `The address was refused: ${scrub(err.response || err.message)}`;
  if (code === 'EMESSAGE') return `The message was refused: ${scrub(err.response || err.message)}`;
  return scrub(err && (err.response || err.message) || 'Unknown error');
}

const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const link = hashPath => `${cfg.appUrl}/#/${hashPath.replace(/^[#/]+/, '')}`;

// Short HTML (banner, heading, a line or two, one button, footer) plus a plain-text version. All text is escaped here.
function layout({ heading, lines = [], button, after = [] }) {
  const p = t => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#1f2937">${escHtml(t)}</p>`;
  const btn = button ? `<p style="margin:22px 0"><a href="${escHtml(button.url)}" style="display:inline-block;background:#1d6fe0;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 22px;border-radius:6px">${escHtml(button.label)}</a></p>
    <p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#6b7280">If the button doesn't work, copy this link into your browser:<br><a href="${escHtml(button.url)}" style="color:#1d6fe0;word-break:break-all">${escHtml(button.url)}</a></p>` : '';
  const footer = 'Sent by TaskDesk, Hi-Focus. Please don\'t reply to this email.';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#0b1a33"><img src="cid:hifocus-banner" width="600" alt="Hi-Focus" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>
<tr><td style="padding:26px 28px 10px">
<h1 style="margin:0 0 16px;font-size:20px;color:#111827">${escHtml(heading)}</h1>
${lines.map(p).join('')}${btn}${after.map(p).join('')}
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${escHtml(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [heading, '', ...lines, ...(button ? ['', `${button.label}: ${button.url}`] : []), ...(after.length ? ['', ...after] : []), '', '--', footer].join('\n');
  return { html, text };
}

function message(to, subject, body) {
  return {
    from: { name: 'TaskDesk', address: fromAddress }, to, subject, html: body.html, text: body.text,
    // The banner is the only embedded file (inline, shown at the top); emails never carry user files.
    attachments: fs.existsSync(BANNER) ? [{ filename: 'hifocus-banner.jpg', path: BANNER, cid: 'hifocus-banner', contentDisposition: 'inline' }] : []
  };
}
async function deliver(m) {
  if (!transport) { const e = new Error('Email is not set up (SMTP settings missing in .env)'); e.code = 'ENOTCONFIGURED'; throw e; }
  if (TEST.fail && String(m.to).includes(TEST.fail)) throw Object.assign(new Error('User unknown'), { responseCode: 550, response: '550 5.1.1 User unknown' });
  if (TEST.limitAfter && !TEST.limitDone && state.sent >= TEST.limitAfter) { TEST.limitDone = true; throw Object.assign(new Error('limit'), { responseCode: 554, response: '554 5.7.0 sending limit exceeded' }); }
  await transport.sendMail(m);
  if (OUTBOX) try { fs.appendFileSync(OUTBOX, JSON.stringify({ at: new Date().toISOString(), to: m.to, subject: m.subject, text: m.text, attachments: m.attachments.map(a => a.filename) }) + '\n'); } catch (e) { /* test copy only */ }
}

async function work() {
  if (busy) return;
  busy = true;
  try {
    while (waiting.length) {
      if (Date.now() < state.pausedUntil) { setTimeout(work, Math.max(1000, state.pausedUntil - Date.now())); break; }
      const now = Date.now(), i = waiting.findIndex(j => j.due <= now);
      if (i < 0) { setTimeout(work, Math.max(1000, Math.min(...waiting.map(j => j.due)) - now)); break; }
      const job = waiting.splice(i, 1)[0];
      job.attempt++;
      try {
        await deliver(job.msg);
        state.sent++; state.lastSent = { at: new Date().toISOString(), to: job.msg.to, subject: job.msg.subject };
        console.log(`[email] sent to ${job.msg.to} "${job.msg.subject}"${DRY_RUN ? ' (dry run)' : ''}`);
        done(job, { ok: true });
      } catch (err) {
        const why = err.code === 'ENOTCONFIGURED' ? err.message : reason(err);
        console.log(`[email] failed (attempt ${job.attempt}/3) to ${job.msg.to} "${job.msg.subject}": ${why}`);
        if (isLimit(err)) {
          // The provider says we sent too much: this isn't the message's fault, so it keeps its attempt, and everything waits.
          job.attempt--; job.due = state.pausedUntil = Date.now() + LIMIT_PAUSE_MS; waiting.push(job);
          state.lastError = { at: new Date().toISOString(), to: job.msg.to, subject: job.msg.subject, reason: `Sending limit reached: ${why}. Paused for 1 hour.` };
          console.log('[email] the mail server says a sending limit was reached; pausing all email for 1 hour');
        } else if (job.attempt < 3) { job.due = Date.now() + RETRY_MS[job.attempt - 1]; waiting.push(job); }
        else { state.failed++; state.lastError = { at: new Date().toISOString(), to: job.msg.to, subject: job.msg.subject, reason: why }; done(job, { ok: false, error: why }); }
      }
      if (waiting.length) await sleep(GAP_MS); // pacing between emails
    }
  } finally { busy = false; }
}

// The final result of an email (sent, or failed after all attempts) goes to the optional callback given to queue().
function done(job, result) { if (job.onResult) try { job.onResult(result); } catch (e) { console.error('[email] result callback failed:', e.message); } }
// Queue an email; returns at once. Nothing is queued when email isn't set up. onResult({ ok, error }) is called once
// when the email has finally been sent or has finally failed (not on a restart: the queue lives in memory).
function queue(to, subject, body, onResult) {
  if (!configured && !DRY_RUN) return false;
  waiting.push({ msg: message(to, subject, body), attempt: 0, due: 0, onResult });
  setImmediate(work);
  return true;
}
// "Send test email": sent right away so the admin sees the real result. Returns null on success, else the reason.
async function sendNow(to, subject, body) {
  try { await deliver(message(to, subject, body)); state.sent++; state.lastSent = { at: new Date().toISOString(), to, subject }; console.log(`[email] test sent to ${to}`); return null; }
  catch (err) {
    const why = err.code === 'ENOTCONFIGURED' ? err.message : reason(err);
    state.lastError = { at: new Date().toISOString(), to, subject, reason: why };
    console.log(`[email] test to ${to} failed: ${why}`);
    return why;
  }
}
function status() {
  return { configured: configured || DRY_RUN, dry_run: DRY_RUN, host: cfg.host, port: cfg.port, ssl: cfg.secure, user: cfg.user,
    from: `TaskDesk <${fromAddress}>`, app_url: cfg.appUrl, password_set: !!PASS,
    sent: state.sent, failed: state.failed, waiting: waiting.length, last_error: state.lastError, last_sent: state.lastSent,
    per_minute: PER_MINUTE, paused_until: state.pausedUntil > Date.now() ? new Date(state.pausedUntil).toISOString() : null };
}

console.log(configured || DRY_RUN ? `[email] ready: ${cfg.host}:${cfg.port} ssl=${cfg.secure} as ${cfg.user}${DRY_RUN ? ' (dry run)' : ''}` : '[email] not set up (SMTP_HOST/SMTP_USER/SMTP_PASS missing); emails are off');
module.exports = { queue, sendNow, status, layout, link, enabled: () => configured || DRY_RUN };
