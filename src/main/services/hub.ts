import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { AppConfig, HubCategory, HubListResult, HubSkill, HubSkillDetail, OpResult } from '@shared/types'
import { httpGet, httpGetJson } from './translate'
import { skillDirOrThrow, writeMeta } from './skills'

/**
 * P11 SkillHub 平台集成（https://skillhub.cn，API base https://api.skillhub.cn）。
 *
 * 端点（2026-09 对官方 SPA bundle 逆向确认）：
 * - GET /api/skills?page&pageSize&sortBy&keyword&category  → {code:0,data:{skills[],total}}
 *   sortBy 合法值：score | updated_at | downloads | stars | installs
 * - GET /api/v1/categories                                 → {count,items:[{key,name}]}
 * - GET /api/v1/skills/{slug}?namespace={handle}           → 详情（summary_zh/overviewMd/stats/...）
 * - GET /api/v1/skills/{slug}/files?namespace={handle}     → [{path,sha256,size}]
 * - GET /api/v1/skills/{slug}/file?path={path}&namespace=  → 文件原始内容
 *
 * 安装：files 清单逐个下载写入共享库/{slug}/（sha256 校验）+ _meta.json
 * （source = SkillHub 详情页链接，version 落盘）；有 GitHub 上游的技能
 * 优先走 installSkills（复用 GitHub 安装链路并建立更新基准）。
 */

const HUB_API = 'https://api.skillhub.cn'
const HUB_WEB = 'https://skillhub.cn'
const HUB_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }

export type HubSortBy = 'score' | 'updated_at' | 'downloads' | 'installs'

export const HUB_SORTS: { key: HubSortBy; label: string }[] = [
  { key: 'score', label: '全部' },
  { key: 'installs', label: '近期飙升' },
  { key: 'downloads', label: '下载热榜' },
  { key: 'updated_at', label: '最近上新' }
]

function categoryMapOf(categories: HubCategory[]): Map<string, string> {
  return new Map(categories.map((c) => [c.key, c.name]))
}

