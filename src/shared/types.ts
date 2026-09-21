/** 主进程与渲染进程共用的类型定义 */

/** 应用配置（对应 PowerShell 版的 config\agents.json，但存放位置独立） */
export interface AppConfig {
  /** 共享技能库绝对路径（所有 Junction 的目标） */
  sharedRoot: string
  /** key 仅作标识与展示，value 是技能根绝对路径 */
  agents: Record<string, string>
  ui?: {
    theme?: 'system' | 'light' | 'dark'
    /** 关闭窗口时最小化到托盘（默认 true；false = 直接退出） */
    closeToTray?: boolean
  }
  net?: {
    /** GitHub Token，可选，仅用于提高 API 配额 */
    token?: string
    /** 是否允许对 GitHub 域放宽 TLS 校验（本机代理根证书不在 Node CA 库时的兜底；网络层失败本就自动降级重试） */
    allowInsecureTls?: boolean
    /** MyMemory 翻译接口的邮箱（官方 de= 参数，可显著提高匿名每日配额） */
    translateEmail?: string
  }
  /** 接入备份：首次接入（内容迁移前）是否把原技能根整目录备份一份 */
  backup?: {
    enabled?: boolean
    /** 备份存放目录（绝对路径），备份为 <备份目录>\<技能根名>-<时间戳> */
    path?: string
  }
  /** 技能库搜索范围（默认技能名 + 简介都开） */
  search?: {
    /** 按技能名搜索 */
    name?: boolean
    /** 按简介搜索 */
    intro?: boolean
  }
  /** 用户添加的套件市场来源（内置两个在代码里，不入配置） */
  marketplaces?: MarketSource[]
  /**
   * SkillsBot（skillsbot.cn）平台配置。
   * 免登录接入，不涉及账号/token/配额，故此处无凭证字段。
   */
  skillsbot?: {
    /** API 基址覆盖（默认 https://skillsbot.cn/skillv3/api）——站点改域名/前缀时的应急开关 */
    apiBase?: string
    /** 安装时默认覆盖同名技能（默认 true，与 hub:install 一致） */
    replaceByDefault?: boolean
  }
}

/** 技能根的联接状态（与 PowerShell 版 verify.ps1 的状态机一一对应） */
export type JunctionState =
  | 'active' // Junction 且指向共享库
  | 'merged-empty' // 空目录且命中同源组（已归并，verify.ps1 不算失败）
  | 'empty' // 空目录（未命中同源组，verify.ps1 会报不是联接）
  | 'missing' // 目录不存在
  | 'other-link' // 联接但指向别处
  | 'real-dir' // 真实非空目录（未归并）

/** 24 项 Agent 路径预设中的一项 */
export interface AgentPreset {
  key: string
  label: string
  /** 技能根路径；`%USERPROFILE%` / `%LOCALAPPDATA%` / `%APPDATA%` 等占位在运行时展开 */
  path: string
  /** 探测路径：部分软件父目录存在即视为已安装（如 CodeBuddy / WorkBuddy） */
  probePath?: string
  /** 是否动态生成（Marvis 用户 ID 非固定，需按 glob 展开出多个入口） */
  dynamic?: boolean
  /** dynamic 为 true 时的通配路径，`*` 代表可变片段（如用户 ID） */
  glob?: string
  /**
   * 桌面版增强项：PowerShell 版仓库里没有这一条（只存在于桌面程序）。
   * check:tables 的数量与逐项比对会把这类项排除，避免"防漂移"误报。
   */
  desktopOnly?: boolean
}

/** 一个 Agent 的实时状态 */
export interface AgentStatus {
  key: string
  label: string
  path: string
  /** 是否已写入配置 */
  configured: boolean
  /** 软件是否已安装（按探测路径判断） */
  installed: boolean
  state: JunctionState
  /** Junction 指向的目标（仅 active / other-link 时有值） */
  target?: string
  /** 通过该入口可见的 SKILL.md 数量 */
  skillCount: number
}

