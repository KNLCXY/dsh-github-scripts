// 找一份可用的 Chromium 内核。
//
// 和 dsh-websift 里那套是同一份逻辑（多根目录 + Chromium 特征校验 + 偏好排序），
// 刻意复制而不是依赖插件：脚本要能单独 clone 下来就用。
// 改动时两边一起改（websift 的 lib/index.js 里搜 scanChromiumRoots）。
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CHROMIUM_EXE_RE = /^(chrome|chromium|msedge|brave|vivaldi|opera|360se|360chrome|360se6|qqbrowser|sogouexplorer|doubao|quark|ucbrowser|liebao|2345explorer|maxthon|centbrowser|thorium|yandex)\.exe$/i

const SCAN_SKIP_RE = /^(node_modules|\.git|Temp|tmp|Cache|GPUCache|Code Cache|CrashDumps|Packages|WinSxS|System32|SysWOW64|Installer|WindowsApps|DriverStore)$/i

function looksLikeChromium(dir) {
  try {
    const names = readdirSync(dir)
    return names.includes('icudtl.dat') || names.some((n) => n.toLowerCase().endsWith('.pak'))
  } catch {
    return false
  }
}

/** 固定位置的候选（先试这些，最快）。 */
export function candidates() {
  const out = []
  const env = process.env
  if (env.DSH_CHROME) out.push(env.DSH_CHROME)
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles || 'C:/Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'
    const local = env.LOCALAPPDATA || ''
    out.push(
      `${pf}/Google/Chrome/Application/chrome.exe`,
      `${pf86}/Google/Chrome/Application/chrome.exe`,
      local ? `${local}/Google/Chrome/Application/chrome.exe` : '',
      `${pf}/Microsoft/Edge/Application/msedge.exe`,
      `${pf86}/Microsoft/Edge/Application/msedge.exe`,
      `${pf}/BraveSoftware/Brave-Browser/Application/brave.exe`,
      `${pf}/Chromium/Application/chrome.exe`,
    )
  } else if (process.platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge')
  }
  return out.filter(Boolean)
}

/** 偏好：标准浏览器优先，应用内置排最后。 */
function preference(path) {
  const name = String(path).split(/[\\/]/).pop().toLowerCase()
  if (name === 'chrome.exe') return 0
  if (name === 'msedge.exe') return 1
  if (name === 'brave.exe') return 2
  if (name === 'chromium.exe') return 3
  if (name === 'vivaldi.exe' || name === 'opera.exe') return 4
  return 9
}

/** 有界扫描：多根目录、深度 4–5、目录数上限，避免拖慢。 */
export function scan() {
  const roots = []
  const home = homedir()
  const env = process.env
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles || 'C:/Program Files'
    const pf86 = env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'
    const local = env.LOCALAPPDATA || ''
    const roaming = env.APPDATA || ''
    try { roots.push({ dir: join(dirname(process.execPath), 'resources'), depth: 5 }) } catch {}
    if (local) roots.push({ dir: local, depth: 4 })
    if (local) roots.push({ dir: join(local, 'Programs'), depth: 4 })
    if (roaming) roots.push({ dir: roaming, depth: 3 })
    roots.push({ dir: pf, depth: 3 })
    roots.push({ dir: pf86, depth: 3 })
    roots.push({ dir: join(home, 'Desktop'), depth: 5 })
  } else if (process.platform === 'darwin') {
    roots.push({ dir: '/Applications', depth: 4 })
    roots.push({ dir: join(home, 'Applications'), depth: 4 })
  } else {
    roots.push({ dir: '/usr/lib', depth: 3 })
    roots.push({ dir: '/opt', depth: 3 })
  }

  const hits = []
  const seen = new Set()
  let visited = 0
  for (const root of roots) {
    if (!root.dir) continue
    const queue = [{ dir: root.dir, depth: 0 }]
    while (queue.length) {
      const { dir, depth } = queue.shift()
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      if (++visited > 4000) return hits
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SCAN_SKIP_RE.test(entry.name)) continue
          if (depth + 1 <= root.depth) queue.push({ dir: full, depth: depth + 1 })
          continue
        }
        if (!CHROMIUM_EXE_RE.test(entry.name)) continue
        if (!looksLikeChromium(dir)) continue
        hits.push(full)
      }
    }
  }
  return hits.sort((a, b) => preference(a) - preference(b))
}

/** 返回一个可用的内核路径；找不到返回空串。 */
export function resolveChrome() {
  for (const candidate of candidates()) {
    try { if (existsSync(candidate)) return candidate } catch {}
  }
  const hits = scan()
  return hits.length ? hits[0] : ''
}
