import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AppConfig } from '@shared/types'

/** 配置文件放在 Electron 的 userData 目录，与 PowerShell 版仓库完全解耦 */

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function defaultConfig(): AppConfig {
  const sharedRoot = join(homedir(), 'skills', 'shared')
  return {
    sharedRoot,
    agents: {},
    ui: { theme: 'system' },
    net: {},
    // 接入备份默认开启，备份区与共享库同父目录（默认同盘，复制可靠）
    backup: { enabled: true, path: join(dirname(sharedRoot), 'skills-backup') }
  }
}

export function loadConfig(): AppConfig {
  const p = configPath()
  if (!existsSync(p)) return defaultConfig()
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<AppConfig>
    return {
      ...defaultConfig(),
      ...parsed,
      ui: { ...defaultConfig().ui, ...(parsed.ui ?? {}) },
      // backup 深合并：老配置里 backup:{enabled:false}（无 path）不吃掉默认路径
      backup: { ...defaultConfig().backup, ...(parsed.backup ?? {}) }
    }
  } catch {
    // 配置文件损坏时回退默认值，不阻断启动
    return defaultConfig()
  }
}

/** 原子写：先写 .tmp 再改名，避免写一半崩溃导致配置丢失 */
export function saveConfig(config: AppConfig): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
  renameSync(tmp, p)
}
