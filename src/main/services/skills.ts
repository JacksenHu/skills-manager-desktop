import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import extractZip from 'extract-zip'
import type { AppConfig, OpResult, RepoSearchResult, RouterTarget, SkillInfo } from '@shared/types'
import categoryDictJson from '@shared/data/category-dict.json'
import { assertRealDir } from './junction-write'
import { classifyJunction, loadSameSourceGroups } from './junction-state'
import { AGENT_PRESETS, expandPath } from './detect'
import { httpGet, httpGetJson, httpGetResponse, cjkRatio, translateDescription } from './translate'

/**
 * P5 技能库：列表 / 分类 / 安装 / 移除 / 翻译简介 / 生成路由。
 * 语义对齐 PowerShell 版：install-skill.ps1 / translate-skill-intro.ps1 /
 * generate-router-skill.ps1 / lib/translate.ps1。
 *
 * 安全约定：任何递归删除前必须过 assertRealDir（junction-write 导出的统一守卫）；
 * 删除对象只允许是共享库里的真实技能目录。
 *
 * 路由技能（与 PS 版的关键差异，0.3.0 修正）：
 * PS 版把 router-guide 生成到共享库根，而共享库不是任何 Agent 的加载目录，
 * 结果「技能库里看得见、会话里调不到」。桌面版改为：写到各 Agent 技能根
 * （真实加载位置），并只索引该根下**实际可见**的技能；目录名与 frontmatter
 * name 统一为 skill-router。
 */

// ---------- 分类词典（三张事实表之一，check:tables 防漂移） ----------

interface CategoryDef {
  name: string
  keywords: string[]
}

const CATEGORY_DEFS = categoryDictJson.categories as CategoryDef[]
const CATEGORY_ORDER = categoryDictJson.displayOrder as string[]
const UNCATEGORIZED = categoryDictJson.uncategorized as string

/** 中文关键词子串包含；英文关键词词边界正则（category-dict.json matchRule） */
function hitKeyword(text: string, keyword: string): boolean {
  if (/^[\u4e00-\u9fff]/.test(keyword)) return text.includes(keyword)
  return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)
}

/** 分类判定：frontmatter 的 category/type/tags 先行（精确名 → 关键词），再按 名称+简介 关键词 */
export function classifySkill(name: string, intro: string, frontmatter?: Record<string, string>): string {
  if (frontmatter) {
    for (const field of ['category', 'type', 'tags']) {
      const v = frontmatter[field]?.toLowerCase()
      if (!v) continue
      for (const c of CATEGORY_DEFS) {
        if (v === c.name.toLowerCase()) return c.name
      }
      for (const c of CATEGORY_DEFS) {
        if (c.keywords.some((k) => hitKeyword(v, k))) return c.name
      }
    }
  }
  const text = `${name} ${intro}`.toLowerCase()
  for (const c of CATEGORY_DEFS) {
    if (c.keywords.some((k) => hitKeyword(text, k))) return c.name
  }
  return UNCATEGORIZED
}

// ---------- frontmatter 解析（PS Read-SkillFrontmatter 同口径：单行 / 缩进续行 / 折叠块） ----------

