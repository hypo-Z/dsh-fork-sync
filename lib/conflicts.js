/**
 * 冲突分析包：给 AI/人工决策用。
 * 用法：node lib/conflicts.js [包名...]（不传则处理所有有冲突的包）
 * 产出：~/.dsh/fork-sync/conflicts/<包>-<新版本>/SUMMARY.md 以及每个冲突文件的
 *   <文件>.ours.diff   （base → 本地，看我们改了什么）
 *   <文件>.theirs.diff （base → 上游，看上游改了什么）
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { STATE_DIR, checkPackage, fetchTarball, loadConfig } from './checker.js'

const wanted = process.argv.slice(2)
const cfg = loadConfig()
const targets = (cfg.packages ?? []).filter((p) => !wanted.length || wanted.includes(p.name))
const root = join(STATE_DIR, 'conflicts')
mkdirSync(root, { recursive: true })
const tmpRoot = join(tmpdir(), `dsh-fork-conflicts-${Date.now()}`)
mkdirSync(tmpRoot, { recursive: true })

const MAX_LINES = 500
function diff(pathA, pathB) {
  try {
    const out = execFileSync('diff', ['-u', pathA, pathB], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
    return out
  } catch (error) {
    const out = String(error.stdout ?? '')
    const lines = out.split('\n')
    return lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join('\n') + `\n…（截断，共 ${lines.length} 行）` : out
  }
}

for (const pkg of targets) {
  let result
  try {
    result = checkPackage(pkg, tmpRoot)
  } catch (error) {
    console.log(`${pkg.name}: 检查失败 ${String(error?.message ?? error)}`)
    continue
  }
  if (!result.rows || result.upToDate) continue
  const conflicts = result.rows.filter((r) => r.kind === 'conflict' || r.kind === 'meta')
  if (!conflicts.length) continue

  const baseDir = fetchTarball(pkg.name, result.local, tmpRoot)
  const newDir = fetchTarball(pkg.name, result.latest, tmpRoot)
  const outDir = join(root, `${pkg.name}-${result.latest}`)
  mkdirSync(outDir, { recursive: true })

  const lines = [
    `# ${pkg.name} 冲突分析：${result.local} → ${result.latest}`,
    '',
  ]
  // 本地相对基线改了哪些文件
  try {
    const stat = execFileSync('git', ['-C', pkg.dir, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim()
    lines.push(`本地 fork 最近提交：${stat}`, '')
  } catch {}

  for (const row of conflicts) {
    const rel = row.rel
    const ours = join(pkg.dir, rel)
    const base = join(baseDir, rel)
    const theirs = join(newDir, rel)
    if (!existsSync(ours) || !existsSync(base) || !existsSync(theirs)) {
      lines.push(`## ${rel}`, '', `（缺文件：ours=${existsSync(ours)} base=${existsSync(base)} theirs=${existsSync(theirs)}）`, '')
      continue
    }
    const oursDiff = diff(base, ours)
    const theirsDiff = diff(base, theirs)
    const safe = rel.replace(/[\\/]/g, '__')
    writeFileSync(join(outDir, `${safe}.ours.diff`), oursDiff)
    writeFileSync(join(outDir, `${safe}.theirs.diff`), theirsDiff)
    lines.push(`## ${rel}（${row.kind === 'meta' ? '需手工' : '冲突'}）`, '')
    lines.push(`- 我们的改动：${safe}.ours.diff（${oursDiff.split('\n').length} 行）`)
    lines.push(`- 上游的改动：${safe}.theirs.diff（${theirsDiff.split('\n').length} 行）`)
    lines.push('')
  }
  writeFileSync(join(outDir, 'SUMMARY.md'), lines.join('\n'))
  console.log(`${pkg.name}: ${conflicts.length} 个冲突 → ${outDir}/SUMMARY.md`)
}
