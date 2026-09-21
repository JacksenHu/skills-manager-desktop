import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type {
  AppConfig,
  CreatePlan,
  CreateScenario,
  JunctionState,
  MergePlan,
  MergePlanHit,
  SameSourceConflict
} from '@shared/types'
import {
  classifyJunction,
  detectSameSourceConflicts,
  likeMatch,
  loadSameSourceGroups
} from './junction-state'
import { assertRealDir, isJunction, junctionTarget } from './fs-guards'
import { createBackup } from './backup'

export { assertRealDir } from './fs-guards'
import { toJunctionState } from './state-map'

/**
 * P4 联接写：建 / 拆 / 归并。语义逐条对齐 PowerShell 版三个脚本：
 * - 建   add-agent.ps1（含内容迁移 + SHA256 去重 + 冲突阻塞）
 * - 拆   remove-agent.ps1（只拆「门」，共享库数据原封不动）
 * - 归并 merge-agent-roots.ps1（组内拆联接后重建空目录，消除重复加载）
 *
 * 安全约定（README）：
 * - 拆联接一律 fs.rmdirSync(path) —— 只删重解析点，不穿透共享库
 * - 任何递归删除前必须过 assertRealDir 守卫（目标绝不能是联接/符号链接），
 *   该删除仅用于「接入时迁移内容的去重副本」，删除对象永远是真实目录
 */

export interface JunctionOpResult {
  logs: string[]
}

/**
 * 目录内容指纹：相对路径（小写）+ 每文件 SHA256，排序后拼接。
 * 与 add-agent.ps1 的 Test-DirSame 同口径（相对路径 + 哈希逐项比较）。
 * 差异：不跟随子目录里的联接（PS 5.1 -Recurse 默认也不跟随），防环。
 */