export function readFrontmatter(skillMdPath: string): Record<string, string> {
  const meta: Record<string, string> = {}
  let lines: string[]
  try {
    lines = readFileSync(skillMdPath, 'utf8').split(/\r?\n/).slice(0, 80)
  } catch {
    return meta
  }
  if (lines.length < 3 || lines[0].trim() !== '---') return meta

  let curKey = ''
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') break
    if (!line.trim()) continue
    if (line.trimStart().startsWith('#')) continue

    if (/^\s/.test(line)) {
      // 缩进续行 / 折叠块正文：并入当前键（PS 语义：空格连接）
      if (curKey) {
        const add = line.trim()
        if (add) meta[curKey] = `${meta[curKey]} ${add}`.trim()
      }
      continue
    }

    const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (kv) {
      curKey = kv[1]
      let val = kv[2].trim().replace(/^["']|["']$/g, '')
      // 折叠块 / 字面块的起始标记本身不是内容
      if (/^>[+-]?$/.test(val) || /^\|[+-]?$/.test(val)) val = ''
      meta[curKey] = val
    }
  }
  return meta
}

// ---------- _meta.json ----------

export interface SkillMeta {
  name?: string
  description?: string
  descriptionZh?: string
  source?: string
  branch?: string
  commitSha?: string
  installedAt?: string
  translatedAt?: string
  /** 手动指定的分类（覆盖自动判定；空/缺省 = 自动） */
  category?: string
  [key: string]: unknown
}

export function readMeta(dir: string): SkillMeta {
  const p = join(dir, '_meta.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SkillMeta
  } catch {
    return {}
  }
}

/** 合并写回：JSON.parse 保序，{...old, ...updates} 保留原有键序、新键追加（PS ordered 合并同效果） */
export function writeMeta(dir: string, updates: SkillMeta): void {
  const merged = { ...readMeta(dir), ...updates }
  writeFileSync(join(dir, '_meta.json'), JSON.stringify(merged, null, 2), 'utf8')
}

function formatNow(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ---------- 列表 ----------

/** 技能简介：frontmatter 优先，其次已有 _meta.json（PS 同口径） */
function readIntros(dir: string): { fm: Record<string, string>; intro: string; introZh: string } {
  const fm = readFrontmatter(join(dir, 'SKILL.md'))
  const meta = readMeta(dir)
  const intro = (fm['description'] ?? '').trim() || String(meta.description ?? '').trim()
  const introZh = String(meta.descriptionZh ?? '').trim()
  return { fm, intro, introZh }
}

/** 停用技能存放区：与共享库同父目录（同盘 rename 原子；且在共享库外，Agent 绝对扫不到） */
export function disabledRoot(config: AppConfig): string {
  return join(config.sharedRoot, '..', 'skills-disabled')
}

/** 扫描共享库 + 停用区：每个含 SKILL.md 的子目录即一个技能（含 skill-router 自身） */
export function listSkills(config: AppConfig): SkillInfo[] {
  const root = config.sharedRoot
  if (!existsSync(root)) return []
  const out: SkillInfo[] = []
  const scanDir = (base: string, enabled: boolean) => {
    if (!existsSync(base)) return
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const dir = join(base, entry.name)
      if (!existsSync(join(dir, 'SKILL.md'))) continue
      const { fm, intro, introZh } = readIntros(dir)
      const meta = readMeta(dir)
      const manualCategory = String(meta.category ?? '').trim()
      // 套件成员固定归「套件」分类；其次手动指定；再退回关键词自动分类
      const pkgRaw = meta.package as { marketplace?: unknown; plugin?: unknown; version?: unknown } | undefined
      const isPkg = Boolean(pkgRaw?.marketplace && pkgRaw?.plugin)
      out.push({
        name: entry.name,
        category: isPkg
          ? '套件'
          : entry.name === ROUTER_SKILL_NAME
            ? 'Agent 与技能管理'
            : manualCategory || classifySkill(entry.name, introZh || intro, fm),
        intro,
        introZh,
        source: meta.source?.toString(),
        branch: meta.branch?.toString(),
        commitSha: meta.commitSha?.toString(),
        installedAt: meta.installedAt?.toString(),
        translatedAt: meta.translatedAt?.toString(),
        version: meta.version?.toString(),
        package: isPkg
          ? {
              marketplace: String(pkgRaw!.marketplace),
              plugin: String(pkgRaw!.plugin),
              version: pkgRaw!.version ? String(pkgRaw!.version) : undefined
            }
          : undefined,
        enabled
      })
    }
  }
  scanDir(root, true)
  scanDir(disabledRoot(config), false)
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  return out
}

/** 启停技能：在共享库与停用区之间移动（同盘 rename 原子；跨盘兜底复制+删除） */
export function toggleSkillEnabled(config: AppConfig, name: string, enabled: boolean): OpResult {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`非法技能名: ${name}`)
  }
  const from = join(enabled ? disabledRoot(config) : config.sharedRoot, name)
  const to = join(enabled ? config.sharedRoot : disabledRoot(config), name)
  if (!existsSync(from)) throw new Error(`${enabled ? '停用区' : '共享库'}中找不到技能: ${name}`)
  if (existsSync(to)) throw new Error(`目标已存在同名技能: ${name}`)
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch {
    // 跨盘 rename 失败兜底：复制 + 删除
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  return {
    logs: [
      enabled
        ? `[OK] ${name} 已启用（回到共享库，Agent 可加载）`
        : `[OK] ${name} 已停用（移出共享库，Agent 不再加载；数据保留在 skills-disabled）`
    ]
  }
}

/** 组套件：成员技能统一打 package 标记（marketplace='custom'） */
export function groupCustomPackage(config: AppConfig, packageName: string, members: string[]): OpResult {
  const pkg = packageName.trim()
  if (!pkg) throw new Error('套件名不能为空')
  if (members.length === 0) throw new Error('请至少选择一个技能')
  const logs: string[] = []
  for (const m of members) {
    const dir = skillDirOrThrow(config, m)
    writeMeta(dir, { package: { marketplace: 'custom', plugin: pkg } })
    logs.push(`[OK] ${m} → 套件「${pkg}」`)
  }
  logs.unshift(`[OK] 已把 ${members.length} 个技能组成自定义套件「${pkg}」`)
  return { logs }
}

