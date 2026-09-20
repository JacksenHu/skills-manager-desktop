import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import extractZip from 'extract-zip'
import type { AppConfig, OpResult, RepoSearchResult, SkillInfo } from '@shared/types'
import categoryDictJson from '@shared/data/category-dict.json'
import { assertRealDir } from './junction-write'
import { httpGet, httpGetJson, httpGetResponse, cjkRatio, translateDescription } from './translate'

/**
 * P5 技能库：列表 / 分类 / 安装 / 移除 / 翻译简介 / 生成路由。
 * 语义对齐 PowerShell 版：install-skill.ps1 / translate-skill-intro.ps1 /
 * generate-router-skill.ps1 / lib/translate.ps1。
 *
 * 安全约定：任何递归删除前必须过 assertRealDir（junction-write 导出的统一守卫）；
 * 删除对象只允许是共享库里的真实技能目录。
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

function readMeta(dir: string): SkillMeta {
  const p = join(dir, '_meta.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SkillMeta
  } catch {
    return {}
  }
}

/** 合并写回：JSON.parse 保序，{...old, ...updates} 保留原有键序、新键追加（PS ordered 合并同效果） */
function writeMeta(dir: string, updates: SkillMeta): void {
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

/** 扫描共享库：每个含 SKILL.md 的子目录即一个技能（含 router-guide） */
export function listSkills(config: AppConfig): SkillInfo[] {
  const root = config.sharedRoot
  if (!existsSync(root)) return []
  const out: SkillInfo[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    const { fm, intro, introZh } = readIntros(dir)
    const meta = readMeta(dir)
    const manualCategory = String(meta.category ?? '').trim()
    out.push({
      name: entry.name,
      // 手动指定的分类优先于自动判定
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

// ---------- 生成路由技能 ----------

export interface RouterItem {
  name: string
  intro: string
  category: string
}

/** 纯函数：按 9 大分类 + 未分类组织索引（generate-router-skill.ps1 同款文案结构） */
export function buildRouterMarkdown(items: RouterItem[], sharedRoot: string): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('name: skill-router')
  lines.push(
    'description: 共享技能库的总路由。当用户提出任何任务、问题或寻求帮助时（无论任务大小、是否明确提到技能），先阅读本文件的分类索引，从共享技能库中选出最匹配的 1~3 个技能并说明理由，然后按该技能自己的 SKILL.md 执行；用户直接点名技能名时，说明它的用途、适用场景与触发方式。所有条目按分类组织，未分类技能同样可用。'
  )
  lines.push('---')
  lines.push('')
  lines.push('# 统一技能路由')
  lines.push('')
  lines.push(`你是共享技能库的路由器，技能库根目录：${sharedRoot}`)
  lines.push('')
  lines.push('## 使用方式')
  lines.push('')
  lines.push('- 用户提出任何任务、问题或寻求帮助时（无论任务大小、是否明确提到技能），先在本文件的分类索引里匹配情境，推荐最合适的 1~3 个技能并说明理由；')
  lines.push('- 或用户直接说技能名，告知它是什么、什么时候用、怎么触发；')
  lines.push('- 本技能只做**索引与推荐**：确定技能后，按该技能自己的 SKILL.md 使用。')
  lines.push('')
  lines.push('## 触发时机（写给 Agent）')
  lines.push('')
  lines.push('- 只要是"要动手做一件事 / 回答一个专业问题 / 生成一份内容"的请求，就应先查阅本索引再行动；')
  lines.push('- 索引里没有匹配项时，按常规方式处理，不必提及本技能；')
  lines.push('- 简介以中文为准（无中文时看英文原文）。')
  lines.push('')
  lines.push('## 路由步骤')
  lines.push('')
  lines.push('1. 判断情境属于哪个大类（开发 / 写作 / 研究 / 办公 / 数据 / 设计 / 音视频 / Agent 管理 / 生活）；')
  lines.push('2. 在该分类条目中按名称与简介匹配任务关键词；')
  lines.push('3. 命中多个时，按描述贴合度排序，最多推荐 3 个。')
  lines.push('')
  lines.push(`## 分类索引（共 ${items.length} 个技能 · 9 大分类 + 未分类）`)
  lines.push('')

  for (const cn of CATEGORY_ORDER) {
    const group = items.filter((i) => i.category === cn)
    if (group.length === 0) continue
    lines.push(`### ${cn}（${group.length}）`)
    lines.push('')
    for (const g of group) {
      lines.push(g.intro ? `- **${g.name}**：${g.intro}` : `- **${g.name}**`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 生成 / 刷新 router-guide/SKILL.md（UTF-8 BOM，PS WriteAllText 同款） */
export async function generateRouter(config: AppConfig): Promise<OpResult> {
  const root = config.sharedRoot
  if (!existsSync(root)) throw new Error(`共享库不存在: ${root}`)

  const items: RouterItem[] = []
  let uncategorized = 0
  for (const info of listSkills(config)) {
    if (info.name === 'router-guide') continue // 路由技能自身不入索引（PS 同款排除）
    const intro = info.introZh || info.intro
    if (info.category === UNCATEGORIZED) uncategorized++
    items.push({ name: info.name, intro, category: info.category })
  }
  items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

  const outDir = join(root, 'router-guide')
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  // PS 用 UTF8 BOM 写出，保持一致（部分 Windows 工具链读无 BOM 的 UTF-8 会乱码）
  writeFileSync(join(outDir, 'SKILL.md'), '\uFEFF' + buildRouterMarkdown(items, root), 'utf8')

  return {
    logs: [
      `[OK] 已生成总路由技能: ${join(outDir, 'SKILL.md')}`,
      `     技能总数: ${items.length} · 未分类: ${uncategorized}`,
      '',
      '⚠ 使用提醒：路由技能不会在 Agent 会话里自动触发。',
      '  请在各 Agent 的新会话中手动选择 / 点名 skill-router 启用，',
      '  之后它会按本索引为你的任务推荐合适的技能。',
      '  每次新增/移除技能后，重新生成本技能刷新索引。'
    ]
  }
}

// ---------- 分类管理（手动指定 / 自定义分类 / 重命名） ----------

function skillDirOrThrow(config: AppConfig, name: string): string {
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
