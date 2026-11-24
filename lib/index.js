/**
 * dsh-fork-sync 宿主插件
 *  - 定时（默认 24h，可在 ~/.dsh/fork-sync/config.json 调）检查本地 fork 的上游更新
 *  - HTTP 接口：GET /fork-sync/report、POST /fork-sync/check、POST /fork-sync/apply
 *  - 报告写入 ~/.dsh/fork-sync/report.md
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statSync, writeFileSync } from 'node:fs'
import { CONFIG_PATH, REPORT_PATH, STATE_DIR, loadConfig } from './checker.js'

const STATE_PATH = join(STATE_DIR, 'state.json')
function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}
function writeState(patch) {
  const next = { ...readState(), ...patch }
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(next, null, 2) + '\n') } catch {}
  return next
}
function reportTime() {
  try { return statSync(REPORT_PATH).mtimeMs } catch { return 0 }
}
function pendingVersions() {
  try {
    const text = readFileSync(REPORT_PATH, 'utf8')
    const lines = text.split('\n').filter((l) => l.includes('→ 最新'))
    return lines.length
  } catch { return 0 }
}
function needsAck() {
  const st = readState()
  return pendingVersions() > 0 && (st.ackAt ?? 0) < reportTime()
}
function nextMondayHour(hour) {
  const now = new Date()
  const target = new Date(now)
  const delta = (8 - now.getDay()) % 7
  target.setDate(now.getDate() + delta)
  target.setHours(hour, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 7)
  return target
}

const HERE = dirname(fileURLToPath(import.meta.url))
export const name = 'dsh-fork-sync'
export const inject = ['webServer']

function runScript(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { try { child.kill() } catch {} }, 30 * 60 * 1000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

const isLoopback = (req) => {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

export function apply(ctx) {
  const log = (msg) => {
    try { ctx.logger?.info?.(msg) } catch { console.log(msg) }
  }

  if (ctx.webServer?.register) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/fork-sync',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'loopback only' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.replace(/^\/fork-sync/, '') || '/'
        const json = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method === 'GET' && route === '/status') {
            json(200, { ok: true, needsAck: needsAck(), pending: pendingVersions(), reportAt: reportTime(), ackAt: readState().ackAt ?? 0 })
            return
          }
          if (req.method === 'POST' && route === '/ack') {
            writeState({ ackAt: reportTime() })
            json(200, { ok: true })
            return
          }
          if (req.method === 'GET' && (route === '/report' || route === '/')) {
            const text = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, 'utf8') : '还没有报告，先 POST /fork-sync/check'
            res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
            res.end(text)
            return
          }
          if (req.method === 'POST' && route === '/check') {
            const r = await runScript('checker.js')
            json(200, { ok: r.code === 0, report: REPORT_PATH, tail: r.out.slice(-2000), error: r.err.slice(-2000) || undefined })
            return
          }
          if (req.method === 'POST' && route === '/conflicts') {
            const r = await runScript('conflicts.js')
            json(200, { ok: r.code === 0, dir: join(STATE_DIR, 'conflicts'), tail: r.out.slice(-2000), error: r.err.slice(-2000) || undefined })
            return
          }
          if (req.method === 'POST' && route === '/apply') {
            const cfg = loadConfig()
            if (!cfg.autoMerge) {
              json(409, { ok: false, error: 'config.autoMerge 为 false，先在 ~/.dsh/fork-sync/config.json 里打开' })
              return
            }
            const r = await runScript('checker.js', ['--apply'])
            json(200, { ok: r.code === 0, report: REPORT_PATH, tail: r.out.slice(-2000), error: r.err.slice(-2000) || undefined })
            return
          }
          json(404, { ok: false, error: `未知接口 ${req.method} ${route}` })
        } catch (error) {
          json(500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  }

  const cfg = loadConfig()
  const hour = Number(cfg.schedule?.hour) ?? 9
  ctx.effect(() => {
    let weekTimer = null
    function scheduleNext() {
      const next = nextMondayHour(hour)
      weekTimer = setTimeout(tick, Math.max(60_000, next.getTime() - Date.now()))
      weekTimer.unref?.()
      log(`[fork-sync] 下次检查：${next.toLocaleString('zh-CN')}`)
    }
    function tick() {
      runScript('checker.js')
        .then((r) => {
          writeState({ lastCheck: Date.now() })
          log(`[fork-sync] 检查完成 code=${r.code}，待确认：${needsAck()}`)
        })
        .catch((error) => log(`[fork-sync] 检查失败：${String(error)}`))
        .finally(scheduleNext)
    }
    const st = readState()
    const week = 7 * 24 * 3600 * 1000
    if (!st.lastCheck || Date.now() - st.lastCheck > week) {
      weekTimer = setTimeout(tick, 60 * 1000)
      weekTimer.unref?.()
    } else {
      scheduleNext()
    }
    return () => { if (weekTimer) clearTimeout(weekTimer) }
  })
}