/** 解散自定义套件：清除成员的 package 标记（仅 custom 套件可解散） */
export function ungroupCustomPackage(config: AppConfig, packageName: string): OpResult {
  const pkg = packageName.trim()
  const logs: string[] = []
  let count = 0
  for (const s of listSkills(config)) {
    if (s.package?.plugin === pkg && s.package.marketplace === 'custom') {
      const dir = join(s.enabled === false ? disabledRoot(config) : config.sharedRoot, s.name)
      const meta = readMeta(dir)
      delete meta.package
      writeFileSync(join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8')
      logs.push(`[OK] ${s.name} 已退出套件「${pkg}」`)
      count++
    }
  }
  if (count === 0) throw new Error(`自定义套件「${pkg}」不存在或没有成员`)
  logs.unshift(`[OK] 已解散自定义套件「${pkg}」（${count} 个成员）`)
  return { logs }
}

// ---------- 安装 ----------

/** 解析安装来源（install-skill.ps1 同款正则）：GitHub / owner/repo / skills.sh[/skill-name] */
export function parseSourceUrl(raw: string): { owner: string; repo: string; wantedSkill?: string } {
  const url = raw.trim()
  const skillsSh = /skills\.sh[:/]s?\/([^/\s#?]+)\/([^/\s#?]+)(?:\/([^/\s#?]+))?/.exec(url)
  if (skillsSh) {
    return {
      owner: skillsSh[1],
      repo: skillsSh[2].replace(/\.git$/, ''),
      wantedSkill: skillsSh[3]
    }
  }
  const gh = /github\.com[:/]([^/\s]+)\/([^/\s#?]+)/.exec(url)
  if (gh) return { owner: gh[1], repo: gh[2].replace(/\.git$/, '') }
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(url)
  if (short) return { owner: short[1], repo: short[2].replace(/\.git$/, '') }
  throw new Error(
    `无法识别的链接：${raw}。支持：https://github.com/owner/repo、owner/repo、https://skills.sh/s/owner/repo（或 /skill-name）`
  )
}

const GH_HEADERS = (config: AppConfig): Record<string, string> => {
  const h: Record<string, string> = { 'User-Agent': 'agent-skills-shared' }
  if (config.net?.token) h.Authorization = `Bearer ${config.net.token}`
  return h
}

const GH_OPTS = (config: AppConfig) => ({
  headers: GH_HEADERS(config),
  insecure: config.net?.allowInsecureTls ?? false
})

/** 递归收集含 SKILL.md 的目录（含 root 自身，PS -Recurse 同口径；不跟随联接） */
function findSkillDirs(root: string): string[] {
  const out: string[] = []
  if (existsSync(join(root, 'SKILL.md'))) out.push(root)
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (existsSync(join(full, 'SKILL.md'))) out.push(full)
        walk(full)
      }
    }
  }
  walk(root)
  return out
}

/** 安装执行：下载 zip → 识别技能目录 → 复制进共享库 → 写 _meta.json（含中文简介） */
export async function installSkills(
  config: AppConfig,
  repoUrl: string,
  opts: { replace?: boolean } = {}
): Promise<OpResult> {
  const { owner, repo, wantedSkill } = parseSourceUrl(repoUrl)
  const sharedRoot = config.sharedRoot
  const logs: string[] = [`共享技能库: ${sharedRoot}`, `安装来源:   ${owner}/${repo}`]

  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true })
    logs.push(`[OK] 已创建共享库: ${sharedRoot}`)
  }

  // 默认分支 + 版本基准 commit（失败容忍，PS 同语义）
  let branch: string | null = null
  let commitSha = ''
  try {
    const api = await httpGetJson<{ default_branch?: string }>(
      `https://api.github.com/repos/${owner}/${repo}`,
      { ...GH_OPTS(config), timeoutMs: 20000 }
    )
    branch = api.default_branch ?? null
  } catch {
    branch = null
  }
  if (branch) {
    try {
      const commit = await httpGetJson<{ sha?: string }>(
        `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`,
        { ...GH_OPTS(config), timeoutMs: 20000 }
      )
      commitSha = commit.sha ?? ''
    } catch {
      commitSha = ''
    }
  }

  // 下载 zip：默认分支失败回退 main / master
  const candidates = branch ? [branch] : ['main', 'master']
  const tmpDir = join(tmpdir(), `skill-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const zipPath = join(tmpDir, 'repo.zip')
  const extractDir = join(tmpDir, 'extract')
  let repoRoot = ''
  try {
    mkdirSync(tmpDir, { recursive: true })
    let downloaded = false
    for (const b of candidates) {
      const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${b}`
      try {
        logs.push(`下载: ${zipUrl}`)
        const buf = await httpGet(zipUrl, { ...GH_OPTS(config), timeoutMs: 60000 })
        if (buf.length > 0) {
          writeFileSync(zipPath, buf)
          downloaded = true
          break
        }
      } catch (e) {
        logs.push(`  分支 ${b} 下载失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!downloaded) throw new Error(`下载失败：仓库不存在、为私有或网络不可达。${owner}/${repo}`)

    await extractZip(zipPath, { dir: extractDir })
    const top = readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    if (top.length === 0) throw new Error('zip 包解压后没有目录，无法安装。')
    repoRoot = join(extractDir, top[0].name)

    // 识别技能目录：每个 SKILL.md 的父目录；若 A 是 B 的父目录，只保留更外层的 A
    const allDirs = findSkillDirs(repoRoot)
    if (allDirs.length === 0) throw new Error(`仓库中没有找到任何 SKILL.md，无法安装。${owner}/${repo}`)
    let skillDirs = allDirs.filter((d) => !allDirs.includes(dirname(d)))
    if (wantedSkill) {
      const wanted = skillDirs.filter((d) => d.split('\\').pop() === wantedSkill)
      if (wanted.length === 0) logs.push(`[!] 仓库中没有找到指定技能目录 [${wantedSkill}]，将安装全部技能。`)
      else skillDirs = wanted
    }
    logs.push(`识别到 ${skillDirs.length} 个技能：`)
    for (const d of skillDirs) {
      const name = d === repoRoot ? repo : d.split('\\').pop() ?? d
      logs.push(`  - ${name}`)
    }

    // 复制 + 元数据
    const installed: string[] = []
    const replaced: string[] = []
    const skipped: string[] = []
    for (const d of skillDirs) {
      const skillName = d === repoRoot ? repo : d.split('\\').pop() ?? d
      const dest = join(sharedRoot, skillName)
      const fm = readFrontmatter(join(d, 'SKILL.md'))
      const desc = (fm['description'] ?? '').trim()

      if (existsSync(dest)) {
        if (opts.replace) {
          assertRealDir(dest)
          rmSync(dest, { recursive: true })
          cpSync(d, dest, { recursive: true })
          writeMeta(dest, {
            name: skillName,
            description: desc,
            descriptionZh: await translateDescription(desc, config.net?.translateEmail),
            source: `https://github.com/${owner}/${repo}`,
            branch: branch ?? undefined,
            commitSha: commitSha || undefined,
            installedAt: formatNow()
          })
          replaced.push(skillName)
          logs.push(`[替换] ${skillName} 已替换为仓库版本`)
        } else {
          skipped.push(skillName)
          logs.push(`[跳过] 共享库已存在同名技能 ${skillName}`)
        }
        continue
      }
      cpSync(d, dest, { recursive: true })
      const count = findSkillDirs(dest).length
      installed.push(skillName)
      logs.push(`[OK] 已安装: ${skillName}（${count} 个 SKILL.md）`)
      writeMeta(dest, {
        name: skillName,
        description: desc,
        descriptionZh: await translateDescription(desc, config.net?.translateEmail),
        source: `https://github.com/${owner}/${repo}`,
        branch: branch ?? undefined,
        commitSha: commitSha || undefined,
        installedAt: formatNow()
      })
    }

    // 依赖提示（PS 同款清单）
    const depFiles = ['package.json', 'requirements.txt', 'pyproject.toml', 'Gemfile'].filter((f) =>
      existsSync(join(repoRoot, f))
    )
    if (depFiles.length > 0) {
      logs.push(
        '[!] 该仓库带依赖清单（package.json / requirements.txt 等）。若技能运行报错，请到对应技能目录按需安装依赖。'
      )
    }

    if (installed.length) logs.push(`[OK] 新装 ${installed.length} 个: ${installed.join(', ')}`)
    if (replaced.length) logs.push(`[!] 替换 ${replaced.length} 个: ${replaced.join(', ')}`)
    if (skipped.length) logs.push(`[!] 跳过 ${skipped.length} 个: ${skipped.join(', ')}`)
    logs.push(`重启各 Agent 会话即可生效。`)
    return { logs }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------- 移除 ----------

