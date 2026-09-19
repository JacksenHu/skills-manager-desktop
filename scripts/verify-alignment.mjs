#!/usr/bin/env node
/**
 * P3 对齐验收：Node 状态机（src/main/services/junction-state.ts）必须与
 * agent-skills-shared/scripts/verify.ps1 的输出逐条对齐。
 *
 * 方法：
 *   1. 真跑 verify.ps1（powershell.exe 子进程），捕获逐行输出与退出码
 *   2. 用 esbuild 把 junction-state.ts 打成临时 ESM bundle（验证的就是真实 TS 模块）
 *   3. Node 端按同一 config（Sort-Object Path -Unique 同序）逐条判定
 *   4. 逐行比对：判定类别、[OK] 行的 SKILL.md 数、目标（语义相等）、
 *      冲突警告的组与路径、总结行、退出码 == failCount
 *
 * 全对 exit 0；任何一条不一致 exit 1 并打印差异。
 *
 * 用法：node scripts/verify-alignment.mjs [--ps <verify.ps1>] [--config <agents.json>]
 */
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PS_PROJECT = resolve(ROOT, '..', 'agent-skills-shared')

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : fallback
}
const VERIFY_PS1 = argOf('--ps', join(PS_PROJECT, 'scripts', 'verify.ps1'))
const CONFIG_JSON = argOf('--config', join(PS_PROJECT, 'config', 'agents.json'))

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

// ---------- 1. esbuild 打包真实 TS 状态机 ----------
const tmp = mkdtempSync(join(tmpdir(), 'p3-align-'))
const bundleJs = join(tmp, 'junction-state.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src', 'main', 'services', 'junction-state.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundleJs,
  alias: { '@shared': join(ROOT, 'src', 'shared') },
  logLevel: 'silent'
})
const sm = await import(pathToFileURL(bundleJs).href)

// ---------- 2. 读 config，复刻 verify.ps1 的路径排序（Sort-Object Path -Unique） ----------
const config = JSON.parse(readFileSync(CONFIG_JSON, 'utf8'))
const sharedRoot = config.sharedRoot
const agents = Object.entries(config.agents)
  .map(([name, path]) => ({ name, path }))
  .sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
  .filter((a, i, arr) => i === 0 || a.path !== arr[i - 1].path)

// ---------- 3. Node 端逐条判定 ----------
const groups = sm.loadSameSourceGroups()
const nodeEntries = agents.map((a) => {
  const r = sm.classifyJunction(a.path, sharedRoot, groups)
  return { ...a, ...r }
})
const nodeConflicts = sm.detectSameSourceConflicts(
  agents.map((a) => a.path),
  groups
)

// ---------- 4. 真跑 verify.ps1 ----------
const ps = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${VERIFY_PS1}'; exit $LASTEXITCODE`
  ],
  { encoding: 'utf8' }
)
const psOut = (ps.stdout || '') + (ps.stderr || '')
const psLines = psOut.split(/\r?\n/)
const psExit = ps.status ?? -1

console.log('='.repeat(64))
console.log('P3 对齐验收：junction-state.ts  ⇄  verify.ps1')
console.log(`verify.ps1: ${VERIFY_PS1}`)
console.log(`config    : ${CONFIG_JSON}`)
console.log(`PS 退出码 : ${psExit}`)
console.log('='.repeat(64))

// ---------- 5. 解析 verify.ps1 输出 ----------
// 行文案严格按 verify.ps1 的 -f 格式串写正则
const RE = {
  ok: /^\[OK\]\s+(.+?)\s*->\s*(.+?)（(\d+) 个 SKILL\.md）\s*$/,
  missing: /^\[FAIL\]\s+(.+?)\s+目录不存在:\s*(.+?)\s*$/,
  notLink: /^\[FAIL\]\s+(.+?)\s+不是联接（是真实目录？）:\s*(.+?)\s*$/,
  wrongTarget: /^\[FAIL\]\s+(.+?)\s+指向错误目标:\s*(.+?)\s*$/,
  mergedEmpty: /^\[归并·空\]\s+(.+?)\s+空目录（已归并，软件不再重复加载）:\s*(.+?)\s*$/,
  conflictHead: /^\s*可能被同一软件同时读取：(.+?)\s*$/,
  conflictPath: /^\s*·\s*(.+?)\s*$/,
  allPass: /^全部通过/,
  failSummary: /^存在 (\d+) 项异常/
}

const psEntries = []
const psConflicts = []
let psFailCountFromSummary = null
let currentConflict = null
let unparsed = []

