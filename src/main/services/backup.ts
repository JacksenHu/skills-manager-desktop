import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AppConfig, BackupInfo } from '@shared/types'
import { assertRealDir, isJunction } from './fs-guards'

/**
 * P13 接入备份：接入（real-dir 内容迁移前）自动把原技能根整目录留底。
 *
 * 目录结构：<backupRoot>/<basename(path)>-<14位时间戳>/...，目录内附
 * _backup.json {sourcePath, createdAt}——跨 agent basename 撞名（多数
 * agent 根都叫 skills）时按 marker 精确匹配最近备份，旧备份（无 marker）
 * 回退前缀匹配。
 *
 * 恢复：若 path 是共享库联接先拆联接（rmdirSync 只删重解析点）；若 path
 * 是真实非空目录拒绝（避免合并覆盖），提示人工处理。
 */

export function defaultBackupRoot(sharedRoot: string): string {
  return join(dirname(sharedRoot), 'skills-backup')
}

function backupRoot(config: AppConfig): string {
  return config.backup?.path?.trim() || defaultBackupRoot(config.sharedRoot)
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/** 迁移前留底：整目录复制到备份区 + 写 _backup.json marker。失败抛错（中止接入）。 */
export function createBackup(path: string, config: AppConfig): string | null {
  const cfg = config.backup
  if (cfg && cfg.enabled === false) return null // 用户显式关闭
  const root = backupRoot(config)
  if (root.toLowerCase().startsWith(path.toLowerCase() + '\\') || root.toLowerCase() === path.toLowerCase()) {
    throw new Error(`备份目录 ${root} 不能位于被备份路径 ${path} 内`)
  }
  const dest = join(root, `${basename(path)}-${stamp()}`)
  mkdirSync(root, { recursive: true })
  cpSync(path, dest, { recursive: true })
  writeFileSync(
    join(dest, '_backup.json'),
    JSON.stringify({ sourcePath: path, createdAt: new Date().toISOString() }, null, 2),
    'utf8'
  )
  return dest
}

/** 读备份 marker（旧备份无 marker 返回 null） */
function readMarker(dir: string): { sourcePath?: string; createdAt?: string } | null {
  try {
    return JSON.parse(readFileSync(join(dir, '_backup.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 该技能根的最近一次备份（marker 精确匹配优先，无 marker 回退前缀匹配） */
export function backupLatest(path: string, config: AppConfig): BackupInfo {
  const root = backupRoot(config)
  const prefix = `${basename(path)}-`
  if (!existsSync(root)) return { exists: false }
  let best: { dir: string; createdAt: string } | null = null
  let fallback: { dir: string; createdAt: string } | null = null
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue
    const dir = join(root, e.name)
    const marker = readMarker(dir)
    if (marker?.sourcePath && marker.sourcePath.toLowerCase() === path.toLowerCase()) {
      const createdAt = marker.createdAt ?? ''
      if (!best || createdAt > best.createdAt) best = { dir, createdAt }
    } else if (!marker) {
      // 旧备份无 marker：按目录名时间戳回退
      const ts = e.name.slice(prefix.length)
      if (!fallback || ts > fallback.createdAt) fallback = { dir, createdAt: ts }
    }
  }
  const hit = best ?? fallback
  if (!hit) return { exists: false }
  return { exists: true, dir: hit.dir, createdAt: hit.createdAt || undefined }
}

/**
 * 恢复备份到原技能根：
 * - path 是共享库联接 → 先拆联接（rmdirSync 只删重解析点，共享库数据不动）
 * - path 是真实非空目录 → 拒绝（避免合并覆盖），提示人工处理
 * - path 不存在 → 直接还原
 * 恢复后 agent 配置条目保留，探测状态自然回到 real-dir（未接入）。
 */
export function restoreBackup(path: string, config: AppConfig): { logs: string[] } {
  const info = backupLatest(path, config)
  if (!info.exists || !info.dir) throw new Error('未找到该技能根的备份')
  const logs: string[] = [`恢复备份: ${info.dir} -> ${path}`]

  if (isJunction(path)) {
    rmdirSync(path) // 只删联接点
    logs.push('已拆除指向共享库的联接（共享库数据不受影响）')
  } else if (existsSync(path)) {
    let empty = false
    try {
      empty = readdirSync(path).length === 0
    } catch {
      empty = false
    }
    if (!empty) {
      throw new Error(`目标路径 ${path} 已存在非空真实目录，为避免覆盖请先手动处理`)
    }
    rmdirSync(path)
  }

  mkdirSync(dirname(path), { recursive: true })
  cpSync(info.dir, path, { recursive: true })
  // 恢复产物不是备份副本，去掉 marker 与目录的备份命名痕迹（保留内容）
  try {
    rmSync(join(path, '_backup.json'), { force: true })
  } catch {
    // 忽略
  }
  logs.push(`[OK] 备份已还原为真实技能根（未接入状态，可重新接入或直接使用）`)
  return { logs }
}