/** 移除技能：删除共享库中的技能目录（真实目录才允许；联接一律拒绝） */
export function removeSkill(config: AppConfig, name: string): OpResult {
  const dir = join(config.sharedRoot, name)
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`非法技能名: ${name}`)
  }
  if (!existsSync(dir)) throw new Error(`共享库中找不到技能: ${name}`)
  assertRealDir(dir) // 是联接/符号链接会直接抛错
  if (!existsSync(join(dir, 'SKILL.md'))) {
    throw new Error(`${dir} 里没有 SKILL.md，不像技能目录，拒绝删除。`)
  }
  rmSync(dir, { recursive: true })
  return {
    logs: [`[OK] 已移除技能: ${name}`, '共享库其余内容不受影响；重启各 Agent 会话生效。']
  }
}

// ---------- 翻译简介 ----------

/** 批量翻译：增量（已有中文跳过）/ 单技能 / 强制重译；接口限流熔断（连续 3 次失败收工） */
export async function translateIntros(
  config: AppConfig,
  opts: { name?: string; force?: boolean } = {}
): Promise<OpResult> {
  const root = config.sharedRoot
  if (!existsSync(root)) throw new Error(`共享库不存在: ${root}`)

  let dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => join(root, e.name))
    .filter((d) => existsSync(join(d, 'SKILL.md')))
    .sort()
  if (opts.name) {
    dirs = dirs.filter((d) => d.split('\\').pop() === opts.name)
    if (dirs.length === 0) throw new Error(`共享库中找不到技能: ${opts.name}`)
  }
  if (dirs.length === 0) throw new Error('共享库里没有可处理的技能（未找到含 SKILL.md 的目录）。')

  const logs: string[] = [`共享技能库: ${root}`, `待检查技能: ${dirs.length} 个`]
  let translated = 0
  let skippedZh = 0
  let noDesc = 0
  let failed = 0
  let consecFail = 0

  for (const dir of dirs) {
    const name = dir.split('\\').pop() ?? dir
    const meta = readMeta(dir)
    const fm = readFrontmatter(join(dir, 'SKILL.md'))
    const desc = ((fm['description'] ?? '') || String(meta.description ?? '')).trim()

    if (!desc) {
      noDesc++
      logs.push(`[跳过] ${name}：技能无简介`)
      continue
    }
    const existingZh = String(meta.descriptionZh ?? '')
    // 中文占比 >= 40% 视为已是中文（混合简介如 "英文… Trigger: …, 走私" 占比低，仍会翻译）
    if (!opts.force && (cjkRatio(existingZh) >= 0.4 || cjkRatio(desc) >= 0.4)) {
      skippedZh++
      logs.push(`[跳过] ${name}：已有中文简介`)
      continue
    }

    const zh = await translateDescription(desc, config.net?.translateEmail)
    if (!cjkRatio(zh)) {
      failed++
      consecFail++
      logs.push(`[FAIL] ${name}：接口未返回中文，保持原样`)
      if (consecFail >= 3) {
        logs.push(
          `[!] 连续 3 次失败，判定翻译接口已限流（免费接口按 IP 限每日额度），提前收工。稍后重跑可补齐。`
        )
        break
      }
      await sleep(300)
      continue
    }
    consecFail = 0
    writeMeta(dir, {
      name: meta.name ?? name,
      description: desc,
      descriptionZh: zh,
      translatedAt: formatNow()
    })
    translated++
    logs.push(`[OK] ${name} 已翻译（${zh.length} 字）`)
    await sleep(300)
  }

  logs.push(`========== 翻译结果 ==========`)
  logs.push(`已翻译写入: ${translated} 个`)
  if (skippedZh) logs.push(`跳过（已有中文）: ${skippedZh} 个`)
  if (noDesc) logs.push(`跳过（技能无简介）: ${noDesc} 个`)
  if (failed) logs.push(`[FAIL] 翻译失败: ${failed} 个（稍后重跑本功能可补齐）`)
  return { logs }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------- 生成路由技能（技能套件总入口） ----------

