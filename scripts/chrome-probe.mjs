// chrome-probe — 用内核 profile 起一个 Chrome，导航到 url，跑一段 JS，打印结果。
// 用途：排查「插件里打不开的页面」（例如 GitHub 的文件编辑器）到底是不是被
// 自动化特征挡了 —— 换不同的启动参数对比即可。
//
//   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" scripts/chrome-probe.mjs <url> [--js EXPR] [--wait MS] [--flag "--foo"] [--port 9445] [--visible]
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.DSH_CHROME || String.raw`C:\Users\Administrator\Desktop\ocs-2.9.24-setup-win-x64\resources\bin\chrome\chrome\chrome.exe`;
const PROFILE = process.env.DSH_GH_PROFILE || join(tmpdir(), 'dsh-github-profile');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);
const url = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const PORT = Number(opt('port', '9445'));
const WAIT = Number(opt('wait', '6000'));
const JS = opt('js', 'document.body.innerText.length');
const flags = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--flag') flags.push(argv[i + 1]);

const base = `http://127.0.0.1:${PORT}`;

const args = [
  '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + PORT,
  ...(has('visible') ? [] : ['--headless=new']),
  ...flags,
  'about:blank',
];

const child = spawn(CHROME, args, { stdio: 'ignore' });
let ws;
try {
  let ok = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base + '/json/version', { signal: AbortSignal.timeout(800) }); if (r.ok) { ok = true; break } } catch {}
    await sleep(350);
  }
  if (!ok) throw new Error('chrome did not start');

  let target;
  for (let i = 0; i < 20; i++) {
    const list = await fetch(base + '/json/list').then((r) => r.json()).catch(() => []);
    target = list.find((t) => t.type === 'page');
    if (target) break;
    await sleep(300);
  }
  if (!target) throw new Error('no page target');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)) } }, 40000);
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  await sleep(WAIT);
  console.error('[probe] webdriver=' + await ev('navigator.webdriver') + ' url=' + await ev('location.href'));
  console.log(JSON.stringify({ result: await ev(JS) }, null, 0));
  await send('Browser.close').catch(() => {});
} catch (e) {
  console.error('[probe] ERROR', e.message);
  process.exitCode = 1;
} finally {
  try { child.kill() } catch {}
  try { ws?.close() } catch {}
}