function hashDir(root: string): string | null {
  const parts: string[] = []
  const walk = (dir: string, prefix: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      parts.push(`!E ${prefix}`)
      return
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}\\${e.name}` : e.name
      const full = join(dir, e.name)
      if (e.isSymbolicLink()) {
        // 联接按其目标字符串参与指纹，不深入
        parts.push(`L ${rel.toLowerCase()} ${junctionTarget(full).toLowerCase()}`)
      } else if (e.isDirectory()) {
        walk(full, rel)
      } else if (e.isFile()) {
        try {
          const h = createHash('sha256').update(readFileSync(full)).digest('hex')
          parts.push(`F ${rel.toLowerCase()} ${h}`)
        } catch {
          parts.push(`!R ${rel.toLowerCase()}`)
        }
      }
    }
  }
  walk(root, '')
  parts.sort()
  return parts.join('\n')
}

/** 两目录内容是否完全一致（Test-DirSame 语义；任一不可读视为不一致） */
function dirsSame(a: string, b: string): boolean {
  const ha = hashDir(a)
  const hb = hashDir(b)
  if (ha === null || hb === null) return false
  return ha === hb
}

/** 配置中已有技能根 + 新路径 的同源多根冲突（add-agent.ps1 预检同语义） */
function duplicateWarningsFor(path: string, config: AppConfig): SameSourceConflict[] {
  const groups = loadSameSourceGroups()
  const known = Object.values(config.agents).filter((p) => p.toLowerCase() !== path.toLowerCase())
  return detectSameSourceConflicts([...known, path], groups)
}

/** 单路径当前场景判定（接入预案第一步） */
function scenarioOf(path: string, sharedRoot: string): {
  scenario: CreateScenario
  target?: string
} {
  if (!existsSync(path)) return { scenario: 'missing' }
  if (isJunction(path)) {
    const target = junctionTarget(path)
    const same = target.replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '').toLowerCase() ===
      sharedRoot.toLowerCase()
    return same ? { scenario: 'already-active', target } : { scenario: 'wrong-target', target }
  }
  const st = lstatSync(path)
  if (!st.isDirectory()) return { scenario: 'not-dir' }
  return readdirSync(path).length === 0 ? { scenario: 'empty-dir' } : { scenario: 'real-dir' }
}

/** 接入预案（dry-run，不改任何东西） */
export function planCreate(key: string, path: string, config: AppConfig): CreatePlan {
  const sharedRoot = config.sharedRoot
  const { scenario, target } = scenarioOf(path, sharedRoot)

  const plan: CreatePlan = {
    key,
    path,
    sharedRoot,
    scenario,
    target,
    items: [],
    conflictCount: 0,
    duplicateWarnings: duplicateWarningsFor(path, config),
    blocked: false
  }

  if (scenario === 'wrong-target') {
    plan.blocked = true
    plan.blockedReason = `是联接但目标不是共享库: ${target ?? '—'}。请先手动处理，再重新接入。`
  } else if (scenario === 'not-dir') {
    plan.blocked = true
    plan.blockedReason = '该路径是文件不是目录，无法建立联接。'
  } else if (scenario === 'real-dir') {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name)
      const dest = join(sharedRoot, name)
      if (existsSync(dest)) {
        if (dirsSame(child, dest)) plan.items.push({ name, action: 'dedupe' })
        else {
          plan.items.push({ name, action: 'conflict' })
          plan.conflictCount++
        }
      } else {
        plan.items.push({ name, action: 'move' })
      }
    }
    if (plan.conflictCount > 0) {
      plan.blocked = true
      plan.blockedReason = `共享库已有 ${plan.conflictCount} 个同名但内容不同的技能，需人工决定保留哪份后再接入。`
    }
  }
  return plan
}

/** 接入执行（add-agent.ps1 全流程；配置写入由 IPC 层负责） */
export function createJunction(path: string, config: AppConfig): JunctionOpResult {
  const sharedRoot = config.sharedRoot
  const logs: string[] = []

  // 重新判定当前状态（不信任可能过期的预案）
  const { scenario, target } = scenarioOf(path, sharedRoot)
  logs.push(`接入 Agent: ${path}`)
  logs.push(`共享库:   ${sharedRoot}`)

  if (scenario === 'already-active') {
    logs.push(`[SKIP] 已是指向共享库的联接`)
    return { logs }
  }
  if (scenario === 'wrong-target') {
    throw new Error(`是联接但目标不是共享库: ${target}。请先手动处理。`)
  }
  if (scenario === 'not-dir') {
    throw new Error(`${path} 不是目录，已中止。`)
  }

  // 共享库不存在时创建
  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true })
    logs.push(`[OK] 已创建共享库: ${sharedRoot}`)
  }

  if (scenario === 'real-dir') {
    // 接入备份（默认开启，设置里可关）：迁移前把原技能根整目录留底；失败即中止接入
    const backupDir = createBackup(path, config)
    if (backupDir) logs.push(`备份原技能根 -> ${backupDir}（内容迁移前已留底）`)
    else logs.push('备份已关闭（设置→接入备份），跳过留底')

    const children = readdirSync(path).sort()
    logs.push(`迁移 ${children.length} 项已有内容到共享库…`)
    let conflicted = 0
    for (const name of children) {
      const child = join(path, name)
      const dest = join(sharedRoot, name)
      if (existsSync(dest)) {
        if (dirsSame(child, dest)) {
          assertRealDir(child)
          rmSync(child, { recursive: true })
          logs.push(`  [去重] ${name} 与共享库内容一致，移除冗余副本`)
        } else {
          logs.push(`  [冲突] 共享库已有同名「${name}」但内容不同；保留原处，请人工决定`)
          conflicted++
        }
        continue
      }
      moveChild(child, dest)
      logs.push(`  已迁移: ${name}`)
    }
    if (conflicted > 0) {
      throw new Error(`存在 ${conflicted} 项内容冲突（见日志），目录未清空，请人工处理后重试。`)
    }
    rmdirSync(path) // 内容已迁空；非空会自然抛错，属额外安全垫
    logs.push(`已删除空目录（内容已迁移）`)
  } else if (scenario === 'empty-dir') {
    rmdirSync(path)
  }

  // 建联接（父目录缺失先补；Node 的 junction 类型无需管理员权限）
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(sharedRoot, path, 'junction')

  // 验收：确为联接且指向共享库（大小写不敏感）
  if (!isJunction(path)) throw new Error(`[FAIL] 联接创建失败（不是联接），请检查路径与权限。`)
  const made = junctionTarget(path)
  if (made.toLowerCase() !== sharedRoot.toLowerCase()) {
    throw new Error(`[FAIL] 联接创建失败（目标不符: ${made}），请检查路径与权限。`)
  }
  logs.push(`[OK] 联接已建立: ${path} -> ${sharedRoot}`)
  logs.push(`提示：重启该 Agent 会话后生效。`)
  return { logs }
}

/** 单项迁移：同盘 rename 原子移动；跨盘复制后守卫删除 */
function moveChild(src: string, dest: string): void {
  try {
    renameSync(src, dest)
    return
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
  }
  assertRealDir(src)
  cpSync(src, dest, { recursive: true })
  rmSync(src, { recursive: true })
}

/** 拆除联接（remove-agent.ps1 语义：只拆「门」，数据保留） */
export function removeJunction(path: string): JunctionOpResult {
  const logs: string[] = [`Agent 根目录: ${path}`]
  if (!existsSync(path)) {
    logs.push(`[SKIP] 不存在，无需处理。`)
    return { logs }
  }
  if (!isJunction(path)) {
    logs.push(`[SKIP] 不是联接（真实目录？），无需拆除。`)
    return { logs }
  }
  const target = junctionTarget(path)
  logs.push(`联接目标: ${target}`)
  // 仅删除重解析点本身；绝不递归
  rmdirSync(path)
  if (existsSync(path)) {
    throw new Error(`[FAIL] 联接拆除失败（可能被占用）。共享库数据不受影响。`)
  }
  logs.push(`[OK] 联接已拆除: ${path}`)
  logs.push(`技能数据仍完整保留在共享库，可随时重新接入。`)
  return { logs }
}

/** 组内活跃根的归并预案（merge-agent-roots.ps1 的收集 + 推荐逻辑） */
export function buildMergePlans(config: AppConfig): MergePlan[] {
  const groups = loadSameSourceGroups()
  const entries = Object.entries(config.agents).map(([key, path]) => ({ key, path }))
  const plans: MergePlan[] = []

  for (const g of groups) {
    const hits = entries.filter((e) => g.patterns.some((p) => likeMatch(e.path, p)))
    if (hits.length < 2) continue

    const planHits: MergePlanHit[] = hits.map((h) => {
      const result = classifyJunction(h.path, config.sharedRoot, groups)
      const state: JunctionState = toJunctionState(result.verdict)
      // 反查：该根还会被哪些其他组读取
      const alsoReadBy = groups
        .filter((g2) => g2.name !== g.name && g2.patterns.some((p) => likeMatch(h.path, p)))
        .map((g2) => g2.name)
      return { path: h.path, state, recommended: false, alsoReadBy }
    })

    const activeCount = planHits.filter((h) => h.state === 'active').length
    if (activeCount <= 1) continue // 与 PS 一致：活跃根 <= 1 无需归并

    // 推荐保留：命中组数最多的路径（PS 的 score 逻辑，含当前组）
    let best = -1
    let bestIdx = 0
    for (let i = 0; i < planHits.length; i++) {
      const score = groups.filter((g2) =>
        g2.patterns.some((p) => likeMatch(planHits[i].path, p))
      ).length
      if (score > best) {
        best = score
        bestIdx = i
      }
    }
    planHits[bestIdx].recommended = true
    plans.push({ name: g.name, hits: planHits, keepPath: planHits[bestIdx].path })
  }
  return plans
}

/** 归并执行：保留 keepPath，其余活跃根拆联接后重建空目录 */
export function mergeGroup(groupName: string, keepPath: string, config: AppConfig): JunctionOpResult {
  const groups = loadSameSourceGroups()
  const group = groups.find((g) => g.name === groupName)
  if (!group) throw new Error(`找不到同源组「${groupName}」`)
  const keep = keepPath
  const logs: string[] = [`归并组: ${groupName}（保留: ${keep}）`]

  const hits = Object.values(config.agents).filter((p) => group.patterns.some((pat) => likeMatch(p, pat)))
  if (!hits.some((p) => p.toLowerCase() === keep.toLowerCase())) {
    throw new Error('保留路径不在该组内，拒绝执行。')
  }

  for (const root of hits) {
    if (root.toLowerCase() === keep.toLowerCase()) continue
    const result = classifyJunction(root, config.sharedRoot, groups)
    if (toJunctionState(result.verdict) !== 'active') continue // 只处理活跃根（与 PS 一致）

    logs.push(`归并: ${root}`)
    rmdirSync(root) // 拆联接：仅删重解析点，数据留在共享库
    if (existsSync(root)) {
      logs.push(`      [FAIL] 拆除失败（可能被占用），跳过该根。`)
      continue
    }
    mkdirSync(root, { recursive: true }) // 重建空目录，软件原路径继续存在
    logs.push(`      [OK] 已归并: ${root} -> 空目录（技能数据仍在 ${config.sharedRoot}）`)
  }
  logs.push(`[完成] ${groupName} 归并结束。请重启对应软件验证：重复项应消失。`)
  return { logs }
}