/** 路由技能目录名 = frontmatter name（避免"目录名 vs 注册名"对不上导致点名无效） */
export const ROUTER_SKILL_NAME = 'skill-router'
/** 旧版遗留目录名：生成在共享库根，任何 Agent 都加载不到（死技能），生成时自动清理 */
export const LEGACY_ROUTER_DIR = 'router-guide'

export interface RouterItem {
  /** 调用名（frontmatter name，即 Agent 里点名用的名字） */
  name: string
  /** 技能目录名，与调用名不同时在清单里标注 */
  dir?: string
  intro: string
  category: string
}

/** 一个路由写入目标（类型定义在 @shared/types，供 IPC / 渲染层共用） */

/** 技能根下实际可见的一个技能（比 SkillInfo 多记一个目录名） */
export interface VisibleSkill extends SkillInfo {
  dir: string
}

/** 取某个入口的技能根路径：已配置优先，其次静态预设展开 */
function agentRootOf(config: AppConfig, key: string): string | undefined {
  const configured = config.agents[key]
  if (configured) return configured
  const preset = AGENT_PRESETS.find((p) => p.key === key)
  if (!preset || preset.dynamic) return undefined
  return expandPath(preset.path)
}

/**
 * 扫描一个技能根下**实际可见**的技能（只读）。
 *
 * 与 listSkills 的关键差别：不跳过联接——Agent 技能根常常本身就是指向共享库的
 * junction，或根下是一堆指向共享库的技能级 junction；这里要的正是"那个 Agent
 * 真的能看到什么"。name 取 frontmatter 的 name（点名用），同时记下目录名。
 */
export function listVisibleSkills(root: string): VisibleSkill[] {
  if (!existsSync(root)) return []
  const out: VisibleSkill[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ROUTER_SKILL_NAME || entry.name === LEGACY_ROUTER_DIR) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    const { fm, intro, introZh } = readIntros(dir)
    const meta = readMeta(dir)
    const manualCategory = String(meta.category ?? '').trim()
    out.push({
      name: (fm['name'] ?? '').trim() || entry.name,
      dir: entry.name,
      category: manualCategory || classifySkill(entry.name, introZh || intro, fm),
      intro,
      introZh,
      source: meta.source?.toString(),
      branch: meta.branch?.toString(),
      commitSha: meta.commitSha?.toString(),
      installedAt: meta.installedAt?.toString(),
      translatedAt: meta.translatedAt?.toString(),
      version: meta.version?.toString()
    })
  }
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  return out
}

