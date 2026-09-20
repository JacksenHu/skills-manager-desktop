/**
 * 防漂移校验：反向解析 PowerShell 版源码里的三张"事实表"，与 src/shared/data/*.json 逐项比对。
 *
 * 背景：桌面程序在 Node 侧重新实现了逻辑，Agent 预设 / 9 大分类 / 8 个同源组这些"事实"
 * 会被复制到两个地方。谁先改了另一边没跟上，行为就会悄悄分叉。本脚本把这件事变成一次命令。
 * 例外：标了 desktopOnly 的预设项只存在于桌面版（PS 仓库没有），只做数量登记，不参与逐项比对。
 *
 * 用法：
 *   npm run check:tables
 *   SKILLS_PS_ROOT=D:\\path\\to\\agent-skills-shared node scripts/check-tables.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const DATA_DIR = join(PROJECT_ROOT, 'src', 'shared', 'data')

const PS_ROOT =
  process.env.SKILLS_PS_ROOT ||
  resolve(PROJECT_ROOT, '..', 'agent-skills-shared')

const ENV_MAP = {
  USERPROFILE: '%USERPROFILE%',
  LOCALAPPDATA: '%LOCALAPPDATA%',
  APPDATA: '%APPDATA%'
}

let failures = 0

function fail(msg) {
  failures++
  console.log(`  ✗ ${msg}`)
}

function pass(msg) {
  console.log(`  ✓ ${msg}`)
}

/** 从 PowerShell 源码里抠出 `= @( ... )` 数组块（按括号配平，忽略花括号） */
function extractArrayBlock(src, varName) {
  const at = src.indexOf(varName)
  if (at < 0) throw new Error(`源码里找不到变量 ${varName}`)
  const open = src.indexOf('@(', at)
  if (open < 0) throw new Error(`${varName} 后面没有 @(`)
  let i = open + 2
  let depth = 1
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    i++
  }
  if (depth !== 0) throw new Error(`${varName} 的数组块括号不配平`)
  return src.slice(open + 2, i - 1)
}

/** 'a', 'b', 'c' → ['a','b','c'] */
function parseQuotedList(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^['"]+/, '').replace(/['"]+$/, ''))
}

function readJson(name) {
  return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8'))
}

function readPs(relPath) {
  const full = join(PS_ROOT, relPath)
  if (!existsSync(full)) throw new Error(`找不到 PowerShell 源码：${full}`)
  return readFileSync(full, 'utf8')
}

// ---------------------------------------------------------------- 1. Agent 预设
function checkPresets() {
  console.log('\n[1/3] Agent 路径预设（23 对齐 + 1 桌面增强 + 1 动态）')
  const src = readPs(join('scripts', 'setup-wizard.ps1'))
  const block = extractArrayBlock(src, '$detectors = ')
  const re =
    /@\{\s*Key\s*=\s*'([^']+)'\s*;\s*Label\s*=\s*'([^']+)'\s*;\s*Path\s*=\s*\(Join-Path\s+\$env:(\w+)\s+'([^']+)'\)(?:\s*;\s*ProbePath\s*=\s*\(Join-Path\s+\$env:(\w+)\s+'([^']+)'\))?\s*\}/g

  const parsed = []
  let m
  while ((m = re.exec(block)) !== null) {
    const [, key, label, env1, rel1, env2, rel2] = m
    if (!ENV_MAP[env1]) throw new Error(`未识别的环境变量 $${env1}（key=${key}）`)
    parsed.push({
      key,
      label,
      path: `${ENV_MAP[env1]}\\${rel1}`,
      probePath: env2 && ENV_MAP[env2] ? `${ENV_MAP[env2]}\\${rel2}` : undefined
    })
  }

  const json = readJson('agent-presets.json')
  const staticJson = json.presets.filter((p) => !p.dynamic)
  // 桌面版增强项（desktopOnly）：PowerShell 仓库里没有，只做数量登记，不参与逐项比对
  const alignedJson = staticJson.filter((p) => !p.desktopOnly)
  const desktopOnly = staticJson.filter((p) => p.desktopOnly)

  if (parsed.length !== 23) fail(`源码解析到 ${parsed.length} 项，预期 23 项静态预设`)
  else pass(`源码解析到 23 项静态预设`)

  const expectedTotal = 23 + desktopOnly.length + 1
  if (json.presets.length !== expectedTotal) {
    fail(
      `JSON 共 ${json.presets.length} 项，预期 ${expectedTotal}（23 对齐 + ${desktopOnly.length} 桌面增强 + 1 Marvis 动态）`
    )
  } else {
    pass(
      `JSON 共 ${json.presets.length} 项（23 对齐 + ${desktopOnly.length} 桌面增强${desktopOnly.length ? `：${desktopOnly.map((p) => p.key).join('、')}` : ''} + 1 动态）`
    )
  }

  for (const p of desktopOnly) {
    if (!p.path || !p.probePath) fail(`[${p.key}] 桌面增强项必须写全 path / probePath`)
  }

  if (parsed.length !== alignedJson.length) {
    fail(`数量对不上：源码 ${parsed.length} vs JSON 对齐项 ${alignedJson.length}`)
    return
  }

  for (let i = 0; i < parsed.length; i++) {
    const a = parsed[i]
    const b = alignedJson[i]
    if (a.key !== b.key) fail(`第 ${i + 1} 项 key 不同：源码 ${a.key} vs JSON ${b.key}`)
    else if (a.label !== b.label) fail(`[${a.key}] label 不同：源码 ${a.label} vs JSON ${b.label}`)
    else if (a.path !== b.path) fail(`[${a.key}] path 不同：\n      源码 ${a.path}\n      JSON ${b.path}`)
    else if ((a.probePath ?? '') !== (b.probePath ?? ''))
      fail(`[${a.key}] probePath 不同：源码 ${a.probePath} vs JSON ${b.probePath}`)
  }
  if (failures === 0) pass('逐项比对一致')
}

