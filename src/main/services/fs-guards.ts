import { lstatSync, readlinkSync } from 'node:fs'

/**
 * 文件系统安全守卫（从 junction-write.ts 抽出，供 backup/skills/junction-write 共用，
 * 避免循环依赖）。全项目唯一允许递归删除的入口：任何 rmSync(recursive) 前必须先过
 * assertRealDir —— 违反即抛错，宁可失败也绝不穿透联接删共享库。
 */

export function isJunction(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export function junctionTarget(path: string): string {
  try {
    return readlinkSync(path)
  } catch {
    return ''
  }
}

export function assertRealDir(path: string): void {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) {
    throw new Error(`安全守卫：${path} 是联接，禁止递归删除（会穿透到共享库）`)
  }
  if (!st.isDirectory()) {
    throw new Error(`安全守卫：${path} 不是目录，禁止递归删除`)
  }
}
