import { AlertTriangle, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RouterTarget } from '@shared/types'

/** 基础弹窗：遮罩 + 居中面板，点遮罩关闭 */
export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg'
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full ${width} rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <span className="font-medium">{title}</span>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4 max-h-[70vh] overflow-auto">{children}</div>
      </div>
    </div>
  )
}

/** 二次确认框（会改本机环境的操作统一走这里） */
export function ConfirmDialog({
  title,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
  children
}: {
  title: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3 text-sm">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={
            'rounded-lg px-3 py-1.5 text-sm font-medium text-white transition disabled:opacity-50 ' +
            (danger
              ? 'bg-red-500 hover:bg-red-600'
              : 'bg-sky-500 hover:bg-sky-600')
          }
        >
          {busy ? '执行中…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

/** 操作结果弹窗：逐条展示与 PowerShell 脚本同款的日志行 */
export function ResultModal({
  title,
  logs,
  onClose
}: {
  title: string
  logs: string[]
  onClose: () => void
}) {
  const cls = (line: string): string => {
    if (line.includes('[FAIL]')) return 'text-red-400'
    if (line.includes('[冲突]')) return 'text-red-400'
    if (line.includes('[SKIP]')) return 'text-amber-500'
    if (line.includes('[去重]')) return 'text-amber-500'
    if (line.startsWith('[OK]') || line.includes('[完成]')) return 'text-emerald-500'
    return 'text-slate-600 dark:text-slate-300'
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="max-h-80 space-y-1 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-xs dark:bg-slate-950">
        {logs.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap ${cls(l)}`}>
            {l}
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          onClick={onClose}
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
        >
          好了
        </button>
      </div>
    </Modal>
  )
}

/** 接入确认：展示预案（迁移清单 / 冲突 / 同源多根警告） */
export function CreateConfirm({
  plan,
  backupEnabled,
  busy,
  onConfirm,
  onClose
}: {
  plan: import('@shared/types').CreatePlan
  backupEnabled?: boolean
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const scenarioText: Record<string, string> = {
    missing: '目录不存在，将直接建立联接',
    'already-active': '已是指向共享库的联接，将只写入配置',
    'real-dir': '真实目录，内容将先迁移进共享库',
    'empty-dir': '空目录，删除后建立联接',
    'wrong-target': '联接指向别处，需人工处理',
    'not-dir': '该路径是文件，无法建立联接'
  }
  const hasWarn = plan.duplicateWarnings.length > 0
  return (
    <ConfirmDialog
      title={`接入共享库：${plan.key}`}
      confirmLabel={plan.scenario === 'already-active' ? '写入配置' : '确认接入'}
      danger={hasWarn}
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <div className="flex items-center gap-2">
        <code className="break-all rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
          {plan.path}
        </code>
      </div>
      <div className="text-slate-600 dark:text-slate-300">{scenarioText[plan.scenario]}</div>

      {plan.scenario === 'real-dir' && plan.items.length > 0 && (
        <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
          <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">
            将处理 {plan.items.length} 项内容{backupEnabled ? '（迁移前会先备份原技能根目录）' : '，迁移后原目录即拆除'}：
          </div>
          <div className="max-h-52 overflow-auto">
            {plan.items.map((it) => (
              <div key={it.name} className="flex items-center justify-between font-mono text-xs">
                <span className="truncate">{it.name}</span>
                <span
                  className={
                    it.action === 'conflict'
                      ? 'text-red-400'
                      : it.action === 'dedupe'
                        ? 'text-amber-500'
                        : 'text-emerald-500'
                  }
                >
                  {it.action === 'move' ? '迁移' : it.action === 'dedupe' ? '去重删除' : '冲突·保留'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.blocked ? (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-red-400 ring-1 ring-red-500/30">
          {plan.blockedReason}
        </div>
      ) : hasWarn ? (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-500 ring-1 ring-amber-500/30">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4" />
            同一软件多技能根：接入后技能可能被重复加载
          </div>
          {plan.duplicateWarnings.map((w) => (
            <div key={w.name} className="mt-1 text-xs">
              {w.name}：建议改用「探测」页的归并功能保留单一入口。
            </div>
          ))}
          确定要继续吗？
        </div>
      ) : null}
    </ConfirmDialog>
  )
}

/** 归并确认：选保留哪个根（默认推荐覆盖软件最多的） */
export function MergeConfirm({
  plan,
  keepPath,
  onKeepChange,
  busy,
  onConfirm,
  onClose
}: {
  plan: import('@shared/types').MergePlan
  keepPath: string
  onKeepChange: (p: string) => void
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const stateText: Record<string, string> = {
    active: '活跃（联接→共享库）',
    'merged-empty': '空目录（已归并）',
    missing: '不存在',
    'other-link': '联接→其他目标',
    'real-dir': '真实非空目录',
    empty: '空目录'
  }
  return (
    <ConfirmDialog
      title={`归并：${plan.name}`}
      confirmLabel="确认归并"
      danger
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <div className="text-slate-600 dark:text-slate-300">
        检测到多个技能根同时指向共享库，软件会把技能重复加载。保留一个接入，其余拆联接后重建为空目录（数据仍完整保留在共享库）。
      </div>
      <div className="space-y-1.5">
        {plan.hits.map((h) => (
          <label
            key={h.path}
            className={
              'flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 transition ' +
              (keepPath === h.path
                ? 'border-sky-400 bg-sky-500/5'
                : 'border-slate-200 hover:border-slate-300 dark:border-slate-700')
            }
          >
            <input
              type="radio"
              name="merge-keep"
              checked={keepPath === h.path}
              onChange={() => onKeepChange(h.path)}
              className="accent-sky-500"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs">{h.path}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {stateText[h.state]}
                {h.recommended && <span className="ml-1 text-sky-500">· 推荐</span>}
                {h.alsoReadBy.length > 0 && (
                  <span className="ml-1">· 同时被 {h.alsoReadBy.join('、')} 读取</span>
                )}
              </div>
            </div>
          </label>
        ))}
      </div>
      <div className="text-xs text-slate-500 dark:text-slate-400">
        只处理「活跃」根；已归并/缺失/指向他处的根不动。
      </div>
    </ConfirmDialog>
  )
}

/**
 * 生成套件路由技能：选目标 Agent 技能根。
 * 只往选中的技能根写 skill-router（清单按该根实际可见技能生成）。
 */
export function RouterConfirm({
  targets,
  selected,
  onToggle,
  onSelectAll,
  busy,
  onConfirm,
  onClose
}: {
  targets: RouterTarget[]
  selected: Set<string>
  onToggle: (key: string) => void
  onSelectAll: (selectAll: boolean) => void
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const usableCount = targets.filter((t) => t.exists && t.skillCount > 0).length
  const pickedCount = targets.filter((t) => selected.has(t.key) && t.exists && t.skillCount > 0).length

  return (
    <Modal title="生成套件路由技能（skill-router）" onClose={onClose} width="max-w-2xl">
      <div className="space-y-3 text-sm">
        <div className="rounded-lg bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-600 dark:text-sky-400">
          路由技能会写到选中的 <b>Agent 技能根</b>——也就是该 Agent 真正加载技能的位置。
          清单只收录该根下**实际可见**的技能，所以在会话里点名 <b>skill-router</b> 一定能调到。
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>
            共 {targets.length} 个入口 · 可用 {usableCount} 个 · 已选 {pickedCount} 个
          </span>
          <button
            onClick={() => onSelectAll(pickedCount !== usableCount)}
            className="text-sky-500 hover:underline"
          >
            {pickedCount === usableCount ? '全不选' : '全选可用'}
          </button>
        </div>

        <div className="max-h-72 space-y-1 overflow-auto pr-1">
          {targets.map((t) => {
            const usable = t.exists && t.skillCount > 0
            return (
              <label
                key={t.key}
                className={
                  'flex items-center gap-2.5 rounded-lg border p-2.5 transition ' +
                  (usable
                    ? 'cursor-pointer border-slate-200 hover:border-slate-300 dark:border-slate-700'
                    : 'cursor-not-allowed border-slate-200 opacity-50 dark:border-slate-700')
                }
              >
                <input
                  type="checkbox"
                  checked={selected.has(t.key) && usable}
                  disabled={!usable}
                  onChange={() => onToggle(t.key)}
                  className="accent-sky-500"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{t.label}</span>
                    {t.configured && (
                      <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-500">
                        已接入
                      </span>
                    )}
                    {t.isSharedLink && (
                      <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-500">
                        共享库联接
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {t.root}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {usable ? `可见 ${t.skillCount} 个技能` : t.exists ? '目录里没有技能' : '目录不存在'}
                  </div>
                </div>
              </label>
            )
          })}
        </div>

        <div className="text-xs text-slate-500 dark:text-slate-400">
          生成后：在该 Agent 的**新会话**里点名 skill-router 并描述需求，它会按清单匹配技能。
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          disabled={busy || pickedCount === 0}
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-50"
        >
          {busy ? '生成中…' : `生成到 ${pickedCount} 个技能根`}
        </button>
      </div>
    </Modal>
  )
}