for (const line of psLines) {
  let m
  if ((m = line.match(RE.ok))) {
    psEntries.push({ kind: 'ok', name: m[1].trim(), target: m[2].trim(), count: Number(m[3]) })
  } else if ((m = line.match(RE.missing))) {
    psEntries.push({ kind: 'fail-missing', name: m[1].trim(), path: m[2].trim() })
  } else if ((m = line.match(RE.notLink))) {
    psEntries.push({ kind: 'fail-not-link', name: m[1].trim(), path: m[2].trim() })
  } else if ((m = line.match(RE.wrongTarget))) {
    psEntries.push({ kind: 'fail-wrong-target', name: m[1].trim(), target: m[2].trim() })
  } else if ((m = line.match(RE.mergedEmpty))) {
    psEntries.push({ kind: 'merged-empty', name: m[1].trim(), path: m[2].trim() })
  } else if ((m = line.match(RE.conflictHead))) {
    currentConflict = { name: m[1].trim(), paths: [] }
    psConflicts.push(currentConflict)
  } else if (currentConflict && (m = line.match(RE.conflictPath))) {
    currentConflict.paths.push(m[1].trim())
  } else if ((m = line.match(RE.failSummary))) {
    psFailCountFromSummary = Number(m[1])
  } else if (RE.allPass.test(line)) {
    psFailCountFromSummary = 0
  } else if (line.trim() && !/^[═=╔╗║╚╝]|共享技能库|根治方法|验证结果|这些目录|建议：|（例：/.test(line)) {
    unparsed.push(line)
  }
}

// ---------- 6. 逐条比对（按 name 配对，不依赖两侧排序一致） ----------
console.log(`\n◆ 逐条状态比对（PS ${psEntries.length} 行 vs Node ${nodeEntries.length} 行）`)
check('行数一致', psEntries.length === nodeEntries.length, `PS=${psEntries.length} Node=${nodeEntries.length}`)

const norm = (s) => String(s || '').replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()

const nodeByName = new Map()
for (const e of nodeEntries) {
  if (!nodeByName.has(e.name)) nodeByName.set(e.name, [])
  nodeByName.get(e.name).push(e)
}

for (const p of psEntries) {
  const list = nodeByName.get(p.name)
  const j = list && list.length ? list.shift() : null
  if (!j) {
    check(`${p.name}`, false, `PS 有 [${p.kind}] 行，但 Node 侧没有同名条目`)
    continue
  }
  const label = `${p.name}  [${p.kind} ⇄ ${j.verdict}]`
  let detail = ''
  let okKind = p.kind === j.verdict
  if (!okKind) detail = `判定不同: PS=${p.kind} Node=${j.verdict} (path=${j.path})`
  if (okKind && p.kind === 'ok') {
    if (p.count !== j.skillCount) {
      okKind = false
      detail = `SKILL.md 数不同: PS=${p.count} Node=${j.skillCount}`
    } else if (norm(p.target) !== norm(j.target)) {
      okKind = false
      detail = `目标不同: PS="${p.target}" Node="${j.target}"`
    } else {
      detail = `target=${p.target}, ${p.count} 个 SKILL.md`
    }
  }
  check(label, okKind, detail)
}
for (const [name, list] of nodeByName) {
  for (const j of list) check(`${name}`, false, `Node 判定 [${j.verdict}] 但 PS 输出中没有该条目`)
}

console.log(`\n◆ 重复入口（同源多根）警告比对`)
check(
  '冲突组一致',
  JSON.stringify(psConflicts.map((c) => ({ name: c.name, paths: c.paths.sort() }))) ===
    JSON.stringify(
      nodeConflicts.map((c) => ({ name: c.name, paths: [...c.paths].sort() }))
    ),
  `PS=${JSON.stringify(psConflicts)} Node=${JSON.stringify(nodeConflicts)}`
)

console.log(`\n◆ 总结与退出码`)
const nodeFailCount = nodeEntries.filter((e) =>
  ['fail-missing', 'fail-not-link', 'fail-wrong-target'].includes(e.verdict)
).length
check('总结行 failCount 一致', psFailCountFromSummary === nodeFailCount, `PS=${psFailCountFromSummary} Node=${nodeFailCount}`)
check('进程退出码 == failCount', psExit === nodeFailCount, `exit=${psExit} failCount=${nodeFailCount}`)
check('没有未识别的输出行', unparsed.length === 0, unparsed.map((l) => '  ? ' + l).join('\n'))

rmSync(tmp, { recursive: true, force: true })

console.log('\n' + '='.repeat(64))
if (failures === 0) {
  console.log(`P3 对齐验收：全部通过 ✅（${nodeEntries.length} 条逐条对齐 + 冲突警告 + 总结 + 退出码）`)
  process.exit(0)
} else {
  console.log(`P3 对齐验收：${failures} 处不一致 ❌`)
  process.exit(1)
}
