import { app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configPath, loadConfig, saveConfig } from './services/config'
import { listAgentStatus } from './services/agents'
import { detectPresetAgents } from './services/detect'
import {
  detectDuplicateLoadRisks,
  loadSameSourceGroups,
  type VerifyVerdict
} from './services/junction-state'
import {
  fetchHubCategories,
  fetchHubSkillDetail,
  installHubSkill,
  listHubSkills
} from './services/hub'
import {
  buildMergePlans,
  createJunction,
  mergeGroup,
  planCreate,
  removeJunction
} from './services/junction-write'
import {
  generateRouter,
  installSkills,
  listSkills,
  listCustomCategories,
  removeSkill,
  renameCategory,
  searchRepos,
  setSkillCategory,
  setSkillSource,
  translateIntros
} from './services/skills'
import { checkSkillUpdates, checkToolUpdate, fetchToolReleases, updateSkills } from './services/updates'
import { downloadUpdate, installUpdate } from './services/updater'
import type { AppConfig, IpcResult } from '@shared/types'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** 统一包装：任何异常都变成 {ok:false,error}，渲染层不用写 try/catch */
function handle<T>(channel: string, fn: (...args: never[]) => T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...(args as never[])))
    } catch (error) {
      return fail(error)
    }
  })
}

export function registerIpc(): void {
  handle('config:get', () => loadConfig())

  handle('config:setSharedRoot', (path: string) => {
    if (!path || !path.trim()) throw new Error('共享库路径不能为空')
    const config = loadConfig()
    config.sharedRoot = path.trim()
    saveConfig(config)
    return config
  })

  handle('config:upsertAgent', (key: string, path: string) => {
    if (!key || !key.trim()) throw new Error('标识名不能为空')
    if (!path || !path.trim()) throw new Error('技能根路径不能为空')
    const config = loadConfig()
    config.agents[key.trim()] = path.trim()
    saveConfig(config)
    return config
  })

  handle('config:removeAgent', (key: string) => {
    const config = loadConfig()
    delete config.agents[key]
    saveConfig(config)
    return config
  })

  handle('agents:status', () => {
    const config: AppConfig = loadConfig()
    return listAgentStatus(config)
  })

  handle('agents:detectPresets', () => {
    const config: AppConfig = loadConfig()
    const detected = detectPresetAgents(config)
    // 重复加载风险：V2 目录段聚类（不同软件的专属目录不互报；通用根 .agents\skills 并存才报）
    const conflicts = detectDuplicateLoadRisks(detected.map((d) => d.path), loadSameSourceGroups())
    const FAILS: VerifyVerdict[] = ['fail-missing', 'fail-not-link', 'fail-wrong-target']
    const failCount = detected.filter((d) => FAILS.includes(d.state as VerifyVerdict)).length
    return { detected, conflicts, failCount }
  })

  // ---------- P4 联接写：建 / 拆 / 归并（UI 层全部二次确认后才调用） ----------

  /** 接入预案（dry-run）：返回迁移清单、内容冲突、同源多根警告，UI 据此弹确认框 */
  handle('junction:createPlan', (key: string, path: string) => {
    if (!path || !path.trim()) throw new Error('路径不能为空')
    return planCreate(key.trim(), path.trim(), loadConfig())
  })

  /** 接入执行：迁移内容 -> 建联接 -> 写入配置（add-agent.ps1 全流程） */
  handle('junction:create', (key: string, path: string) => {
    if (!key || !key.trim()) throw new Error('标识名不能为空')
    if (!path || !path.trim()) throw new Error('路径不能为空')
    const config = loadConfig()
    const result = createJunction(path.trim(), config)
    config.agents[key.trim()] = path.trim()
    saveConfig(config)
    return result
  })

  /** 拆除联接：只删重解析点，共享库数据保留；配置条目不动（状态会变 missing） */
  handle('junction:remove', (key: string) => {
    const config = loadConfig()
    const path = config.agents[key]
    if (!path) throw new Error(`配置中找不到 Agent「${key}」`)
    return removeJunction(path)
  })

  /** 归并预案：活跃根 >= 2 的同源组，含推荐保留路径 */
  handle('junction:mergePlan', () => buildMergePlans(loadConfig()))

  /** 归并执行：保留 keepPath，其余活跃根拆联接后重建空目录 */
  handle('junction:merge', (groupName: string, keepPath: string) =>
    mergeGroup(groupName, keepPath, loadConfig())
  )

  // ---------- P5 技能库：列表 / 安装 / 移除 / 翻译 / 路由 ----------

  handle('skills:list', () => listSkills(loadConfig()))

  /** 安装：GitHub / owner/repo / skills.sh 链接；replace=true 时同名技能替换为仓库版本 */
  handle('skills:install', (url: string, replace: boolean) => {
    if (!url || !url.trim()) throw new Error('请输入技能仓库链接')
    return installSkills(loadConfig(), url.trim(), { replace: Boolean(replace) })
  })

  /** 移除：删除共享库中的技能目录（真实目录才允许；UI 二次确认后调用） */
  handle('skills:remove', (name: string) => {
    if (!name || !name.trim()) throw new Error('技能名不能为空')
    return removeSkill(loadConfig(), name.trim())
  })

  /** 翻译简介：全库增量（默认）或指定技能；force=true 强制重译 */
  handle('skills:translate', (name?: string, force?: boolean) =>
    translateIntros(loadConfig(), { name: name || undefined, force: Boolean(force) })
  )

  handle('skills:router', () => generateRouter(loadConfig()))

  /** 手动指定技能分类（空串恢复自动分类） */
  handle('skills:setCategory', (name: string, category: string) => {
    if (!name?.trim()) throw new Error('技能名不能为空')
    return setSkillCategory(loadConfig(), name.trim(), category ?? '')
  })

  /** 自定义分类列表（meta.category 中不在词典内的） */
  handle('skills:customCategories', () => listCustomCategories(loadConfig()))

  /** 重命名自定义分类 */
  handle('skills:renameCategory', (from: string, to: string) => {
    if (!from?.trim() || !to?.trim()) throw new Error('分类名不能为空')
    return renameCategory(loadConfig(), from.trim(), to.trim())
  })

  /** 设置技能来源并建立版本基准（解析链接 + 拉取当前 commitSha） */
  handle('skills:setSource', async (name: string, url: string) => {
    if (!name?.trim() || !url?.trim()) throw new Error('技能名与来源链接不能为空')
    return setSkillSource(loadConfig(), name.trim(), url.trim())
  })

  /** GitHub 仓库搜索（来源索引自动补全） */
  handle('skills:searchRepos', (keyword: string) => {
    if (!keyword?.trim()) throw new Error('搜索关键词不能为空')
    return searchRepos(loadConfig(), keyword.trim())
  })

  // ---------- SkillHub 平台 ----------

  handle('hub:list', (opts: { page?: number; pageSize?: number; sortBy?: string; keyword?: string; category?: string }) => {
    const cfg = loadConfig()
    return listHubSkills(cfg, {
      page: Math.max(1, Number(opts?.page) || 1),
      pageSize: Math.min(60, Math.max(6, Number(opts?.pageSize) || 24)),
      sortBy: (['score', 'updated_at', 'downloads', 'installs'] as const).includes(opts?.sortBy as never)
        ? (opts!.sortBy as 'score' | 'updated_at' | 'downloads' | 'installs')
        : 'score',
      keyword: opts?.keyword,
      category: opts?.category
    })
  })

  /** 列表 + 分类一起拉（分类映射用于卡片中文名） */
  handle('hub:bootstrap', async () => {
    const cfg = loadConfig()
    const categories = await fetchHubCategories(cfg)
    const list = await listHubSkills(cfg, { page: 1, pageSize: 24, sortBy: 'score', categories })
    return { categories, ...list }
  })

  handle('hub:listWithCategories', async (opts: { page?: number; sortBy?: string; keyword?: string; category?: string }) => {
    const cfg = loadConfig()
    const categories = await fetchHubCategories(cfg)
    const list = await listHubSkills(cfg, {
      page: Math.max(1, Number(opts?.page) || 1),
      pageSize: 24,
      sortBy: (['score', 'updated_at', 'downloads', 'installs'] as const).includes(opts?.sortBy as never)
        ? (opts!.sortBy as 'score' | 'updated_at' | 'downloads' | 'installs')
        : 'score',
      keyword: opts?.keyword,
      category: opts?.category,
      categories
    })
    return { categories, ...list }
  })

  handle('hub:detail', async (slug: string, namespace: string) => {
    const cfg = loadConfig()
    const categories = await fetchHubCategories(cfg)
    return fetchHubSkillDetail(cfg, slug, namespace, categories)
  })

  /** 安装 SkillHub 技能（GitHub 上游走既有安装链路；原生技能走文件下载 + sha256 校验） */
  handle('hub:install', async (slug: string, namespace: string, replace?: boolean) => {
    const cfg = loadConfig()
    return installHubSkill(cfg, slug, namespace, {
      replace: replace !== false,
      githubInstaller: (url) => installSkills(cfg, url, { replace: true })
    })
  })

  // ---------- P6 更新检测 ----------

  handle('updates:checkSkills', () => checkSkillUpdates(loadConfig()))

  /** 一键升级：对指定仓库逐个重新安装（-Replace）；UI 二次确认后调用 */
  handle('updates:updateSkills', (repos: string[]) => {
    if (!Array.isArray(repos) || repos.length === 0) throw new Error('没有需要升级的仓库')
    return updateSkills(loadConfig(), repos)
  })

  handle('updates:checkTool', () => checkToolUpdate(loadConfig(), app.getVersion()))

  /** 工具的历史发布记录（含更新说明 / 更新日志） */
  handle('updates:toolReleases', () => fetchToolReleases(loadConfig()))

  /** 下载更新包（electron-updater，GitHub Releases 通道；进度走 update-progress 事件） */
  handle('updates:downloadUpdate', () => downloadUpdate())

  /** 退出并安装已下载的更新 */
  handle('updates:installUpdate', () => {
    installUpdate()
    return { installing: true }
  })

  handle('app:getVersion', () => app.getVersion())

  // ---------- P7 设置 / 主题 / 导入导出 ----------

  /** 通用配置更新（ui / net / backup / sharedRoot 等浅合并字段）；更新后同步 nativeTheme */
  handle('config:update', (patch: Partial<AppConfig>) => {
    const config = loadConfig()
    if (patch.ui !== undefined) config.ui = { ...config.ui, ...patch.ui }
    if (patch.net !== undefined) config.net = { ...config.net, ...patch.net }
    if (patch.backup !== undefined) config.backup = { ...config.backup, ...patch.backup }
    if (patch.sharedRoot !== undefined) {
      if (!patch.sharedRoot.trim()) throw new Error('共享库路径不能为空')
      config.sharedRoot = patch.sharedRoot.trim()
    }
    saveConfig(config)
    if (config.ui?.theme) nativeTheme.themeSource = config.ui.theme
    return config
  })

  /** 导出配置到用户选择的 JSON 文件（含 sharedRoot / agents / ui / net） */
  handle('config:export', async () => {
    const config = loadConfig()
    const r = await dialog.showSaveDialog({
      title: '导出配置',
      defaultPath: join(homedir(), 'skills-manager-config.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return { saved: false }
    writeFileSync(r.filePath, JSON.stringify(config, null, 2), 'utf8')
    return { saved: true, path: r.filePath }
  })

  /** 导入配置：读 JSON → 结构校验 → 覆盖保存（路径不会自动建联接，安全） */
  handle('config:import', async () => {
    const r = await dialog.showOpenDialog({
      title: '导入配置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return { imported: false }
    const file = r.filePaths[0]
    if (!existsSync(file)) throw new Error(`文件不存在: ${file}`)
    let parsed: Partial<AppConfig>
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>
    } catch {
      throw new Error('配置文件不是合法 JSON')
    }
    if (typeof parsed.sharedRoot !== 'string' || !parsed.sharedRoot.trim()) {
      throw new Error('配置缺少 sharedRoot，拒绝导入')
    }
    if (parsed.agents !== undefined && typeof parsed.agents !== 'object') {
      throw new Error('agents 字段类型不对，拒绝导入')
    }
    const config = loadConfig()
    config.sharedRoot = parsed.sharedRoot.trim()
    if (parsed.agents) config.agents = parsed.agents as Record<string, string>
    if (parsed.ui) config.ui = { ...config.ui, ...parsed.ui }
    if (parsed.net) config.net = { ...config.net, ...parsed.net }
    saveConfig(config)
    if (config.ui?.theme) nativeTheme.themeSource = config.ui.theme
    return { imported: true, config }
  })

  /** 读取配置文件位置（设置页展示用） */
  handle('config:path', () => configPath())

  // Electron 新版 shell.openPath 返回 Promise<string>：空串表示成功
  handle('shell:openPath', async (path: string) => {
    const result = await shell.openPath(path)
    return result === '' ? { opened: true } : { opened: false, message: result }
  })
}
