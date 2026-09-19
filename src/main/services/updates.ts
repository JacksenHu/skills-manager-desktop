import { Buffer } from 'node:buffer'
import type {
  AppConfig,
  CheckUpdatesResult,
  OpResult,
  RepoUpdateInfo,
  RepoUpdateState,
  SkillInfo,
  ToolReleaseInfo,
  ToolUpdateInfo
} from '@shared/types'
import { httpGetJson, httpGetResponse } from './translate'
import { installSkills, listSkills } from './skills'

/**
 * P6 更新检测（check-updates.ps1 / check-project-updates.ps1 的 Node 版）。
 *
 * 技能更新：按 _meta.json.source 里的 GitHub 仓库分组，逐仓库调
 * GET /repos/{owner}/{repo}/commits?per_page=1 取远程最新 SHA，
 * 与安装时记录的 commitSha 基准对比。六种细分状态：
 *   latest / update / no-baseline（有来源无基准）/ rate-limited(403,429)
 *   / gone(404，仓库不存在或私有) / error（网络或其他）
 *
 * 工具自身：远程仓库 package.json 的 version 与本地版本对比（四类判定）。
 * 自动升级只做「重新安装技能」（installSkills -Replace）；
 * 桌面程序自身的自动更新留待 P8 打包分发后实现。
 */

/** 桌面程序自身在 GitHub 上的仓库（发布后用于自检版本） */
export const TOOL_REPO = 'JacksenHu/skills-manager-desktop'

/** 从 source 链接提取 owner/repo（check-updates.ps1 同款正则） */
export function parseRepoKey(source: string | undefined): string | null {
  if (!source) return null
  const m = /github\.com[:/]([^/\s]+)\/([^/\s#?]+)/.exec(source)
  if (!m) return null
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`
}

/**
 * 纯函数：单仓库判定（便于离线测试，与 check-updates.ps1 判定顺序一致）。
 * fetchError 传请求失败的状态码（0 = 网络异常或无状态码）。
 * 注意：fetchError === 0 但 remoteSha 也为空 → 同样视为异常（成功的 API 必然返回 SHA）。
 */
export function judgeRepoUpdate(localSha: string, remoteSha: string, fetchError: number): RepoUpdateState {
  if (fetchError === 403 || fetchError === 429) return 'rate-limited'
  if (fetchError === 404) return 'gone'
  if (fetchError !== 0 || !remoteSha) return 'error'
  if (!localSha) return 'no-baseline'
  return localSha === remoteSha ? 'latest' : 'update'
}

/** 技能列表按来源仓库分组（同仓库取任一非空本地 SHA 作为基准） */
export function groupByRepo(skills: SkillInfo[]): {
  repos: { repo: string; skills: string[]; localSha: string }[]
  noSource: { name: string; version?: string }[]
} {
  const order: string[] = []
  const map = new Map<string, { repo: string; skills: string[]; localSha: string }>()
  const noSource: { name: string; version?: string }[] = []

  for (const s of skills) {
    const key = parseRepoKey(s.source)
    if (!key) {
      noSource.push({ name: s.name, version: s.version })
      continue
    }
    let entry = map.get(key)
    if (!entry) {
      entry = { repo: key, skills: [], localSha: '' }
      map.set(key, entry)
      order.push(key)
    }
    entry.skills.push(s.name)
    if (!entry.localSha && s.commitSha) entry.localSha = s.commitSha
  }
  return { repos: order.map((k) => map.get(k)!), noSource }
}

/** 技能更新检测（每仓库 1 次 GitHub API 请求；403/429 视为限速） */
export async function checkSkillUpdates(config: AppConfig): Promise<CheckUpdatesResult> {
  const skills = listSkills(config)
  const { repos, noSource } = groupByRepo(skills)

  const headers: Record<string, string> = { 'User-Agent': 'agent-skills-shared' }
  if (config.net?.token) headers.Authorization = `Bearer ${config.net.token}`

  const out: RepoUpdateInfo[] = []
  for (const r of repos) {
    let remoteSha = ''
    let fetchError = 0
    try {
      const resp = await httpGetJson<{ sha?: string }[]>(
        `https://api.github.com/repos/${r.repo}/commits?per_page=1`,
        { headers, timeoutMs: 20000, insecure: config.net?.allowInsecureTls ?? false }
      )
      remoteSha = resp[0]?.sha ?? ''
    } catch (e) {
      // httpGetJson 失败时区分 403/429/404/其他（错误消息由 httpGet 统一格式化为 "HTTP xxx"）
      const msg = e instanceof Error ? e.message : String(e)
      const m = /HTTP (\d{3})/.exec(msg)
      fetchError = m ? Number(m[1]) : 0
    }
    out.push({
      repo: r.repo,
      skills: r.skills,
      state: judgeRepoUpdate(r.localSha, remoteSha, fetchError),
      localSha: r.localSha || undefined,
      remoteSha: remoteSha || undefined
    })
  }
  return { repos: out, noSource }
}

