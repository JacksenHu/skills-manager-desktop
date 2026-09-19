import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import agentPresetsJson from '@shared/data/agent-presets.json'
import type { AgentPreset, AppConfig, DetectedAgent } from '@shared/types'
import { classifyJunction, loadSameSourceGroups } from './junction-state'
import { toJunctionState } from './state-map'

export const AGENT_PRESETS = agentPresetsJson.presets as AgentPreset[]

/** 展开 %USERPROFILE% / %LOCALAPPDATA% / %APPDATA% 等环境变量占位（Windows 上 env key 大小写不敏感） */
export function expandPath(p: string): string {
  // APPDATA / LOCALAPPDATA 在某些精简环境（如 CI 沙箱）缺失，从 USERPROFILE 推导兜底
  const profile = process.env.USERPROFILE ?? ''
  const env = new Map(Object.entries(process.env))
  if (!env.has('APPDATA') && profile) env.set('APPDATA', join(profile, 'AppData', 'Roaming'))
  if (!env.has('LOCALAPPDATA') && profile) env.set('LOCALAPPDATA', join(profile, 'AppData', 'Local'))
  return p.replace(/%([^%]+)%/g, (raw, name: string) => env.get(name) ?? raw)
}

/**
 * 展开动态预设的 glob（目前只有 Marvis：`%APPDATA%\Tencent\Marvis\User\*\skills\custom`）。
 * 只支持「父目录下一层 * 」的形态：取第一个 * 前的固定父目录，把每个子目录名代入 *
 * 位置得到完整路径，再验存在（glob 的 * 之后还有 \skills\custom 这类固定后缀）。
 */
export function expandPresetGlob(glob: string): string[] {
  const expanded = expandPath(glob)
  if (!expanded.includes('*')) return existsSync(expanded) ? [expanded] : []

  const firstStar = expanded.indexOf('*')
  const baseDir = expanded.slice(0, expanded.lastIndexOf('\\', firstStar))
  if (!existsSync(baseDir)) return []

  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => expanded.replace('*', e.name))
    .filter((full) => existsSync(full))
    .sort()
}

/**
 * 24 项预设全量探测（只读）。
 * - 静态项：每项一行；目录不存在也出（missing），保持与 verify.ps1 逐条可对照
 * - 动态项（Marvis）：按 glob 展开出 0..N 行；无命中时出一行 missing 占位
 * - installed：有 probePath 时父目录存在即视为已装（setup-wizard 同语义），否则看技能根本身
 */
export function detectPresetAgents(config: AppConfig): DetectedAgent[] {
  const groups = loadSameSourceGroups()
  const out: DetectedAgent[] = []

  for (const preset of AGENT_PRESETS) {
    const paths =
      preset.dynamic && preset.glob ? expandPresetGlob(preset.glob) : [expandPath(preset.path)]

    if (paths.length === 0) {
      // 动态项无命中：出一行占位，UI 上仍可见该预设存在
      out.push({
        key: preset.key,
        presetLabel: preset.label,
        label: preset.label,
        path: expandPath(preset.path),
        configured: false,
        installed: false,
        state: 'missing',
        skillCount: 0,
        dynamic: true
      })
      continue
    }

    for (const path of paths) {
      const result = classifyJunction(path, config.sharedRoot, groups)
      const installed = preset.probePath
        ? existsSync(expandPath(preset.probePath))
        : existsSync(path)
      // 动态预设（Marvis 多用户）接入时配置键会派生为 `${key}-<用户ID>`（App.startConnect 同规则），
      // 这里反查实际配置键，保证 configured 判定与「拆除」操作用的是真实键名
      let key = preset.key
      if (preset.dynamic) {
        const hit = Object.entries(config.agents).find(
          ([, p]) => p.toLowerCase() === path.toLowerCase()
        )
        if (hit) key = hit[0]
      }
      const configured = preset.dynamic
        ? Object.values(config.agents).some((p) => p.toLowerCase() === path.toLowerCase())
        : config.agents[preset.key] === path
      out.push({
        key,
        presetLabel: preset.label,
        label: preset.label,
        path,
        configured,
        installed,
        state: toJunctionState(result.verdict),
        target: result.target,
        skillCount: result.skillCount,
        matchedGroup: result.matchedGroup,
        dynamic: preset.dynamic
      })
    }
  }

  return out
}