/** 24 项预设探测的一个条目（detectPresetAgents 输出） */
export interface DetectedAgent extends AgentStatus {
  /** 预设的展示名（一个预设可展开多条，如 Marvis 多用户） */
  presetLabel: string
  /** merged-empty 时命中的同源组名 */
  matchedGroup?: string
  /** 动态预设（glob 展开） */
  dynamic?: boolean
}

/** 同源多根冲突（与 PowerShell 版 duplicate-guard.ps1 语义一致） */
export interface SameSourceConflict {
  name: string
  paths: string[]
}

/** agents:detectPresets 的返回 */
export interface DetectPresetsResult {
  detected: DetectedAgent[]
  conflicts: SameSourceConflict[]
  failCount: number
}

/** 共享库中的一个技能 */
export interface SkillInfo {
  name: string
  category: string
  /** SKILL.md frontmatter 里的原始简介（多为英文） */
  intro: string
  /** _meta.json 里的中文简介 */
  introZh: string
  source?: string
  branch?: string
  commitSha?: string
  installedAt?: string
  translatedAt?: string
  /** _meta.json 里的本地版本号（市场安装的技能常见，仅展示用） */
  version?: string
  /** 套件归属（市场套件或本地自定义套件） */
  package?: { marketplace: string; plugin: string; version?: string }
  /** false = 已停用（位于 skills-disabled 区，Agent 不加载） */
  enabled?: boolean
  /** 技能归属：共享库本体，或某未接入 agent 的原生根 */
  origin?: { kind: 'shared' | 'agent'; key: string; label: string }
}

/** 备份查询结果 */
export interface BackupInfo {
  exists: boolean
  /** 备份目录绝对路径 */
  dir?: string
  createdAt?: string
  sourcePath?: string
}

/** 技能套件市场来源（与 WorkBuddy known_marketplaces 对齐） */
export interface MarketSource {
  name: string
  type: 'git' | 'zip' | 'directory'
  url: string
  /** true = 应用内置（不可删除） */
  builtin?: boolean
}

/** 市场清单里的套件条目（marketplace.json plugins[] 投影） */
export interface MarketPlugin {
  name: string
  description: string
  version?: string
  category?: string
  /** 包含的技能目录名（安装到共享库时用） */
  skillDirs: string[]
}

export interface MarketManifest {
  name: string
  description: string
  source: MarketSource
  plugins: MarketPlugin[]
}

/** P4 联接写操作的日志行（与 PowerShell 脚本输出同款文案，逐条展示给用户） */
export interface OpResult {
  logs: string[]
}

/** 接入前的预案（junction:createPlan 输出，UI 据此做二次确认） */
export type CreateScenario =
  | 'missing' // 目录不存在 → 直接建联接
  | 'already-active' // 已是指向共享库的联接 → 无需处理
  | 'wrong-target' // 联接指向别处 → 需人工处理（阻塞）
  | 'real-dir' // 真实目录 → 迁移内容后建联接
  | 'empty-dir' // 空目录 → 删空目录后建联接
  | 'not-dir' // 是文件 → 阻塞

export interface CreatePlan {
  key: string
  path: string
  sharedRoot: string
  scenario: CreateScenario
  /** already-active / wrong-target 时的联接目标 */
  target?: string
  /** real-dir 时：将迁移的每一项及处理方式 */
  items: { name: string; action: 'move' | 'dedupe' | 'conflict' }[]
  /** 内容冲突数（>0 阻塞建联接，需人工决定保留哪份） */
  conflictCount: number
  /** 同源多根警告（不阻塞，UI 明确提示重复加载风险） */
  duplicateWarnings: SameSourceConflict[]
  blocked: boolean
  blockedReason?: string
}

/** 归并预案里的一条技能根 */
export interface MergePlanHit {
  path: string
  state: JunctionState
  /** 推荐保留（覆盖软件最多的共享根，通常 .agents\skills） */
  recommended: boolean
  /** 该根同时还会被哪些软件读取（按组表反查） */
  alsoReadBy: string[]
}