/** 一键升级：对指定仓库逐个重新安装（-Replace 覆盖本地旧版，check-updates.ps1 -Update 同语义） */
export async function updateSkills(config: AppConfig, repos: string[]): Promise<OpResult> {
  const logs: string[] = ['========== 开始自动升级（重新安装 -Replace）==========']
  for (const repo of repos) {
    const url = `https://github.com/${repo}`
    logs.push(`升级: ${url}`)
    try {
      const r = await installSkills(config, url, { replace: true })
      logs.push(...r.logs)
    } catch (e) {
      logs.push(`[FAIL] ${repo} 升级失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  logs.push('[OK] 升级流程结束。升级后重启各 Agent 会话生效。')
  return { logs }
}

/** 工具自身版本检测：远程 package.json version vs 本地版本（Token 失效自动降级匿名，PS 同语义） */
export async function checkToolUpdate(config: AppConfig, localVersion: string): Promise<ToolUpdateInfo> {
  const headers: Record<string, string> = { 'User-Agent': 'agent-skills-shared' }
  if (config.net?.token) headers.Authorization = `Bearer ${config.net.token}`
  const opts = { headers, timeoutMs: 20000, insecure: config.net?.allowInsecureTls ?? false }

  const fetchRemote = async (withAuth: boolean): Promise<{ ok: boolean; version: string; code: number }> => {
    try {
      const resp = await httpGetResponse(
        `https://api.github.com/repos/${TOOL_REPO}/contents/package.json?ref=main`,
        withAuth ? opts : { ...opts, headers: { 'User-Agent': headers['User-Agent'] } }
      )
      if (resp.status !== 200) return { ok: false, version: '', code: resp.status }
      const pkg = JSON.parse(Buffer.from(resp.body).toString('utf8')) as { content?: string }
      if (!pkg.content) return { ok: false, version: '', code: 404 }
      // GitHub contents API 返回 base64（带换行，需先剥掉）
      const raw = JSON.parse(Buffer.from(pkg.content.replace(/\n/g, ''), 'base64').toString('utf8')) as {
        version?: string
      }
      return { ok: true, version: raw.version ?? '', code: 200 }
    } catch {
      return { ok: false, version: '', code: 0 }
    }
  }

  let remoteVersion = ''
  let reason = 'net'
  let code = 0
  if (config.net?.token) {
    const withToken = await fetchRemote(true)
    if (withToken.ok) {
      remoteVersion = withToken.version
    } else if (withToken.code === 401 || withToken.code === 403) {
      // Token 无效/权限不足 → 降级匿名重试（PS 同语义）
      const anon = await fetchRemote(false)
      if (anon.ok) remoteVersion = anon.version
      else {
        code = anon.code
        reason = anon.code === 403 ? 'auth' : anon.code === 404 ? 'notfound' : 'net'
      }
    } else {
      code = withToken.code
      reason = code === 404 ? 'notfound' : 'net'
    }
  } else {
    const anon = await fetchRemote(false)
    if (anon.ok) remoteVersion = anon.version
    else {
      code = anon.code
      reason = code === 403 ? 'auth' : code === 404 ? 'notfound' : 'net'
    }
  }

  if (!remoteVersion) {
    return { state: 'unavailable', localVersion, reason: code === 0 && reason === 'net' ? 'net' : reason }
  }
  if (!localVersion) return { state: 'no-baseline', localVersion, remoteVersion }
  return {
    state: localVersion === remoteVersion ? 'up-to-date' : 'has-update',
    localVersion,
    remoteVersion
  }
}

/** 拉取工具的历史发布记录（GitHub Releases，含更新说明），供「更新」页展示更新日志 */
export async function fetchToolReleases(config: AppConfig): Promise<ToolReleaseInfo[]> {
  const headers: Record<string, string> = { 'User-Agent': 'agent-skills-shared' }
  if (config.net?.token) headers.Authorization = `Bearer ${config.net.token}`
  try {
    const resp = await httpGetResponse(
      `https://api.github.com/repos/${TOOL_REPO}/releases?per_page=10`,
      { headers, timeoutMs: 20000, insecure: config.net?.allowInsecureTls ?? false }
    )
    if (resp.status !== 200) return []
    const list = JSON.parse(Buffer.from(resp.body).toString('utf8')) as {
      tag_name?: string
      name?: string
      published_at?: string
      body?: string
      html_url?: string
      draft?: boolean
    }[]
    return list
      .filter((r) => !r.draft && r.tag_name)
      .map((r) => ({
        tagName: r.tag_name ?? '',
        name: r.name ?? r.tag_name ?? '',
        date: (r.published_at ?? '').slice(0, 10),
        body: (r.body ?? '').trim(),
        url: r.html_url ?? ''
      }))
  } catch {
    return []
  }
}
