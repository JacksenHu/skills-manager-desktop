import { existsSync } from 'node:fs'
import type { AgentStatus, AppConfig } from '@shared/types'
import { classifyJunction, loadSameSourceGroups } from './junction-state'
import { toJunctionState } from './state-map'

/** 列出配置中各 Agent 的实时状态（只读，不修改任何东西） */
export function listAgentStatus(config: AppConfig): AgentStatus[] {
  const sharedRoot = config.sharedRoot
  const groups = loadSameSourceGroups()
  return Object.keys(config.agents)
    .sort()
    .map((key) => {
      const path = config.agents[key]
      const result = classifyJunction(path, sharedRoot, groups)
      return {
        key,
        label: key,
        path,
        configured: true,
        installed: existsSync(path),
        state: toJunctionState(result.verdict),
        target: result.target,
        skillCount: result.skillCount
      }
    })
}
