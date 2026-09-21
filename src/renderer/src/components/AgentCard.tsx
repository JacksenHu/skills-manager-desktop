import { useState } from 'react'
import { FolderOpen, Link2Off, Pencil, Plug, RotateCcw, Save, X } from 'lucide-react'
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
  onSaveEdit,
  onRestore
}: {
  agent: AgentStatus & { presetLabel?: string; configured?: boolean; dynamic?: boolean }
  onConnect?: (key: string, path: string, dynamic?: boolean) => void
  onRemove?: (key: string) => void
  /** inline 编辑保存：改名 = upsert 新键 + 删旧键；未配置预设项保存即创建自定义配置 */
  onSaveEdit?: (oldKey: string, newKey: string, newPath: string) => void
  /** 恢复备份（hasBackup=false 时调用方提示未找到备份） */
  onRestore?: (path: string, hasBackup: boolean) => void
}) {
  const meta = STATE_META[agent.state]
  const [editing, setEditing] = useState(false)
  const [editKey, setEditKey] = useState(agent.key)
  const [editPath, setEditPath] = useState(agent.path)
  const [checkingRestore, setCheckingRestore] = useState(false)

  // 活跃但未配置的入口（如历史联接）也允许"接入"——预案会识别为 already-active，只写配置
  const canConnect =
    onConnect && (CAN_CONNECT.includes(agent.state) || (agent.state === 'active' && agent.configured === false))
  const canRemove = onRemove && agent.state === 'active' && agent.configured

  const saveEdit = () => {
    const nk = editKey.trim()
    const np = editPath.trim()
    if (!nk || !np) return
    onSaveEdit?.(agent.key, nk, np)
    setEditing(false)
  }

  const askRestore = async () => {
    setCheckingRestore(true)
    try {
      const r = (await window.api.backup.latest(agent.path)) as { ok: boolean; data?: { exists: boolean } }
      onRestore?.(agent.path, Boolean(r.ok && r.data?.exists))
    } finally {
      setCheckingRestore(false)
    }
  }

  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 dark:border-slate-800 dark:bg-slate-900">
      {editing ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={editKey}
              onChange={(e) => setEditKey(e.target.value)}
              placeholder="标识名（如 claude-code）"
              className="w-36 rounded-lg border border-sky-400 bg-transparent px-2.5 py-1.5 text-xs outline-none dark:border-sky-600"
            />
            <span className="text-[10px] text-slate-400">标识名 / 路径</span>
            <div className="ml-auto flex gap-1">
              <button
                onClick={saveEdit}
                title="保存配置"
                className="rounded p-1.5 text-emerald-500 hover:bg-emerald-500/10"
              >
                <Save className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setEditing(false)}
                title="取消"
                className="rounded p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <input
            value={editPath}
            onChange={(e) => setEditPath(e.target.value)}
            placeholder="技能根路径（绝对路径）"
            className="w-full rounded-lg border border-sky-400 bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none dark:border-sky-600"
          />
          <div className="text-[10px] text-slate-400">
            只写配置表，不动磁盘联接。改标识名会移除旧配置项；未配置预设保存后即成为自定义配置。
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 truncate font-medium">
              {agent.presetLabel ?? agent.label}
              {agent.configured !== undefined && (
                <span
                  className={
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] ' +
                    (agent.configured ? 'bg-sky-500/15 text-sky-500' : 'bg-slate-500/10 text-slate-400')
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
      )}

      <div className="mt-3 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span>
          {agent.state === 'active'
            ? `${agent.skillCount} 个技能可见`
            : agent.state === 'merged-empty'
              ? '已归并，软件不再重复加载'
              : '—'}
        </span>

        <div className="ml-auto flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
          {canConnect && !editing && (
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
          {canRemove && !editing && (
            <button
              onClick={() => onRemove?.(agent.key)}
              title="拆除联接（共享库数据保留，可恢复备份）"
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-red-500/10 hover:text-red-400"
            >
              <Link2Off className="h-3.5 w-3.5" />
              拆除
            </button>
          )}
          {onRestore && !editing && (
            <button
              onClick={() => void askRestore()}
              disabled={checkingRestore}
              title="恢复最近一次接入备份（原技能根还原为真实目录）"
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-amber-500/10 hover:text-amber-500 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复备份
            </button>
          )}
          {agent.state === 'other-link' && !editing && (
            <span className="text-red-400/80">联接指向别处，请人工处理</span>
          )}
          {onSaveEdit && !editing && (
            <button
              onClick={() => {
                setEditKey(agent.key)
                setEditPath(agent.path)
                setEditing(true)
              }}
              title="修改标识名 / 路径（只写配置表）"
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
