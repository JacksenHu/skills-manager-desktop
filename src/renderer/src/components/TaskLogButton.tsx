import { useMemo, useState } from 'react'
import { RefreshCw, ScrollText } from 'lucide-react'
import { Modal } from './Modal'
import { useRunningTaskCount, useTaskLog, type TaskLogEntry } from '../store/taskLog'

/** 时间戳 -> HH:MM:SS */
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 耗时展示（进行中 / 秒 / 分秒） */
function fmtDuration(start: number, end?: number): string {
  if (!end) return '进行中'
  const s = (end - start) / 1000
  if (s < 1) return '<1s'
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

/** 状态指示：进行中转圈 / 成功绿点 / 失败红点（不用图标库，避免版本差异） */
function StatusDot({ status }: { status: TaskLogEntry['status'] }) {
  if (status === 'running') {
    return <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
  }
  return (
    <span
      className={
        'mt-1 h-2 w-2 shrink-0 rounded-full ' +
        (status === 'ok' ? 'bg-emerald-500' : 'bg-red-500')
      }
    />
  )
}

/**
 * 顶栏「任务日志」按钮：图标上带进行中数量徽标，点开看全部操作日志。
 * 数据来自全局 taskLog store —— 各面板执行操作时登记，这里只读。
 */
export function TaskLogButton() {
  const tasks = useTaskLog((s) => s.tasks)
  const running = useRunningTaskCount()
  const clearFinished = useTaskLog((s) => s.clearFinished)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const finishedCount = useMemo(() => tasks.filter((t) => t.status !== 'running').length, [tasks])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={
          running > 0
            ? `任务日志：${running} 个进行中`
            : tasks.length > 0
              ? `任务日志（${tasks.length} 条记录）`
              : '任务日志：暂无记录'
        }
        className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800/70"
      >
        <ScrollText className={`h-4 w-4 ${running > 0 ? 'text-sky-500' : ''}`} />
        {running > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
            {running > 99 ? '99+' : running}
          </span>
        )}
      </button>

      {open && (
        <Modal title="任务日志" onClose={() => setOpen(false)} width="max-w-2xl">
          <div className="mb-3 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>
              共 {tasks.length} 条
              {running > 0 && <span className="ml-1 text-sky-500">· {running} 个进行中</span>}
            </span>
            <button
              onClick={() => clearFinished()}
              disabled={finishedCount === 0}
              className="rounded px-2 py-0.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800"
            >
              清空已完成（{finishedCount}）
            </button>
          </div>

          {tasks.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">
              还没有记录。安装 / 移除技能、建拆联接、检查更新等操作都会记在这里。
            </div>
          ) : (
            <div className="space-y-1.5">
              {tasks.map((t) => {
                const isOpen = expanded === t.id || (t.status === 'running' && expanded === null)
                const lines = t.status === 'error' ? [t.error ?? '未知错误'] : t.logs
                return (
                  <div
                    key={t.id}
                    className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
                  >
                    <div className="flex items-start gap-2">
                      <StatusDot status={t.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm">{t.title}</span>
                          <span className="shrink-0 rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-500 dark:text-slate-400">
                            {t.scope}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                          {fmtTime(t.startedAt)} · {fmtDuration(t.startedAt, t.endedAt)}
                          {t.status === 'error' && (
                            <span className="ml-1 text-red-400">失败</span>
                          )}
                        </div>
                      </div>
                      {lines.length > 0 && (
                        <button
                          onClick={() => setExpanded(isOpen ? '' : t.id)}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {isOpen ? '收起' : `日志(${lines.length})`}
                        </button>
                      )}
                      {t.status === 'running' && lines.length === 0 && (
                        <span className="shrink-0 text-[11px] text-sky-500">执行中…</span>
                      )}
                    </div>

                    {isOpen && lines.length > 0 && (
                      <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2 font-mono text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {lines.join('\n')}
                      </pre>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}

/** 供其它组件内联用的小圆点（导出避免重复实现） */
export function TaskStatusDot({ status }: { status: TaskLogEntry['status'] }) {
  return <StatusDot status={status} />
}