/**
 * 解析路由写入目标（只读）。
 *
 * 缺省 = 自动检测：已接入配置的 Agent + 静态预设里技能根存在的 Agent
 * （后者覆盖"装了但没在应用里接入"的软件，比如本机的 WorkBuddy）。
 * 显式传 keys 时只取这些入口（可以是未接入的预设）。
 */
export function resolveRouterTargets(config: AppConfig, keys?: string[]): RouterTarget[] {
  const groups = loadSameSourceGroups()
  const out = new Map<string, RouterTarget>()

  const consider = (key: string, label: string, configured: boolean): void => {
    const root = agentRootOf(config, key)
    if (!root) return
    const dedupe = root.toLowerCase()
    if (out.has(dedupe)) return
    const exists = existsSync(root)
    const verdict = exists ? classifyJunction(root, config.sharedRoot, groups).verdict : null
    out.set(dedupe, {
      key,
      label,
      root,
      exists,
      isSharedLink: verdict === 'ok',
      skillCount: exists ? listVisibleSkills(root).length : 0,
      configured
    })
  }

  if (keys && keys.length > 0) {
    for (const k of keys) {
      const preset = AGENT_PRESETS.find((p) => p.key === k)
      consider(k, preset?.label ?? k, Boolean(config.agents[k]))
    }
    return [...out.values()]
  }

  // 1) 用户在应用里接入过的 Agent
  for (const k of Object.keys(config.agents)) {
    const preset = AGENT_PRESETS.find((p) => p.key === k)
    consider(k, preset?.label ?? k, true)
  }
  // 2) 自动检测：静态预设里技能根已存在的入口
  for (const p of AGENT_PRESETS) {
    if (p.dynamic) continue
    consider(p.key, p.label, false)
  }
  return [...out.values()]
}

/** 清理旧版生成在共享库根的 router-guide（无法被任何 Agent 加载，纯垃圾） */
function cleanupLegacyRouter(sharedRoot: string): string[] {
  const legacy = join(sharedRoot, LEGACY_ROUTER_DIR)
  if (!existsSync(legacy)) return []
  try {
    assertRealDir(legacy) // 联接一律拒绝：防 rmSync 穿透到共享库
    const names = readdirSync(legacy)
    const onlyOwn =
      names.length > 0 && names.every((n) => n === 'SKILL.md' || n === '_meta.json')
    const head = onlyOwn
      ? readFileSync(join(legacy, 'SKILL.md'), 'utf8').replace(/^\uFEFF/, '').slice(0, 160)
      : ''
    if (onlyOwn && head.includes(`name: ${ROUTER_SKILL_NAME}`)) {
      rmSync(legacy, { recursive: true, force: true })
      return [`[清理] 已删除旧版死技能（生成在共享库根、任何 Agent 都加载不到）: ${legacy}`]
    }
    return [`[提示] ${legacy} 内容不像本工具生成的路由技能，未自动删除，可在技能库中手动移除`]
  } catch (e) {
    return [`[提示] 旧路由目录未清理：${e instanceof Error ? e.message : String(e)}`]
  }
}

