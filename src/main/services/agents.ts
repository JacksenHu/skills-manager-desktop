import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus, AppConfig, JunctionState } from '@shared/types'

/**
 * 判断一个技能根的联接状态。
 * 与 PowerShell 版 merge-agent-roots.ps1 的 Get-RootState 状态机一一对应。
 */
export function junctionState(
  path: string,
  sharedRoot: string
): { state: JunctionState; target?: string } {
  if (!existsSync(path)) return { state: 'missing' }

  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { state: 'missing' }
  }

  // Windows Junction 在 Node 里表现为符号链接
  if (stat.isSymbolicLink()) {
    let target: string | undefined
    try {
      target = readlinkSync(path)
    } catch {
      target = undefined
    }
    if (target && normalize(target) === normalize(sharedRoot)) {
      return { state: 'active', target }
    }
    return { state: 'other-link', target }
  }

  if (!stat.isDirectory()) return { state: 'other-link' }

  try {
    return readdirSync(path).length === 0 ? { state: 'empty' } : { state: 'real-dir' }
  } catch {
    return { state: 'missing' }
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 递归统计可见的 SKILL.md 数量（限深度，避免在大库上卡死） */
export function countSkillFiles(root: string, maxDepth = 4): number {
  let total = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        // 不穿透 Junction 递归（共享库内部可能还有联接）
        if (st.isSymbolicLink()) continue
        walk(full, depth + 1)
      } else if (name.toLowerCase() === 'skill.md') {
        total++
      }
    }
  }
  walk(root, 0)
  return total
}

/** 列出配置中各 Agent 的实时状态（只读，不修改任何东西） */
export function listAgentStatus(config: AppConfig): AgentStatus[] {
  const sharedRoot = config.sharedRoot
  return Object.keys(config.agents)
    .sort()
    .map((key) => {
      const path = config.agents[key]
      const { state, target } = junctionState(path, sharedRoot)
      const skillCount = state === 'active' ? countSkillFiles(path) : 0
      return {
        key,
        label: key,
        path,
        configured: true,
        installed: existsSync(path),
        state,
        target,
        skillCount
      }
    })
}
