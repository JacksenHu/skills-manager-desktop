/** 主进程与渲染进程共用的类型定义 */

/** 应用配置（对应 PowerShell 版的 config\agents.json，但存放位置独立） */
export interface AppConfig {
  /** 共享技能库绝对路径（所有 Junction 的目标） */
  sharedRoot: string
  /** key 仅作标识与展示，value 是技能根绝对路径 */
  agents: Record<string, string>
  ui?: {
    theme?: 'system' | 'light' | 'dark'
  }
  net?: {
    /** GitHub Token，可选，仅用于提高 API 配额 */
    token?: string
    /** 是否允许对 GitHub 域放宽 TLS 校验（本机代理根证书不在 Node CA 库时的兜底） */
    allowInsecureTls?: boolean
  }
}

/** 技能根的联接状态（与 PowerShell 版 verify.ps1 的状态机一一对应） */
export type JunctionState =
  | 'active' // Junction 且指向共享库
  | 'empty' // 空目录（已归并）
  | 'missing' // 目录不存在
  | 'other-link' // 联接但指向别处
  | 'real-dir' // 真实非空目录（未归并）

/** 24 项 Agent 路径预设中的一项 */
export interface AgentPreset {
  key: string
  label: string
  /** 技能根路径（可能含 %USERPROFILE% 等占位，运行时展开） */
  path: string
  /** 探测路径：部分软件父目录存在即视为已安装（如 CodeBuddy / WorkBuddy） */
  probePath?: string
  /** 是否动态生成（Marvis 用户 ID 非固定） */
  dynamic?: boolean
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
}

/** 更新检测的四类判定（与 PowerShell 版一致） */
export type UpdateState = 'up-to-date' | 'has-update' | 'no-baseline' | 'unavailable'

export interface SkillUpdateInfo extends SkillInfo {
  state: UpdateState
  remoteSha?: string
}

/** 所有 IPC 的统一返回结构 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
