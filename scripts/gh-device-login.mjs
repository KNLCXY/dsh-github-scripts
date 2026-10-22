// gh-device-login — 用内核 profile 里已登录的 GitHub 会话，走 OAuth 设备流拿一个
// 能写仓库的 token（gh CLI 的 client_id，scope=repo）。
//
// 为什么需要它：浏览器工具每次调用都会重新导航，而设备流的「输码 → 授权」是
// 一次真实表单提交之后的页面，必须保持同一个页面上下文才能点「Authorize」。
// 这个脚本自己驱动 CDP，页面就一直在手里。
//
// 用法（先关掉正在用同一个 profile 的 Chrome，避免 profile 锁）：
//   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/gh-device-login.mjs
//   ... --scope "repo read:org"  --port 9444  --visible  --profile <dir>  --chrome <exe>
//
// 输出：token（gho_...）写进 %TEMP%/gh-device-token.txt，不打印到 stdout（免得进对话上下文）。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

// 内核路径：DSH_CHROME > --chrome > 这个默认值（换机器必改）。
// profile：DSH_GH_PROFILE > --profile > %TEMP%/dsh-github-profile。
// 想复用 dsh-browser-kernel 的登录态，把 profile 指到 %TEMP%/dsh-browser-kernel-profile，
// 前提是那边启动的 Chrome 已经关掉。
const CHROME = process.env.DSH_CHROME || arg('chrome', String.raw`C:\Users\Administrator\Desktop\ocs-2.9.24-setup-win-x64\resources\bin\chrome\chrome\chrome.exe`);
const PROFILE = process.env.DSH_GH_PROFILE || arg('profile', join(tmpdir(), 'dsh-github-profile'));
const CLIENT_ID = '178c6fc778ccc68e1d6a'; // gh CLI 的公开 client_id（设备流不需要 client_secret）

const PORT = Number(arg('port', '9444'));
const SCOPE = arg('scope', 'repo read:org');
const VISIBLE = argv.includes('--visible');
const BASE = `http://127.0.0.1:${PORT}`;

const log = (...a) => console.error('[gh]', ...a);

// ---------- CDP ----------
class CDP {
  constructor (ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async open (url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    return c;
  }
  send (method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('cdp timeout ' + method)) } }, 30000);
    });
  }
  async eval (expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
}

// ---------- 设备流 ----------
async function requestCode () {
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
  });
  const j = await r.json();
  if (!j.device_code) throw new Error('device/code failed: ' + JSON.stringify(j));
  return j;
}

async function pollToken (deviceCode, intervalS, deadlineMs) {
  while (Date.now() < deadlineMs) {
    await sleep(intervalS * 1000);
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const j = await r.json();
    if (j.access_token) return j;
    if (j.error === 'authorization_pending' || j.error === 'slow_down') continue;
    throw new Error('token error: ' + JSON.stringify(j));
  }
  throw new Error('token poll timeout');
}

// ---------- 浏览器 ----------
async function launch () {
  const args = [
    VISIBLE ? '--headless=old' : '--headless=new',
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--hide-scrollbars',
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + PORT,
    'about:blank',
  ];
  if (VISIBLE) args.shift();
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/json/version', { signal: AbortSignal.timeout(1000) });
      if (r.ok) return child;
    } catch {}
    await sleep(400);
  }
  throw new Error('chrome did not start');
}

async function pageWs () {
  for (let i = 0; i < 20; i++) {
    const list = await fetch(BASE + '/json/list').then((r) => r.json()).catch(() => []);
    const p = list.find((t) => t.type === 'page');
    if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    await sleep(300);
  }
  throw new Error('no page target');
}

async function ready (cdp, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await cdp.eval('document.readyState') === 'complete') return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function goto (cdp, url) {
  await cdp.send('Page.navigate', { url }).catch(() => {});
  await sleep(600);
  await ready(cdp);
  await sleep(500);
  return cdp.eval('location.href').catch(() => '');
}

async function waitHref (cdp, pred, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let href = '';
    try { href = await cdp.eval('location.href') } catch {}
    if (href && pred(href)) { await ready(cdp); return href }
    await sleep(400);
  }
  return '';
}

const FILL = (code) => `(function(){
  var code=${JSON.stringify(code)};
  var set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  var n=0;
  for(var i=0;i<12;i++){
    var el=document.querySelector('#user-code-'+i);
    if(!el) break;
    el.focus(); set.call(el, code[i]||'');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    n++;
  }
  return n;
})()`;

// 每个格子单独聚焦 + Input.insertText：insertText 会产生真实的 input 事件，
// 但不会触发格子间的 keydown 自动跳转，所以逐格写最稳。
// 注意：9 个格子里有一个是**预填了 '-' 的分隔格**（user-code-4），必须跳过。
async function typeCode (cdp, digits) {
  const boxes = await cdp.eval(`[].slice.call(document.querySelectorAll('input[id^="user-code-"]')).map(function(e){return {id:e.id, v:e.value}})`)
    .catch(() => []);
  let k = 0;
  for (const b of boxes || []) {
    if ((b.v || '').trim() === '-' || (b.v || '').trim() === '—') continue;
    if (k >= digits.length) break;
    await cdp.eval(`(function(){var el=document.querySelector('#${b.id}'); if(!el) return 0; el.focus(); el.select && el.select(); return 1})()`);
    await sleep(80);
    await cdp.send('Input.insertText', { text: digits[k] });
    await sleep(120);
    k++;
  }
  return cdp.eval(`[].slice.call(document.querySelectorAll('input[id^="user-code-"]')).map(function(e){return e.value}).join('')`).catch(() => '');
}