/** 纯函数：按 9 大分类 + 自定义分类组织套件清单（技能套件总入口文案） */
export function buildRouterMarkdown(items: RouterItem[], root: string, targetLabel?: string): string {
  const lines: string[] = []
  lines.push('---')
  lines.push(`name: ${ROUTER_SKILL_NAME}`)
  lines.push(
    `description: 技能套件总入口（${items.length} 个技能）。用户点名本技能并描述想做的事时，读下方清单按描述匹配最合适的 1~3 个技能，说明推荐理由后立即读取该技能自己的 SKILL.md 并执行；用户直接问某个技能是什么、什么时候用、怎么触发时，也由本文件回答。`
  )
  lines.push('---')
  lines.push('')
  lines.push('# 技能套件路由')
  lines.push('')
  lines.push('整个技能库被当作**一个套件**使用，本文件是它的唯一入口与索引。')
  lines.push('')
  lines.push(`- 套件规模：**${items.length}** 个技能`)
  lines.push(`- 技能根目录：\`${root}\`${targetLabel ? `（${targetLabel}）` : ''}`)
  lines.push('')
  lines.push('## 工作方式（写给 Agent）')
  lines.push('')
  lines.push('1. 用户在会话里点名 `skill-router` 并描述需求 → 先在下面的清单里按需求匹配，不要凭空发挥；')
  lines.push('2. 命中 1~3 个：逐个说明为什么合适，然后**立即**读取该技能的 SKILL.md 并按它执行（按贴合度排序；需要串联时按顺序做）；')
  lines.push('3. 只有一个明显命中：直接执行，不必罗列其他候选；')
  lines.push('4. 一个都没有：明确告诉用户「套件里没有匹配的技能」，再按常规方式处理，不要硬套；')
  lines.push('5. 用户直接问某个技能是什么 / 什么时候用 / 怎么触发：照本文件回答，必要时读它的 SKILL.md；')
  lines.push('6. 简介以中文为准（没有中文时看英文原文）。')
  lines.push('')
  lines.push('## 触发时机')
  lines.push('')
  lines.push('- 只要用户的目标是"做一件事 / 回答一个专业问题 / 生成一份内容"，就先查本清单再动手；')
  lines.push('- 清单里没有匹配项时，按常规方式处理，不必提及本技能。')
  lines.push('')
  lines.push(`## 技能清单（${items.length} 个）`)
  lines.push('')

  const emitGroup = (title: string, group: RouterItem[]): void => {
    if (group.length === 0) return
    lines.push(`### ${title}（${group.length}）`)
    lines.push('')
    for (const g of group) {
      const dirNote = g.dir && g.dir !== g.name ? `（目录 ${g.dir}）` : ''
      lines.push(g.intro ? `- **${g.name}**${dirNote}：${g.intro}` : `- **${g.name}**${dirNote}`)
    }
    lines.push('')
  }

  for (const cn of CATEGORY_ORDER) emitGroup(cn, items.filter((i) => i.category === cn))
  // 自定义分类（不在词典 displayOrder 里的）兜底展示，不能漏
  const known = new Set<string>(CATEGORY_ORDER)
  const extras = [...new Set(items.filter((i) => !known.has(i.category)).map((i) => i.category))].sort()
  for (const cn of extras) emitGroup(cn, items.filter((i) => i.category === cn))

  return lines.join('\n')
}

export interface RouterGenOptions {
  /** 只写这些入口（key）；缺省 = 自动检测（已接入 + 预设里可用的技能根） */
  targetKeys?: string[]
}

/**
 * 生成 / 刷新技能套件路由技能（skill-router）。
 *
 * 与 PS 版的核心差异：写到**各 Agent 的技能根**（真实加载位置），而不是共享库根；
 * 清单只收录该根下实际可见的技能，所以照单点名一定能调到。
 */
export async function generateRouter(config: AppConfig, opts?: RouterGenOptions): Promise<OpResult> {
  const sharedRoot = config.sharedRoot
  if (!existsSync(sharedRoot)) throw new Error(`共享库不存在: ${sharedRoot}`)

  const logs: string[] = []
  // 1) 先清掉 PS 版遗留的死技能（生成在共享库根，任何 Agent 都加载不到）
  logs.push(...cleanupLegacyRouter(sharedRoot))

  // 2) 解析目标：目录存在且能扫到技能的技能根
  const all = resolveRouterTargets(config, opts?.targetKeys)
  const usable = all.filter((t) => t.exists && t.skillCount > 0)
  const skipped = all.filter((t) => !t.exists || t.skillCount === 0)
  if (usable.length === 0) {
    throw new Error(
      '没有可写入的技能根：请先在「联接」页接入至少一个 Agent，或确认 Agent 技能目录里已经有技能'
    )
  }

  // 3) 逐根写盘（清单按各自根下"实际可见"的技能生成）
  let totalItems = 0
  for (const t of usable) {
    const items: RouterItem[] = listVisibleSkills(t.root)
      .map((s) => ({
        name: s.name,
        dir: s.dir,
        intro: s.introZh || s.intro,
        category: s.category
      }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

    const outDir = join(t.root, ROUTER_SKILL_NAME)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'SKILL.md'), buildRouterMarkdown(items, t.root, t.label), 'utf8')
    // 固定分类落盘：技能库列表 / 分类过滤里归属稳定（仅对共享库内的可见副本有意义）
    writeMeta(outDir, { name: ROUTER_SKILL_NAME, category: 'Agent 与技能管理' })

    totalItems += items.length
    logs.push(
      `[OK] ${t.label} → ${join(outDir, 'SKILL.md')}（收录 ${items.length} 个技能${t.isSharedLink ? ' · 共享库联接' : ''}）`
    )
  }

  if (skipped.length > 0) {
    logs.push(
      `[跳过] ${skipped.length} 个入口不可用（目录不存在或没有技能）：${skipped.map((s) => s.key).join('、')}`
    )
  }
  logs.push('')
  logs.push(`已写入 ${usable.length} 个技能根，清单合计 ${totalItems} 条。`)
  logs.push('⚠ 路由技能不会自动触发：请在该 Agent 的**新会话**里点名 skill-router 并描述需求，')
  logs.push('  它会按清单匹配技能、说明理由，然后直接按那个技能执行。')
  logs.push('  技能安装 / 移除 / 翻译之后，重新点「生成路由」即可刷新清单。')

  return { logs }
}