export async function fetchHubCategories(config: AppConfig): Promise<HubCategory[]> {
  const j = await httpGetJson<{ items?: { key: string; name: string; active?: boolean }[] }>(
    `${HUB_API}/api/v1/categories`,
    { headers: HUB_HEADERS, timeoutMs: 20000, insecure: config.net?.allowInsecureTls ?? false }
  )
  return (j.items ?? [])
    .filter((c) => c.active !== false && c.key !== 'pay-skill')
    .map((c) => ({ key: c.key, name: c.name }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

interface HubApiSkill {
  slug?: string
  name?: string
  namespace?: { handle?: string } | string
  category?: string
  description?: string
  description_zh?: string
  downloads?: number
  installs?: number
  stars?: number
  verified?: boolean
  version?: string
  iconUrl?: string
  updated_at?: number
  upstream_url?: string | null
}

function toHubSkill(s: HubApiSkill, catMap: Map<string, string>): HubSkill {
  const ns = typeof s.namespace === 'string' ? s.namespace : s.namespace?.handle ?? ''
  const slug = s.slug ?? ''
  return {
    slug,
    namespace: ns,
    name: (s.name ?? slug).trim(),
    category: s.category ?? '',
    categoryName: catMap.get(s.category ?? '') ?? '未分类',
    description: (s.description_zh ?? s.description ?? '').trim(),
    downloads: s.downloads ?? 0,
    installs: s.installs ?? 0,
    stars: s.stars ?? 0,
    verified: s.verified ?? false,
    version: s.version ?? '',
    iconUrl: s.iconUrl,
    updatedAt: s.updated_at ?? 0,
    hubUrl: `${HUB_WEB}/skills/${ns}/${slug}`
  }
}

/** 技能列表（分页 + 排序 + 关键词 + 分类） */
export async function listHubSkills(
  config: AppConfig,
  opts: {
    page: number
    pageSize: number
    sortBy: HubSortBy
    keyword?: string
    category?: string
    categories?: HubCategory[]
  }
): Promise<HubListResult> {
  const q = new URLSearchParams()
  q.set('page', String(opts.page))
  q.set('pageSize', String(opts.pageSize))
  q.set('sortBy', opts.sortBy)
  if (opts.keyword?.trim()) q.set('keyword', opts.keyword.trim())
  if (opts.category) q.set('category', opts.category)
  const j = await httpGetJson<{ code?: number; message?: string; data?: { skills?: HubApiSkill[]; total?: number } }>(
    `${HUB_API}/api/skills?${q.toString()}`,
    { headers: HUB_HEADERS, timeoutMs: 30000, insecure: config.net?.allowInsecureTls ?? false }
  )
  if (j.code !== 0) throw new Error(`SkillHub 接口返回错误: ${j.message ?? j.code}`)
  const catMap = categoryMapOf(opts.categories ?? [])
  return {
    skills: (j.data?.skills ?? []).map((s) => toHubSkill(s, catMap)),
    total: j.data?.total ?? 0,
    page: opts.page
  }
}

export async function fetchHubSkillDetail(
  config: AppConfig,
  slug: string,
  namespace: string,
  categories?: HubCategory[]
): Promise<HubSkillDetail> {
  const j = await httpGetJson<Record<string, unknown>>(
    `${HUB_API}/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`,
    { headers: HUB_HEADERS, timeoutMs: 30000, insecure: config.net?.allowInsecureTls ?? false }
  )
  const d = (j.skill ?? j.data ?? j) as Record<string, unknown> & HubApiSkill & {
    summary?: string
    summary_zh?: string
    overviewMd?: string
    createdAt?: number
    stats?: { versions?: number; downloads?: number; installs?: number; stars?: number }
    sourceUrl?: string | null
    labels?: Record<string, string>
  }
  const catMap = categoryMapOf(categories ?? [])
  const categoryKey = String(d.category ?? '')
  const ns = typeof d.namespace === 'string' ? d.namespace : d.namespace?.handle ?? ''
  return {
    slug: String(d.slug ?? slug),
    namespace: ns || namespace,
    name: String(d.displayName ?? d.name ?? slug).trim(),
    category: categoryKey,
    categoryName: catMap.get(categoryKey) ?? '未分类',
    description: (String(d.description_zh ?? d.description ?? '')).trim(),
    downloads: d.stats?.downloads ?? d.downloads ?? 0,
    installs: d.stats?.installs ?? d.installs ?? 0,
    stars: d.stats?.stars ?? d.stars ?? 0,
    verified: Boolean(d.verified),
    version: String(d.version ?? ''),
    iconUrl: (d.iconUrl as string) ?? undefined,
    updatedAt: Number(d.updated_at ?? d.updatedAt ?? 0),
    hubUrl: `${HUB_WEB}/skills/${ns || namespace}/${slug}`,
    summary: String(d.summary_zh ?? d.summary ?? '').trim(),
    overviewMd: String(d.overviewMd ?? '').trim(),
    createdAt: Number(d.createdAt ?? d.created_at ?? 0),
    versionsCount: d.stats?.versions ?? 0,
    filesCount: 0,
    upstreamUrl: (d.upstream_url as string) || (d.sourceUrl as string) || undefined,
    requiresApiKey: d.labels?.requires_api_key === 'true'
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 查询平台当前版本号：详情接口没有 version 字段，只有列表接口带。
 * keyword=slug 搜索后按 slug+namespace 精确匹配；找不到返回 undefined。
 */
export async function fetchHubVersion(
  config: AppConfig,
  slug: string,
  namespace: string
): Promise<string | undefined> {
  const j = await httpGetJson<{ code?: number; data?: { skills?: HubApiSkill[] } }>(
    `${HUB_API}/api/skills?page=1&pageSize=8&keyword=${encodeURIComponent(slug)}`,
    { headers: HUB_HEADERS, timeoutMs: 30000, insecure: config.net?.allowInsecureTls ?? false }
  )
  for (const s of j.data?.skills ?? []) {
    const ns = typeof s.namespace === 'string' ? s.namespace : s.namespace?.handle ?? ''
    if (s.slug === slug && ns === namespace) return s.version || undefined
  }
  return undefined
}

function countFiles(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name))
    else n++
  }
  return n
}

/**
 * 安装 SkillHub 技能到共享库：
 * - 有 GitHub 上游：走 installSkills（GitHub 安装链路 + 更新基准），日志注明来源
 * - 原生技能：拉 files 清单 → 逐文件下载（sha256 校验）→ 写入共享库/{slug}/
 *   → _meta.json 写入来源（SkillHub 详情页）、版本、分类
 * 串行下载（每文件 1 请求），大技能会花十几秒，日志里给进度。
 */
export async function installHubSkill(
  config: AppConfig,
  slug: string,
  namespace: string,
  opts: { replace?: boolean; githubInstaller?: (url: string) => Promise<OpResult> }
): Promise<OpResult> {
  const catList = await fetchHubCategories(config)
  const detail = await fetchHubSkillDetail(config, slug, namespace, catList)
  const skillDir = resolve(config.sharedRoot, slug)

  // 目录穿越防护
  if (!skillDir.startsWith(resolve(config.sharedRoot) + sep)) {
    throw new Error(`非法技能目录名: ${slug}`)
  }
  const exists = existsSync(skillDir)
  if (exists && opts?.replace === false) {
    return { logs: [`[跳过] ${slug} 已存在于共享库（如需覆盖请先移除或开启覆盖）`] }
  }

  // GitHub 上游优先：复用 GitHub 安装链路（自动建 source/commitSha 基准）
  const upstream = detail.upstreamUrl
  if (upstream && /^https:\/\/github\.com\//i.test(upstream)) {
    const logs = [`[OK] ${detail.name} 来自 SkillHub，检测到 GitHub 上游，走 GitHub 安装：${upstream}`]
    const r = await opts?.githubInstaller?.(upstream)
    if (r) {
      logs.push(...r.logs)
      return { logs }
    }
  }

  const logs: string[] = [`安装 SkillHub 技能: ${detail.name} (${namespace}/${slug})`]
  if (detail.version) logs.push(`版本: ${detail.version}`)
  if (detail.requiresApiKey) logs.push('[注意] 该技能标注「需配置 API Key」，安装后需按其说明配置')

  const filesResp = await httpGetJson<{ files?: { path: string; sha256?: string; size?: number }[] }>(
    `${HUB_API}/api/v1/skills/${encodeURIComponent(slug)}/files?namespace=${encodeURIComponent(namespace)}`,
    { headers: HUB_HEADERS, timeoutMs: 30000, insecure: config.net?.allowInsecureTls ?? false }
  )
  const files = filesResp.files ?? []
  if (files.length === 0) throw new Error('SkillHub 未返回文件清单，无法安装')
  logs.push(`共 ${files.length} 个文件，开始下载…`)

  mkdirSync(skillDir, { recursive: true })
  let done = 0
  let hashMismatch = 0
  for (const f of files) {
    const rel = f.path
    // 防目录穿越：解析后的目标必须落在技能目录内
    const dest = resolve(skillDir, rel)
    if (!dest.startsWith(skillDir + sep)) {
      logs.push(`[跳过] 非法路径 ${rel}`)
      continue
    }
    const buf = await httpGet(
      `${HUB_API}/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(rel)}&namespace=${encodeURIComponent(namespace)}`,
      { headers: HUB_HEADERS, timeoutMs: 60000, insecure: config.net?.allowInsecureTls ?? false }
    )
    if (f.sha256 && sha256(buf) !== f.sha256.toLowerCase()) {
      hashMismatch++
      logs.push(`[FAIL] ${rel}: sha256 校验不匹配，已跳过`)
      continue
    }
    mkdirSync(dest.slice(0, dest.lastIndexOf(sep)), { recursive: true })
    writeFileSync(dest, buf)
    done++
    if (done % 10 === 0) logs.push(`  进度 ${done}/${files.length}`)
  }
  logs.push(`[OK] 已写入 ${done}/${files.length} 个文件${hashMismatch ? `，${hashMismatch} 个校验失败跳过` : ''}`)

  const catName = catList.find((c) => c.key === detail.category)?.name ?? '未分类'
  // 版本号以列表接口为准（详情接口无 version 字段）
  const hubVersion = (await fetchHubVersion(config, slug, namespace)) ?? detail.version
  writeMeta(skillDir, {
    name: detail.name,
    descriptionZh: detail.summary || detail.description,
    source: detail.hubUrl,
    version: hubVersion || undefined,
    installedAt: new Date().toISOString().slice(0, 10),
    category: catName === '未分类' ? undefined : catName
  })
  logs.push(`[OK] 已写入 _meta.json（来源 ${detail.hubUrl}，版本 ${hubVersion || '未标注'}，分类「${catName}」）`)
  logs.push(`[OK] 安装完成，共 ${countFiles(skillDir)} 个文件。可在「技能库」中查看，更新检测以来源链接为基准。`)
  return { logs }
}

/** 判断某个 Hub 技能是否已装入共享库（按我们写入的来源链接比对） */
export function hubSkillInstalled(allSources: (string | undefined)[], slug: string, namespace: string): boolean {
  const marker = `/skills/${namespace}/${slug}`
  return allSources.some((s) => typeof s === 'string' && s.includes(marker))
}

// ---------- 来源自动匹配（补全来源：按名称/简介在 SkillHub 搜，命中自动写来源+版本） ----------

export interface HubMatchResult {
  matched: boolean
  slug?: string
  namespace?: string
  name?: string
  version?: string
  hubUrl?: string
  score: number
  note?: string
}

const normKey = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[._\-\s]+/g, '')
    .replace(/skill$/, '')

function scoreHubCandidate(c: HubApiSkill, dirName: string, displayName?: string): number {
  const cs = normKey(String(c.slug ?? ''))
  const cn = normKey(String(c.name ?? ''))
  const dn = normKey(dirName)
  let best = 0
  if (dn && cs === dn) best = Math.max(best, 100)
  if (dn && cs && cs.length > 2 && (cs.includes(dn) || dn.includes(cs))) best = Math.max(best, 70)
  if (displayName) {
    const dn2 = normKey(displayName)
    if (dn2 && cn === dn2) best = Math.max(best, 92)
    if (cn.length > 2 && dn2 && (cn.includes(dn2) || dn2.includes(cn))) best = Math.max(best, 62)
  }
  return best
}

/**
 * 在 SkillHub 里搜索与本地技能（目录名 / 显示名 / 简介）匹配的技能。
 * 多段查询（目录名 → 显示名 → 简介关键片段），归一化打分，>= 60 分视为匹配。
 */
export async function matchHubSkill(
  config: AppConfig,
  dirName: string,
  displayName?: string,
  intro?: string
): Promise<HubMatchResult> {
  const queries: string[] = []
  if (dirName?.trim()) queries.push(dirName.trim())
  if (displayName?.trim() && normKey(displayName) !== normKey(dirName)) queries.push(displayName.trim())
  const introQ = (intro ?? '')
    .replace(/[#>*`|\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
  if (introQ.length >= 6) queries.push(introQ)

  let best: HubMatchResult = { matched: false, score: 0, note: 'SkillHub 未找到匹配' }
  const seen = new Set<string>()
  for (const q of queries) {
    try {
      const j = await httpGetJson<{ code?: number; data?: { skills?: HubApiSkill[] } }>(
        `${HUB_API}/api/skills?page=1&pageSize=8&keyword=${encodeURIComponent(q)}`,
        { headers: HUB_HEADERS, timeoutMs: 30000, insecure: config.net?.allowInsecureTls ?? false }
      )
      for (const c of j.data?.skills ?? []) {
        const ns = typeof c.namespace === 'string' ? c.namespace : c.namespace?.handle ?? ''
        const key = `${ns}/${c.slug ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const sc = scoreHubCandidate(c, dirName, displayName)
        if (sc > best.score) {
          const matched = sc >= 60
          best = {
            matched,
            score: sc,
            slug: c.slug,
            namespace: ns,
            name: (c.name ?? c.slug ?? '').trim(),
            version: c.version ?? '',
            hubUrl: `${HUB_WEB}/skills/${ns}/${c.slug}`,
            note: matched ? `关键词匹配（相似度 ${sc}）` : undefined
          }
        }
      }
      if (best.score >= 100) break
    } catch {
      // 单段查询失败继续下一段
    }
  }
  return best
}

/** 把匹配结果写入技能 _meta（source = SkillHub 详情页，version 落盘，供更新页检测） */
export async function applyHubSource(
  config: AppConfig,
  skillName: string,
  match: HubMatchResult,
  skillMeta?: { displayName?: string; intro?: string }
): Promise<OpResult> {
  if (!match.matched || !match.slug || !match.namespace) {
    return { logs: [`[跳过] ${skillName}: ${match.note ?? 'SkillHub 未找到匹配'}`] }
  }
  const dir = skillDirOrThrow(config, skillName)
  writeMeta(dir, { source: match.hubUrl!, version: match.version || undefined })
  const logs = [
    `[OK] ${skillName} → SkillHub「${match.name}」（v${match.version || '?'}，相似度 ${match.score}）`,
    `     来源: ${match.hubUrl}`,
    skillMeta?.displayName && normKey(skillMeta.displayName) !== normKey(match.name ?? '')
      ? '     注意：平台名称与本地名称不完全一致，请核实是否同一技能'
      : '     更新页将按此来源检测新版本。'
  ]
  return { logs }
}