// ---------------------------------------------------------------- 2. 分类词典
function parseCategories(src) {
  const block = extractArrayBlock(src, '$script:CategoryDefs')
  const re = /@\{\s*Name\s*=\s*'([^']+)'\s*;\s*Keywords\s*=\s*@\(([^)]*)\)\s*\}/g
  const out = []
  let m
  while ((m = re.exec(block)) !== null) {
    out.push({ name: m[1], keywords: parseQuotedList(m[2]) })
  }
  return out
}

function checkCategories() {
  console.log('\n[2/3] 9 大分类关键词词典')
  const fromWizard = parseCategories(readPs(join('scripts', 'setup-wizard.ps1')))
  const fromRouter = parseCategories(readPs(join('scripts', 'generate-router-skill.ps1')))
  const json = readJson('category-dict.json')

  if (fromWizard.length !== 9) fail(`setup-wizard 解析到 ${fromWizard.length} 个分类，预期 9`)
  if (fromRouter.length !== 9) fail(`generate-router 解析到 ${fromRouter.length} 个分类，预期 9`)

  // 两份 PowerShell 副本必须彼此一致（它们自己也可能漂移）
  const w = JSON.stringify(fromWizard)
  const r = JSON.stringify(fromRouter)
  if (w !== r) fail('PowerShell 两份分类词典副本已经不一致（setup-wizard vs generate-router）')
  else pass('PowerShell 两份副本彼此一致')

  if (json.categories.length !== 9) fail(`JSON 有 ${json.categories.length} 个分类，预期 9`)

  const j = JSON.stringify(json.categories.map((c) => ({ name: c.name, keywords: c.keywords })))
  if (j !== w) {
    fail('JSON 与 PowerShell 源码的分类词典不一致')
    for (let i = 0; i < Math.max(fromWizard.length, json.categories.length); i++) {
      const a = fromWizard[i]
      const b = json.categories[i]
      if (!a || !b) {
        fail(`第 ${i + 1} 项缺失：${a ? `JSON 缺 ${a.name}` : `源码缺 ${b?.name}`}`)
        continue
      }
      if (a.name !== b.name) fail(`第 ${i + 1} 项分类名不同：源码 ${a.name} vs JSON ${b.name}`)
      else if (JSON.stringify(a.keywords) !== JSON.stringify(b.keywords)) {
        const onlySrc = a.keywords.filter((k) => !b.keywords.includes(k))
        const onlyJson = b.keywords.filter((k) => !a.keywords.includes(k))
        fail(`[${a.name}] 关键词不同：源码独有 ${JSON.stringify(onlySrc)}；JSON 独有 ${JSON.stringify(onlyJson)}`)
      }
    }
  } else {
    const total = json.categories.reduce((n, c) => n + c.keywords.length, 0)
    pass(`与源码逐项一致（9 个分类 / ${total} 个关键词）`)
  }
}

// ---------------------------------------------------------------- 3. 同源组
function checkGroups() {
  console.log('\n[3/3] 8 个同源多根组')
  const src = readPs(join('scripts', 'lib', 'duplicate-guard.ps1'))
  const block = extractArrayBlock(src, '$script:SameSourceGroups')
  const re = /@\{\s*Name\s*=\s*'([^']+)'\s*;\s*Patterns\s*=\s*@\(([^)]*)\)\s*\}/g
  const parsed = []
  let m
  while ((m = re.exec(block)) !== null) {
    parsed.push({ name: m[1], patterns: parseQuotedList(m[2]) })
  }

  const json = readJson('same-source-groups.json')
  if (parsed.length !== 8) fail(`源码解析到 ${parsed.length} 组，预期 8`)
  else pass(`源码解析到 8 组`)
  if (json.groups.length !== 8) fail(`JSON 有 ${json.groups.length} 组，预期 8`)

  if (JSON.stringify(parsed) !== JSON.stringify(json.groups.map((g) => ({ name: g.name, patterns: g.patterns })))) {
    fail('JSON 与源码的同源组不一致')
    for (let i = 0; i < Math.max(parsed.length, json.groups.length); i++) {
      const a = parsed[i]
      const b = json.groups[i]
      if (!a || !b) {
        fail(`第 ${i + 1} 组缺失`)
        continue
      }
      if (a.name !== b.name) fail(`第 ${i + 1} 组名不同：源码 ${a.name} vs JSON ${b.name}`)
      else if (JSON.stringify(a.patterns) !== JSON.stringify(b.patterns))
        fail(`[${a.name}] patterns 不同：\n      源码 ${JSON.stringify(a.patterns)}\n      JSON ${JSON.stringify(b.patterns)}`)
    }
  } else {
    const total = json.groups.reduce((n, g) => n + g.patterns.length, 0)
    pass(`与源码逐项一致（8 组 / ${total} 条模式）`)
  }
}

// ---------------------------------------------------------------- main
console.log(`PowerShell 源码根目录：${PS_ROOT}`)
try {
  checkPresets()
  checkCategories()
  checkGroups()
} catch (e) {
  fail(`解析失败：${e instanceof Error ? e.message : String(e)}`)
}

console.log('')
if (failures === 0) {
  console.log('✅ 三张事实表与 PowerShell 源码完全一致')
  process.exit(0)
} else {
  console.log(`❌ 发现 ${failures} 处不一致，请同步 src/shared/data/*.json 或 PowerShell 源码`)
  process.exit(1)
}