// ---------- 分类管理（手动指定 / 自定义分类 / 重命名） ----------

export function skillDirOrThrow(config: AppConfig, name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`非法技能名: ${name}`)
  }
  const dir = join(config.sharedRoot, name)
  if (!existsSync(dir) || !existsSync(join(dir, 'SKILL.md'))) {
    throw new Error(`共享库中找不到技能: ${name}`)
  }
  return dir
}

/** 手动指定技能分类（写入 _meta.json.category，覆盖自动判定；传空串清除覆盖） */
export function setSkillCategory(config: AppConfig, name: string, category: string): OpResult {
  const dir = skillDirOrThrow(config, name)
  writeMeta(dir, { category: category.trim() })
  return {
    logs: [
      category.trim()
        ? `[OK] ${name} 分类已设为「${category.trim()}」`
        : `[OK] ${name} 已恢复自动分类`
    ]
  }
}

/** 收集自定义分类（meta.category 里不在词典 displayOrder 中的名字） */
export function listCustomCategories(config: AppConfig): string[] {
  const builtin = new Set(CATEGORY_ORDER)
  const found = new Set<string>()
  if (!existsSync(config.sharedRoot)) return []
  for (const entry of readdirSync(config.sharedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const meta = readMeta(join(config.sharedRoot, entry.name))
    const c = String(meta.category ?? '').trim()
    if (c && !builtin.has(c)) found.add(c)
  }
  return [...found].sort()
}

/** 重命名自定义分类：遍历共享库把 meta.category === from 的全部改为 to */
export function renameCategory(config: AppConfig, from: string, to: string): OpResult {
  const root = config.sharedRoot
  if (!existsSync(root)) throw new Error(`共享库不存在: ${root}`)
  if (!from.trim() || !to.trim()) throw new Error('分类名不能为空')
  const logs: string[] = []
  let count = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    const meta = readMeta(dir)
    if (String(meta.category ?? '').trim() === from.trim()) {
      writeMeta(dir, { category: to.trim() })
      count++
      logs.push(`  ${entry.name}: ${from} -> ${to}`)
    }
  }
  if (count === 0) throw new Error(`没有技能使用分类「${from}」`)
  logs.unshift(`[OK] 已重命名 ${count} 个技能的分类`)
  return { logs }
}

/**
 * 设置技能来源并建立版本基准（解决"无版本信息"）：
 * 解析 GitHub / skills.sh 链接 -> 查默认分支最新 commitSha 写入 _meta.json，
 * 更新检测立即有基准（状态=最新），之后仓库有新提交才算"有更新"。
 */
export async function setSkillSource(config: AppConfig, name: string, url: string): Promise<OpResult> {
  const dir = skillDirOrThrow(config, name)
  const { owner, repo } = parseSourceUrl(url)
  const source = `https://github.com/${owner}/${repo}`

  let branch: string | null = null
  let commitSha = ''
  try {
    const api = await httpGetJson<{ default_branch?: string }>(
      `https://api.github.com/repos/${owner}/${repo}`,
      { ...GH_OPTS(config), timeoutMs: 20000 }
    )
    branch = api.default_branch ?? null
  } catch {
    branch = null
  }
  if (branch) {
    try {
      const commit = await httpGetJson<{ sha?: string }>(
        `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`,
        { ...GH_OPTS(config), timeoutMs: 20000 }
      )
      commitSha = commit.sha ?? ''
    } catch {
      commitSha = ''
    }
  }

  writeMeta(dir, { source, branch: branch ?? undefined, commitSha: commitSha || undefined })
  const logs = [`[OK] ${name} 来源已设为 ${source}${branch ? `@${branch}` : ''}`]
  logs.push(commitSha ? `版本基准: ${commitSha.slice(0, 12)}（当前为最新，仓库有新提交时更新页会提示）` : '未能获取版本基准（仓库不可达？），更新页会显示[无基准]，可稍后重试')
  return { logs }
}

/** GitHub 仓库搜索（来源索引的自动补全；search API 匿名限速 10 次/分钟，有 token 更宽） */
export async function searchRepos(config: AppConfig, keyword: string): Promise<RepoSearchResult[]> {
  const kw = keyword.trim()
  if (!kw) return []
  const q = encodeURIComponent(kw)
  const r = await httpGetJson<{ items?: { full_name: string; description: string | null; stargazers_count: number; html_url: string }[] }>(
    `https://api.github.com/search/repositories?q=${q}&per_page=8&sort=stars`,
    { headers: GH_HEADERS(config), timeoutMs: 20000, insecure: config.net?.allowInsecureTls ?? false }
  )
  return (r.items ?? []).map((i) => ({
    repo: i.full_name,
    description: (i.description ?? '').trim(),
    stars: i.stargazers_count ?? 0,
    url: i.html_url ?? `https://github.com/${i.full_name}`
  }))
}