/** 一个同源组的归并预案（junction:mergePlan 输出；活跃根 >= 2 才出现） */
export interface MergePlan {
  name: string
  hits: MergePlanHit[]
  /** 默认推荐保留的路径 */
  keepPath: string
}

/** 更新检测的四类判定（与 PowerShell 版一致） */
export type UpdateState = 'up-to-date' | 'has-update' | 'no-baseline' | 'unavailable'

/** 单个来源仓库的更新检测判定（check-updates.ps1 的六种细分状态） */
export type RepoUpdateState = 'latest' | 'update' | 'no-baseline' | 'rate-limited' | 'gone' | 'error'

export interface RepoUpdateInfo {
  /** owner/repo */
  repo: string
  /** 该仓库装进共享库的技能名列表（同仓库多技能共用一个基准） */
  skills: string[]
  state: RepoUpdateState
  localSha?: string
  remoteSha?: string
}

/** updates:checkSkills 的返回 */
export interface CheckUpdatesResult {
  repos: RepoUpdateInfo[]
  /** 无 GitHub 来源的技能（迁移/手动放置/市场安装），仅展示本地版本 */
  noSource: { name: string; version?: string }[]
}

/** 工具自身更新检测（check-project-updates.ps1 四类判定） */
export interface ToolUpdateInfo {
  state: UpdateState
  localVersion: string
  remoteVersion?: string
  /** unavailable 时的原因（auth / notfound / net） */
  reason?: string
}

/** GitHub 仓库搜索结果（skills:searchRepos 输出） */
export interface RepoSearchResult {
  /** owner/repo */
  repo: string
  description: string
  stars: number
  url: string
}

/** SkillHub 平台分类（api.skillhub.cn /api/v1/categories） */
export interface HubCategory {
  key: string
  name: string
}

/** SkillHub 技能列表项（/api/skills 投影） */
export interface HubSkill {
  slug: string
  /** namespace handle，如 indiv-ebandao */
  namespace: string
  name: string
  /** 平台英文分类 key */
  category: string
  /** 平台中文分类名 */
  categoryName: string
  description: string
  downloads: number
  installs: number
  stars: number
  verified: boolean
  version: string
  iconUrl?: string
  updatedAt: number
  /** 详情页链接 */
  hubUrl: string
}

export interface HubListResult {
  skills: HubSkill[]
  total: number
  page: number
}

/** SkillHub 技能详情（/api/v1/skills/{slug} 投影） */
export interface HubSkillDetail extends HubSkill {
  /** 中文摘要 */
  summary: string
  /** README 全文（可能为空） */
  overviewMd: string
  createdAt: number
  versionsCount: number
  filesCount: number
  /** GitHub 上游链接（有则可直接从 GitHub 安装并建更新基准） */
  upstreamUrl?: string
  /** 需配置 API Key */
  requiresApiKey: boolean
}

export interface HubInstallOptions {
  /** 同名技能已存在时覆盖（默认 true） */
  replace?: boolean
}

/** 工具的历史发布记录（GitHub Releases，用于展示更新说明 / 更新日志） */
export interface ToolReleaseInfo {
  tagName: string
  name: string
  date: string
  body: string
  url: string
}

/** electron-updater 下载进度（update-progress 事件负载） */
export interface UpdateDownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface SkillUpdateInfo extends SkillInfo {
  state: UpdateState
  remoteSha?: string
}

/** 路由技能写入目标：一个 Agent 的技能根（也就是它实际加载技能的位置） */
export interface RouterTarget {
  key: string
  label: string
  root: string
  /** 技能根目录存在 */
  exists: boolean
  /** 是指向共享库的联接（此时该根与共享库是同一份物理文件） */
  isSharedLink: boolean
  /** 该根下实际可见的技能数（不含路由技能自身） */
  skillCount: number
  /** 来自 config.agents（用户在应用里接入过的） */
  configured: boolean
}

// ---------- SkillsBot（skillsbot.cn，免登录接入） ----------

/**
 * 免登录完整性预判结果。
 * 站点把技能打包成 zip，但 zip 下载需要登录 token，免登录只能拿到 SKILL.md 正文。
 * 这里用公开的 fileSize 与正文长度做比值，判断包内是否还有附加文件。
 */