const CLICK_SUBMIT = `(function(){
  var b=document.querySelector('form input[type=submit],form button[type=submit],input[type=submit]');
  if(!b) return 'no-submit';
  b.click(); return 'ok';
})()`;

const CLICK_AUTHORIZE = `(function(){
  var all=[].slice.call(document.querySelectorAll('button,input[type=submit],a'));
  for(var i=0;i<all.length;i++){
    var t=(all[i].innerText||all[i].value||'').trim();
    if(/^(Authorize\\b|Continue\\b|Confirm\\b)/i.test(t) && !/cancel/i.test(t)){ all[i].click(); return 'clicked:'+t }
  }
  return 'not-found:'+document.body.innerText.replace(/\\s+/g,' ').slice(0,140);
})()`;

// 授权页是表单 POST /login/device/authorize，两个 submit：authorize=0 取消、=1 同意。
// 直接点按钮有时不触发（元素被遮），所以补一个 authorize=1 的隐藏字段再 form.submit()。
const SUBMIT_AUTHORIZE = `(function(){
  var f=document.querySelector('form[action="/login/device/authorize"]');
  if(!f) return 'no-form';
  var i=document.createElement('input');
  i.type='hidden'; i.name='authorize'; i.value='1';
  f.appendChild(i);
  f.submit();
  return 'submitted';
})()`;

/** 设备流提交后可能经过 1–2 个确认页（/login/device/confirmation → oauth/authorize）。 */
async function clickThrough (cdp, href) {
  for (let i = 0; i < 4; i++) {
    const r = await cdp.eval(SUBMIT_AUTHORIZE).catch(() => 'gone');
    log('authorize-submit', i, r);
    if (!r || (!String(r).startsWith('submitted') && !String(r).startsWith('clicked'))) {
      const r2 = await cdp.eval(CLICK_AUTHORIZE).catch(() => 'gone');
      log('authorize-click', i, r2);
      if (!r2 || !String(r2).startsWith('clicked')) break;
    }
    await sleep(3500);
    const after = await cdp.eval('location.href + " :: " + document.body.innerText.replace(/\\s+/g," ").slice(0,200)').catch(() => '');
    log('after-click', i, after);
    if (/success|all set|congratulations|authorized/i.test(after)) break;
    const next = await waitHref(cdp, (h) => h !== href, 8000);
    if (!next) break;
    href = next;
  }
  return href;
}

// ---------- main ----------
const chrome = await launch().catch((e) => { log('launch failed', e.message); process.exit(1) });
let token = null;
try {
  const ws = await pageWs();
  const cdp = await CDP.open(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const dev = await requestCode();
  log('user_code', dev.user_code);

  let href = await goto(cdp, 'https://github.com/login/device?skip_account_picker=true');
  log('at', href);
  if (!/login\/device/.test(href)) {
    // 需要先确认会话
    if (/select_account/.test(href)) {
      await cdp.eval(`(function(){var b=document.querySelector('input[type=submit]');if(b){b.click();return 1}return 0})()`);
      href = await waitHref(cdp, (h) => !/select_account/.test(h), 20000);
      log('after account pick', href);
      if (!/device/.test(href)) {
        href = await goto(cdp, 'https://github.com/login/device?skip_account_picker=true');
        log('re-goto', href);
      }
    }
  }

  const digits = dev.user_code.replace(/-/g, '');
  const typed = await typeCode(cdp, digits);
  log('typed', typed, 'want', digits);
  await sleep(400);
  const sub = await cdp.eval(CLICK_SUBMIT);
  log('submit', sub);
  href = await waitHref(cdp, (h) => !/login\/device\?/.test(h) && !h.endsWith('/login/device'), 25000);
  log('after code', href);

  if (!href) {
    throw new Error('still on device page after submit');
  }
  if (/failure/.test(href)) {
    const txt = await cdp.eval('document.body.innerText.replace(/\\s+/g," ").slice(0,300)').catch(() => '');
    throw new Error('device failure page: ' + href + ' :: ' + txt);
  }

  // 同意页（可能是 /login/device/confirmation，也可能跳到 /login/oauth/authorize）
  if (/confirmation|oauth\/authorize/.test(href)) {
    const txt = await cdp.eval('document.body.innerText.replace(/\\s+/g," ").slice(0,300)').catch(() => '');
    log('consent page:', txt.slice(0, 160));
    href = await clickThrough(cdp, href);
    log('after authorize', href);
  }

  token = await pollToken(dev.device_code, Number(dev.interval) || 5, Date.now() + 90000);
  const out = join(tmpdir(), 'gh-device-token.txt');
  writeFileSync(out, token.access_token, 'utf8');
  // 不把 token 打到 stdout（会进对话上下文），只报落盘位置和 scope
  console.log(JSON.stringify({ ok: true, scope: token.scope, saved: out, len: token.access_token.length }));
} catch (e) {
  log('ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { chrome.kill() } catch {}
  await sleep(500);
}
