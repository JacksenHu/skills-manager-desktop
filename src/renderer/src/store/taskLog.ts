import { create } from 'zustand'

/**
 * 全局任务日志中心（zustand）。
 *
 * 背景：各面板原来各自用 useState 存一份 result，弹出 ResultModal 就丢了，
 * 用户看不到"刚才装了什么、有没有失败、还有几个在跑"。
 * 这里把所有会改本机环境的操作统一登记：进行中 -> 成功 / 失败，
 * 顶栏日志按钮读它显示历史 + 进行中数量徽标。
 *
 * 约定：能拿到 logs 的走 start/finish（有"进行中"过程）；
 * 纯本地瞬时操作或探测类直接 push（直接落一条已完成记录）。
 */

export type TaskStatus = 'running' | 'ok' | 'error'

export interface TaskLogEntry {
  id: string
  /** 操作名（如「安装技能：xxx」），展示在日志列表里 */
  title: string
  /** 来源面板，便于在日志里区分（技能库 / 市场 / 联接 / 更新） */
  scope: string
  status: TaskStatus
  startedAt: number
  endedAt?: number
  /** PowerShell 脚本同款日志行（成功时有值） */
  logs: string[]
  /** 失败原因（status === 'error' 时有值） */
  error?: string
}

/** 最多保留的日志条数（防止长时间运行无限增长） */
const MAX_ENTRIES = 200

let seq = 0
function nextId(): string {
  seq += 1
  return `${Date.now().toString(36)}-${seq}`
}

interface TaskLogState {
  tasks: TaskLogEntry[]
  /** 开始一个任务，返回 id（后续用 finish / fail 收尾） */
  start: (title: string, scope?: string) => string
  /** 任务成功：写入日志行 */
  finish: (id: string, logs: string[]) => void
  /** 任务失败：写入错误 */
  fail: (id: string, error: string) => void
  /** 直接记一条已完成任务（无进行中过程） */
  push: (title: string, logs: string[], scope?: string) => void
  /** 清掉已结束的记录，进行中的保留 */
  clearFinished: () => void
}

export const useTaskLog = create<TaskLogState>((set) => ({
  tasks: [],

  start: (title, scope = '其他') => {
    const id = nextId()
    set((s) => ({
      tasks: [
        { id, title, scope, status: 'running', startedAt: Date.now(), logs: [] },
        ...s.tasks
      ].slice(0, MAX_ENTRIES)
    }))
    return id
  },

  finish: (id, logs) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, status: 'ok' as const, logs, endedAt: Date.now() } : t
      )
    })),

  fail: (id, error) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? { ...t, status: 'error' as const, error, endedAt: Date.now() }
          : t
      )
    })),

  push: (title, logs, scope = '其他') =>
    set((s) => ({
      tasks: [
        {
          id: nextId(),
          title,
          scope,
          status: 'ok' as const,
          startedAt: Date.now(),
          endedAt: Date.now(),
          logs
        },
        ...s.tasks
      ].slice(0, MAX_ENTRIES)
    })),

  clearFinished: () => set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'running') }))
}))

/** 进行中的任务数（顶栏徽标用） */
export function useRunningTaskCount(): number {
  return useTaskLog((s) => s.tasks.reduce((n, t) => (t.status === 'running' ? n + 1 : n), 0))
}

/**
 * 统一执行模板：登记进行中 → 成功写日志（自动从返回值里取 logs）/ 失败写错误。
 * 返回是否成功，调用方据此决定要不要弹 ResultModal / 刷新列表。
 */
export async function runLoggedTask<T>(
  title: string,
  scope: string,
  run: () => Promise<T>
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { start, finish, fail } = useTaskLog.getState()
  const id = start(title, scope)
  try {
    const data = await run()
    const logs = (data as { logs?: string[] } | null | undefined)?.logs
    finish(id, Array.isArray(logs) ? logs : [])
    return { ok: true, data }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fail(id, msg)
    return { ok: false, error: msg }
  }
}

/** 把 IPC 的 IpcResult 拆成"成功取 data / 失败抛错"，配合 runLoggedTask 用 */
export function unwrapIpc<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error)
  return r.data
}
