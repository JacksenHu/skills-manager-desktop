import { FolderOpen, Link2Off, Pencil, Plug } from 'lucide-react'
import type { AgentStatus, JunctionState } from '@shared/types'

export const STATE_META: Record<JunctionState, { label: string; cls: string }> = {
  active: { label: '已接入', cls: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30' },
  'merged-empty': { label: '已归并', cls: 'bg-amber-500/15 text-amber-400 ring-amber-500/30' },
  empty: { label: '空目录', cls: 'bg-orange-500/15 text-orange-400 ring-orange-500/30' },
  missing: { label: '不存在', cls: 'bg-slate-500/15 text-slate-400 ring-slate-500/30' },
  'other-link': { label: '指向他处', cls: 'bg-red-500/15 text-red-400 ring-red-500/30' },
  'real-dir': { label: '未联接', cls: 'bg-orange-500/15 text-orange-400 ring-orange-500/30' }
}

/** 可发起「接入」的状态：缺失 / 空目录 / 真实目录 / 已归并（重新接入=取消归并） */
export const CAN_CONNECT: JunctionState[] = ['missing', 'empty', 'real-dir', 'merged-empty']

export function AgentCard({
  agent,
  onConnect,
  onRemove,
  onEdit
}: {
  agent: AgentStatus & { presetLabel?: string; configured?: boolean; dynamic?: boolean }
  onConnect?: (key: string, path: string, dynamic?: boolean) => void
  onRemove?: (key: string) => void
  onEdit?: (key: string) => void
}) {
  const meta = STATE_META[agent.state]
  // 活跃但未配置的入口（如历史联接）也允许"接入"——预案会识别为 already-active，只写配置
  const canConnect =
    onConnect && (CAN_CONNECT.includes(agent.state) || (agent.state === 'active' && agent.configured === false))
  const canRemove = onRemove && agent.state === 'active' && agent.configured

  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 truncate font-medium">
            {agent.presetLabel ?? agent.label}
            {agent.configured !== undefined && (
              <span
                className={
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] ' +
                  (agent.configured
                    ? 'bg-sky-500/15 text-sky-500'
                    : 'bg-slate-500/10 text-slate-400')
                }
              >
                {agent.configured ? '已配置' : '未配置'}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{agent.path}</div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${meta.cls}`}>{meta.label}</span>
      </div>

      <div className="mt-3 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span>
          {agent.state === 'active'
            ? `${agent.skillCount} 个技能可见`
            : agent.state === 'merged-empty'
              ? '已归并，软件不再重复加载'
              : '—'}
        </span>

        <div className="ml-auto flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
          {canConnect && (
            <button
              onClick={() => onConnect?.(agent.key, agent.path)}
              title={
                agent.state === 'merged-empty'
                  ? '重新接入（取消归并，注意重复加载风险）'
                  : '接入共享库'
              }
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-sky-500/10 hover:text-sky-500"
            >
              <Plug className="h-3.5 w-3.5" />
              接入
            </button>
          )}
          {canRemove && (
            <button
              onClick={() => onRemove?.(agent.key)}
              title="拆除联接（共享库数据保留）"
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-red-500/10 hover:text-red-400"
            >
              <Link2Off className="h-3.5 w-3.5" />
              拆除
            </button>
          )}
          {agent.state === 'other-link' && (
            <span className="text-red-400/80">联接指向别处，请人工处理</span>
          )}
          {onEdit && agent.configured && (
            <button
              onClick={() => onEdit(agent.key)}
              title="修改标识名 / 路径（只改配置）"
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </button>
          )}
          <button
            onClick={() => void window.api.app.openPath(agent.path)}
            title="打开目录"
            className="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