export type BotCompleteness =
  /** 正文即全部内容 → 落盘等于完整安装 */
  | 'md-only'
  /** 包内含附加文件（脚本/词表/配置）→ 免登录安装不含它们 */
  | 'has-extras'
  /** fileSize 或正文缺失，无法判断 */
  | 'unknown'

/** SkillsBot 分类节点（/category/list 返回两级嵌套树） */
export interface BotCategory {
  id: number
  name: string
  code?: string | null
  icon?: string | null
  parentId: number
  sortOrder?: number
  /** 站点存在两套分类体系（1 = 常规，2 = 物理 AI）；列表请求的 type 应跟随所选节点 */
  type: number
  children?: BotCategory[]
}

/** SkillsBot 技能（列表 / 详情共用的投影，字段名对齐站点真实 API） */
export interface BotSkill {
  /**
   * 站点雪花 ID。19 位，超出 JS 安全整数范围（2^53），
   * 接口本身以字符串序列化 → 全链路必须保持字符串，禁止任何数值转换。
   */
  id: string
  name: string
  enName: string
  description: string
  categoryId: number
  categoryName: string
  parentCategoryId?: number | null
  parentCategoryName?: string | null
  version?: number | null
  /** 作者名（实测不是 GitHub 仓库名，不可用于拼仓库地址） */
  githubProjectName?: string | null
  originalName?: string | null
  /** 形如 blog/2026/02/23/<md5>.zip；实测拼静态路径全部 404，仅用于体积判断 */
  fileName?: string | null
  /** zip 包字节数，用于完整性预判 */
  fileSize?: number | null
  viewCount: number
  downloadCount: number
  type?: number | null
  createTime?: string | null
  updateTime?: string | null
  /** 站点详情页：https://skillsbot.cn/skill/{id} */
  botUrl: string
  /** 免登录完整性预判 */
  completeness: BotCompleteness
  /** 已在共享库中安装（按 _meta.json 的 source 匹配） */
  installed?: boolean
}

/** 技能详情（含完整 SKILL.md 正文） */
export interface BotSkillDetail extends BotSkill {
  /** ★ 完整 SKILL.md 原文（含 YAML frontmatter）——免登录安装的数据来源 */
  detail: string
  /** 英文正文（实测 48/48 抽样全为 null，仅作兜底） */
  enDetail?: string | null
  /** 实测恒为 null，拿不到直链 */
  fileUrl?: string | null
  /** 正文里引用的相对路径文件（这些是免登录拿不到的附加文件） */
  missingRefs: string[]
  /** 正文是否来自字面量 \n 转义后的还原 */
  unescaped: boolean
}

export interface BotListResult {
  skills: BotSkill[]
  /** 站点未确认 total 字段名，取不到时为 -1 */
  total: number
  page: number
  /** 站点服务端固定每页 12 条，hasMore 按「本页是否满页」判定 */
  hasMore: boolean
}

export interface BotInstallOptions {
  /** 同名技能已存在时覆盖（默认取 config.skillsbot.replaceByDefault ?? true） */
  replace?: boolean
}

/** 免登录安装结果 */
export interface BotInstallResult extends OpResult {
  skillName: string
  destDir: string
  /** 免登录唯一安装模式 */
  mode: 'markdown'
  /** 免登录装不全（含附加文件） */
  incomplete: boolean
  completeness: BotCompleteness
  /** 免登录拿不到的附加文件清单 */
  missingRefs: string[]
}

/** SkillsBot 结构化错误码（IpcResult.code 透出，UI 据此分流） */
export type BotErrorCode =
  /** 技能不存在 */
  | 'notfound'
  /** HTTP 非 200 / 超时 / TLS / 非 JSON */
  | 'network'
  /** 平台返回非 20000 的业务错误 */
  | 'api'
  /** 命中 honeypot 反爬路径（结构性防御，正常不应出现） */
  | 'honeypot'

/** 所有 IPC 的统一返回结构 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }
