/**
 * 三路合并辅助：node lib/merge.js <包名> <文件相对路径>
 * 产出：~/.dsh/fork-sync/merge/<包名>-<新版本>/<文件>.{ours,base,theirs,merged}
 *   ours   = 本地 fork 当前文件（含我们的补丁）
 *   base   = 本地版本在 npm 上的原始文件（无补丁）
 *   theirs = 上游最新版本的文件
 *   merged = git merge-file 的结果，冲突块用 <<<<<<< ======= >>>>>>> 标记
 * 合并满意后：cp merged 回 fork 里对应路径 → git commit → 重启 DSH
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { STATE_DIR, fetchTarball, loadConfig } from './checker.js'

const [name, rel] = process.argv.slice(2)
if (!name || !rel) {
  console.error('用法：node lib/merge.js <包名> <文件相对路径>，例如 node lib/merge.js dsh-dream-skin lib/client.js')
  process.exit(2)
}

const cfg = loadConfig()
const pkg = (cfg.packages ?? []).find((p) => p.name === name)
if (!pkg) { console.error(`配置里没有这个包：${name}`); process.exit(2) }

const localVersion = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')).version
const latest = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8' }).trim()
if (latest === localVersion) { console.error(`已经是最新（${localVersion}），无需合并`); process.exit(1) }

const tmpRoot = join(tmpdir(), `dsh-fork-merge-${Date.now()}`)
mkdirSync(tmpRoot, { recursive: true })
const baseDir = fetchTarball(name, localVersion, tmpRoot)
const newDir = fetchTarball(name, latest, tmpRoot)

const outRoot = join(STATE_DIR, 'merge', `${name}-${latest}`)
mkdirSync(dirname(join(outRoot, rel)), { recursive: true })
const ours = join(outRoot, `${rel}.ours`)
const base = join(outRoot, `${rel}.base`)
const theirs = join(outRoot, `${rel}.theirs`)
const merged = join(outRoot, `${rel}.merged`)
copyFileSync(join(pkg.dir, rel), ours)
copyFileSync(join(baseDir, rel), base)
copyFileSync(join(newDir, rel), theirs)

let code = 0
try {
  const result = execFileSync('git', ['merge-file', '-p', ours, base, theirs], { encoding: 'utf8' })
  writeFileSync(merged, result)
} catch (error) {
  code = error.status ?? 1
  writeFileSync(merged, String(error.stdout ?? ''))
}

console.log(`包：${name}   ${localVersion} → ${latest}`)
console.log(`文件：${rel}`)
console.log(`冲突块数量：${code > 1 ? code - 1 : 0}`)
console.log('')
console.log(`  ours   （本地含补丁）: ${ours}`)
console.log(`  base   （本地版本原始）: ${base}`)
console.log(`  theirs （上游最新）    : ${theirs}`)
console.log(`  merged （合并结果）    : ${merged}`)
console.log('')
console.log('打开 merged，处理 <<<<<<< / ======= / >>>>>>> 标记后：')
console.log(`  cp "${merged}" "${join(pkg.dir, rel)}"`)
console.log('  cd ' + pkg.dir + ' && git add -A && git commit -m "merge upstream ' + latest + '"')
console.log('  完整重启 DSH')
rmSync(tmpRoot, { recursive: true, force: true })
