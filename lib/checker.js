/**
 * dsh-fork-sync 检查器：
 *  1. 读取 profile 里 link: 安装的本地插件
 *  2. 对比 npm 上的最新版本
 *  3. 下载「当前版本」(baseline) 和「最新版本」两个 tarball
 *  4. 按文件三向比较：上游改了我们没改 → 可安全合并；两边都改 → 冲突；只改了本地 → 保留
 *  5. --apply 时只覆盖「可安全合并 / 新增」的文件，冲突文件一律不动
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
export const PROFILE = join(HOME, '.dsh/profiles/desktop')
export const STATE_DIR = join(HOME, '.dsh/fork-sync')
export const CONFIG_PATH = join(STATE_DIR, 'config.json')
export const REPORT_PATH = join(STATE_DIR, 'report.md')

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])
const SKIP_EXT = new Set(['.log'])

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    const cfg = { intervalHours: 24, autoMerge: false, packages: discoverPackages() }
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
    return cfg
  }
}

/** 从 profile 的 link: 依赖里自动发现本地插件 */
export function discoverPackages() {
  const pkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  const out = []
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (typeof spec === 'string' && spec.startsWith('link:')) {
      out.push({ name, dir: spec.slice(5) })
    }
  }
  return out
}

function sha(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function listFiles(root, base = root) {
  const out = []
  if (!existsSync(root)) return out
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(root, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full))
  }
  return out
}

function npm(args) {
  return execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }).trim()
}

export function fetchTarball(name, version, destRoot) {
  mkdirSync(destRoot, { recursive: true })
  const out = npm(['pack', `${name}@${version}`, '--pack-destination', destRoot])
  const filename = out.split('\n').map((x) => x.trim()).filter(Boolean).pop()
  const src = join(destRoot, filename)
  const dir = join(destRoot, `${name.replace('/', '_')}-${version}`)
  mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xzf', src, '-C', dir, '--strip-components=1'], { stdio: 'ignore' })
  return dir
}

export function checkPackage(pkg, tmpRoot) {
  const forkPkgPath = join(pkg.dir, 'package.json')
  if (!existsSync(forkPkgPath)) return { name: pkg.name, error: '本地目录不存在或缺少 package.json' }
  const local = JSON.parse(readFileSync(forkPkgPath, 'utf8')).version
  let latest
  try {
    latest = npm(['view', pkg.name, 'version'])
  } catch (error) {
    return { name: pkg.name, local, skipped: 'npm 上查不到这个包（可能是自建插件）' }
  }
  if (latest === local) return { name: pkg.name, local, latest, upToDate: true }

  try {
    npm(['view', `${pkg.name}@${local}`, 'version'])
  } catch {
    return { name: pkg.name, local, latest, skipped: `本地版本 ${local} 在 npm 上不存在（未发布或已删除）` }
  }
  const baseDir = fetchTarball(pkg.name, local, tmpRoot)
  const newDir = fetchTarball(pkg.name, latest, tmpRoot)

  const newFiles = listFiles(newDir)
  const forkFiles = new Set(listFiles(pkg.dir))
  const rows = []
  for (const rel of newFiles) {
    if (SKIP_EXT.has(rel.slice(rel.lastIndexOf('.')))) continue
    const n = sha(join(newDir, rel))
    const f = sha(join(pkg.dir, rel))
    const b = sha(join(baseDir, rel))
    if (f === n) continue // 一致
    if (rel === 'package.json') { rows.push({ rel, kind: 'meta' }); continue }
    if (f === null) {
      rows.push({ rel, kind: 'added' }) // 上游新增文件
    } else if (b === f) {
      rows.push({ rel, kind: 'safe' }) // 上游改了，我们没改
    } else if (b === n) {
      rows.push({ rel, kind: 'local-only' }) // 只有我们改
    } else {
      rows.push({ rel, kind: 'conflict' }) // 两边都改
    }
  }
  // 上游删掉的文件
  for (const rel of forkFiles) {
    if (!newFiles.includes(rel)) {
      const b = sha(join(baseDir, rel))
      const f = sha(join(pkg.dir, rel))
      if (b === f) rows.push({ rel, kind: 'removed-upstream' })
    }
  }
  return { name: pkg.name, local, latest, rows }
}

export function applySafe(pkg, result, tmpRoot, cfg) {
  if (!result.rows) return 0
  const newDir = join(tmpRoot, `${pkg.name.replace('/', '_')}-${result.latest}`)
  // 包内有文本冲突时，代码文件不自动合并（新旧版本代码混用可能直接坏掉），
  // 只合并文档/资源等非代码文件；没有冲突时才按 safe/added 合并。
  const hasConflict = result.rows.some((r) => r.kind === 'conflict')
  const isCode = (rel) => /^(lib|src)\//.test(rel) || /\.(m?js|cjs|jsx|tsx?)$/.test(rel)
  let applied = 0
  for (const row of result.rows) {
    if (row.kind !== 'safe' && !(row.kind === 'added' && cfg.mergeAdded)) continue
    if (hasConflict && isCode(row.rel)) continue
    const src = join(newDir, row.rel)
    const dst = join(pkg.dir, row.rel)
    if (!existsSync(src)) continue
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    applied += 1
  }
  return applied
}

export function renderReport(results, applied = {}) {
  const lines = [`# dsh-fork-sync 报告`, ``, `生成时间：${new Date().toLocaleString('zh-CN')}`, ``]
  for (const r of results) {
    lines.push(`## ${r.name}`)
    if (r.error) { lines.push(`- ⚠ 错误：${r.error}`); lines.push(''); continue }
    if (r.skipped) { lines.push(`- 跳过：${r.skipped}`); lines.push(''); continue }
    if (r.upToDate) { lines.push(`- 已是最新（${r.local}）`); lines.push(''); continue }
    const count = (k) => r.rows.filter((x) => x.kind === k).length
    lines.push(`- 本地 ${r.local} → 最新 **${r.latest}**`)
    lines.push(`- 可安全合并：${count('safe')} 个文件；上游新增：${count('added')}；冲突：${count('conflict')}；仅本地修改：${count('local-only')}；上游删除：${count('removed-upstream')}；需手工：${count('meta')}`)
    if (applied[r.name] !== undefined) lines.push(`- 本次已合并：${applied[r.name]} 个文件`)
    for (const row of r.rows) {
      const tag = { safe: '可合并', added: '新增', conflict: '⚠ 冲突', 'local-only': '仅本地', 'removed-upstream': '上游删除', meta: '需手工' }[row.kind]
      lines.push(`  - [${tag}] ${row.rel}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function run({ apply = false } = {}) {
  const cfg = loadConfig()
  mkdirSync(STATE_DIR, { recursive: true })
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-fork-sync-'))
  const results = []
  const applied = {}
  try {
    for (const pkg of cfg.packages ?? []) {
      try {
        const r = checkPackage(pkg, tmpRoot)
        results.push(r)
        if (apply && r.rows && cfg.autoMerge) {
          applied[r.name] = applySafe(pkg, r, tmpRoot, cfg)
        }
      } catch (error) {
        results.push({ name: pkg.name, error: String(error?.message ?? error) })
      }
    }
    const report = renderReport(results, applied)
    writeFileSync(REPORT_PATH, report + '\n')
    return { results, applied, report }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// CLI：node lib/checker.js [--apply]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const apply = process.argv.includes('--apply')
  const { report, applied } = run({ apply })
  console.log(report)
  if (Object.keys(applied).length) console.log('\n已合并：', applied)
}
