import { existsSync, readdirSync, readlinkSync, lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'
import sameSourceGroupsJson from '@shared/data/same-source-groups.json'

/**
 * 与 PowerShell 版 verify.ps1 逐条对齐的联接状态机（只读，不改任何东西）。
 *
 * verify.ps1（agent-skills-shared/scripts/verify.ps1）对每个技能根的判定顺序：
 *   1. Test-Path 失败                        -> [FAIL] 目录不存在            (fail-missing)
 *   2. 是 Junction 且 target == sharedRoot   -> [OK]  （N 个 SKILL.md）      (ok)
 *   3. 是 Junction 但 target != sharedRoot   -> [FAIL] 指向错误目标          (fail-wrong-target)
 *   4. 非 Junction、空目录、命中同源组        -> [归并·空]（通过，不算失败）   (merged-empty)
 *   5. 其余非 Junction                       -> [FAIL] 不是联接（是真实目录？）(fail-not-link)
 *
 * 对齐细节（都是实测/源码确认过的语义）：
 * - PowerShell 的 -ne 字符串比较大小写不敏感 -> 目标比较统一小写。
 * - PS 5.1 Get-Item .Target / Node readlinkSync 都返回不带 \??\ 前缀的路径，
 *   但保险起见 normalize 时剥掉 \\?\ 与 \??\ 前缀。
 * - 「空目录」按 Get-ChildItem -Force 口径：含隐藏条目。readdirSync 天然返回隐藏条目，一致。
 * - 空目录还必须命中 same-source-group 才算「归并·空」；不命中组的空目录按
 *   verify.ps1 一样报 [FAIL] 不是联接。
 * - 已知偏差：Node 无法纯 JS 区分 Junction 与目录符号链接（PS 只认 Junction）。
 *   本机与目标场景全部使用 Junction，对齐验收覆盖的就是这个场景。
 */

export interface SameSourceGroup {
  name: string
  patterns: string[]
}

/** verify.ps1 的五种逐条判定 */
export type VerifyVerdict =
  | 'ok'
  | 'fail-missing'
  | 'fail-not-link'
  | 'fail-wrong-target'
  | 'merged-empty'

export interface ClassifyResult {
  verdict: VerifyVerdict
  /** 联接目标原文（ok / fail-wrong-target 时有值） */
  target?: string
  /** ok 时可见的 SKILL.md 数量（与 verify.ps1 [OK] 行的数字同口径） */
  skillCount: number
  /** merged-empty 时命中的同源组名 */
  matchedGroup?: string
}

export function loadSameSourceGroups(): SameSourceGroup[] {
  return sameSourceGroupsJson.groups as SameSourceGroup[]
}

/**
 * PowerShell -like 的子集实现：`*` 任意串、`?` 单个字符，其余按字面量。
 * PS 的 `[seq]` 字符集语法在 same-source-groups.json 的 pattern 数据里没用到，
 * 这里当作字面量处理（有注释声明，属已知收窄）。
 */
export function likeMatch(input: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regex}$`, 'i').test(input)
}

function normalizeTarget(p: string): string {
  return p
    .replace(/^\\\\\?\\/, '')
    .replace(/^\\\?\?\\/, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

/** 命中任一同源组 pattern 则返回该组（verify.ps1 的 Test-SameSourcePattern 语义） */
export function matchSameSourceGroup(
  path: string,
  groups: SameSourceGroup[]
): SameSourceGroup | undefined {
  const lower = path.toLowerCase()
  return groups.find((g) => g.patterns.some((p) => likeMatch(lower, p.toLowerCase())))
}

/**
 * 递归统计可见 SKILL.md。
 * 与 PS 5.1 `Get-ChildItem -Recurse -File -Filter SKILL.md` 同口径：
 * 跟随子目录里的 junction/symlink（5.1 会跟随），用真实路径去重防环。
 * verify.ps1 无深度限制，这里同样不限，只防环。
 */
export function countSkillFilesVisible(root: string): number {
  const visited = new Set<string>()
  let total = 0

  const walk = (dir: string): void => {
    let real: string
    try {
      // 用设备号 + inode + 路径组合做防环键（Windows 上 statSync 的 ino 对 NTFS 稳定）
      const st = statSync(dir)
      real = `${st.dev}:${st.ino}:${dir.toLowerCase()}`
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        total++
      }
    }
  }

  walk(root)
  return total
}

/** 状态机主入口：单条路径的 verify.ps1 判定 */
export function classifyJunction(
  path: string,
  sharedRoot: string,
  groups: SameSourceGroup[]
): ClassifyResult {
  // verify.ps1 第 1 步：Test-Path（跟随链接；悬空联接等同不存在）
  if (!existsSync(path)) return { verdict: 'fail-missing', skillCount: 0 }

  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { verdict: 'fail-missing', skillCount: 0 }
  }

  // Junction 在 Node 里表现为符号链接
  if (stat.isSymbolicLink()) {
    let target = ''
    try {
      target = readlinkSync(path)
    } catch {
      target = ''
    }
    if (normalizeTarget(target) === normalizeTarget(sharedRoot)) {
      return { verdict: 'ok', target, skillCount: countSkillFilesVisible(path) }
    }
    return { verdict: 'fail-wrong-target', target, skillCount: 0 }
  }

  if (!stat.isDirectory()) {
    // verify.ps1：非目录的普通文件没有「联接」可言 -> 不是联接
    return { verdict: 'fail-not-link', skillCount: 0 }
  }

  let entries: string[] = []
  try {
    entries = readdirSync(path)
  } catch {
    return { verdict: 'fail-missing', skillCount: 0 }
  }

  if (entries.length === 0) {
    const group = matchSameSourceGroup(path, groups)
    if (group) return { verdict: 'merged-empty', skillCount: 0, matchedGroup: group.name }
  }

  return { verdict: 'fail-not-link', skillCount: 0 }
}

/** verify.ps1 的重复入口检测（非阻塞警告）：复刻其 conflictPaths 过滤逻辑 */
export function detectSameSourceConflicts(
  paths: string[],
  groups: SameSourceGroup[]
): { name: string; paths: string[] }[] {
  const conflictPaths = paths.filter((p) => {
    if (!existsSync(p)) return true // 缺失仍报（verify.ps1 原注释：前面已 FAIL）
    const stat = lstatSync(p)
    if (stat.isSymbolicLink()) return true
    try {
      if (readdirSync(p).length === 0) {
        return !matchSameSourceGroup(p, groups) // 空目录 + 命中组 = 已归并，排除
      }
    } catch {
      return true
    }
    return true
  })

  const conflicts: { name: string; paths: string[] }[] = []
  for (const g of groups) {
    const hits = conflictPaths.filter((p) =>
      g.patterns.some((pat) => likeMatch(p.toLowerCase(), pat.toLowerCase()))
    )
    if (hits.length >= 2) conflicts.push({ name: g.name, paths: hits })
  }
  return conflicts
}

/**
 * 重复加载风险检测 V3（UI 用；PS 对齐验收仍用上面的 V1）。
 *
 * 用户语义（0.2.7 重构）：只有"绝对根"（路径的最终解析目标）相同时才归为重复——
 * - 联接指向同一目标（如多个技能根联接都指向共享库）→ 报（归并功能针对的场景）
 * - 不同软件的不同官方预设路径（.claude\skills 与 .cursor\skills 等）→ 永不报
 * same-source-groups 组概念不再参与重复判定。
 */
export interface DuplicateLoadEntry {
  path: string
  /** 联接目标（state 为 active/other-link 时由 classifyJunction 提供） */
  target?: string
  state: string
}

export function detectDuplicateLoadRisks(entries: DuplicateLoadEntry[]): { name: string; paths: string[] }[] {
  // 绝对根：active 联接取目标；real-dir 取路径本身。其余状态（missing/empty/
  // merged-empty/not-dir/other-link/wrong-target）不参与——它们要么无实义，要么
  // 本身是需人工处理的异常态。
  const clusters = new Map<string, string[]>()
  for (const e of entries) {
    let root: string | null = null
    if (e.state === 'active' && e.target) root = normalizeTarget(e.target)
    else if (e.state === 'real-dir') root = normalizeTarget(e.path)
    if (!root) continue
    const list = clusters.get(root) ?? []
    list.push(e.path)
    clusters.set(root, list)
  }
  const conflicts: { name: string; paths: string[] }[] = []
  for (const [root, paths] of clusters) {
    if (paths.length >= 2) conflicts.push({ name: root, paths })
  }
  return conflicts
}

/** verify.ps1 输出行同款文案（对齐脚本用它做逐字比对） */
export function formatVerifyLine(entry: ClassifyResult & { name: string; path: string }): string {
  const name = entry.name
  switch (entry.verdict) {
    case 'ok':
      return `[OK]   ${name} -> ${entry.target}（${entry.skillCount} 个 SKILL.md）`
    case 'fail-missing':
      return `[FAIL] ${name} 目录不存在: ${entry.path}`
    case 'fail-not-link':
      return `[FAIL] ${name} 不是联接（是真实目录？）: ${entry.path}`
    case 'fail-wrong-target':
      return `[FAIL] ${name} 指向错误目标: ${entry.target}`
    case 'merged-empty':
      return `[归并·空] ${name} 空目录（已归并，软件不再重复加载）: ${entry.path}`
  }
}
