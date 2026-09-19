import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Languages, Plus, RefreshCw, Route, Trash2 } from 'lucide-react'
import type { IpcResult, OpResult, SkillInfo } from '@shared/types'
import { ConfirmDialog, Modal, ResultModal } from './Modal'

const CATEGORY_ORDER = [
  '开发与工程',
  '写作与内容',
  '研究与搜索',
  '办公与效率',
  '数据分析',
  '设计与创意',
  '音视频与媒体',
  'Agent 与技能管理',
  '生活与日常',
  '未分类'
] as const

/** 分类徽章配色（按序取色，视觉上区分 9 大类） */
const CHIP_COLORS = [
  'bg-sky-500/15 text-sky-500',
  'bg-violet-500/15 text-violet-400',
  'bg-teal-500/15 text-teal-400',
  'bg-amber-500/15 text-amber-500',
  'bg-rose-500/15 text-rose-400',
  'bg-fuchsia-500/15 text-fuchsia-400',
  'bg-cyan-500/15 text-cyan-400',
  'bg-emerald-500/15 text-emerald-400',
  'bg-lime-500/15 text-lime-400',
  'bg-slate-500/15 text-slate-400'
]

function chipCls(category: string): string {
  const idx = CATEGORY_ORDER.indexOf(category as (typeof CATEGORY_ORDER)[number])
  return CHIP_COLORS[idx >= 0 ? idx : CHIP_COLORS.length - 1]
}

export function SkillsPanel({ refreshTick }: { refreshTick: number }) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('全部')

  // 操作流状态
  const [installOpen, setInstallOpen] = useState(false)
  const [installUrl, setInstallUrl] = useState('')
  const [installReplace, setInstallReplace] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<SkillInfo | null>(null)
  const [busy, setBusy] = useState<'install' | 'remove' | 'translate' | 'translate-one' | 'router' | null>(
    null
  )
  const [result, setResult] = useState<{ title: string; logs: string[] } | null>(null)

  const run = useCallback(async () => {
    setLoading(true)
    try {
      const r = (await window.api.skills.list()) as IpcResult<SkillInfo[]>
      if (!r.ok) throw new Error(r.error)
      setSkills(r.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run, refreshTick])

  /** 统一执行 + 结果弹窗（成功后自动刷新列表） */
  const execute = useCallback(
    async (title: string, action: () => Promise<IpcResult<OpResult>>) => {
      try {
        const r = await action()
        if (!r.ok) throw new Error(r.error)
        setResult({ title, logs: r.data.logs })
        void run()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    },
    [run]
  )

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of skills) m.set(s.category, (m.get(s.category) ?? 0) + 1)
    return m
  }, [skills])

  const visible = filter === '全部' ? skills : skills.filter((s) => s.category === filter)

  return (
    <>
      {/* 工具栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setInstallOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600"
        >
          <Plus className="h-3.5 w-3.5" />
          安装技能
        </button>
        <button
          onClick={() => {
            setBusy('translate')
            void execute('翻译简介（全库增量）', () => window.api.skills.translate())
          }}
          disabled={busy !== null}
          title="把英文简介译成中文，写入 _meta.json；已有中文的自动跳过"
          className="flex items-center gap-1.5 rounded-lg bg-sky-500/10 px-3 py-1.5 text-sm text-sky-500 transition hover:bg-sky-500/20 disabled:opacity-50"
        >
          <Languages className={`h-3.5 w-3.5 ${busy === 'translate' ? 'animate-pulse' : ''}`} />
          翻译简介
        </button>
        <button
          onClick={() => {
            setBusy('router')
            void execute('生成路由技能', () => window.api.skills.generateRouter())
          }}
          disabled={busy !== null}
          title="生成 / 刷新 skill-router 总路由技能"
          className="flex items-center gap-1.5 rounded-lg bg-sky-500/10 px-3 py-1.5 text-sm text-sky-500 transition hover:bg-sky-500/20 disabled:opacity-50"
        >
          <Route className={`h-3.5 w-3.5 ${busy === 'router' ? 'animate-pulse' : ''}`} />
          生成路由
        </button>
        <button
          onClick={() => void run()}
          disabled={loading}
          className="ml-auto rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800/70"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 分类过滤 */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {['全部', ...CATEGORY_ORDER].map((c) => {
          const count = c === '全部' ? skills.length : (counts.get(c) ?? 0)
          if (c !== '全部' && count === 0) return null
          return (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={
                'rounded-full px-2.5 py-1 text-xs transition ' +
                (filter === c
                  ? 'bg-sky-500 text-white'
                  : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
              }
            >
              {c}
              <span className="ml-1 opacity-70">{count}</span>
            </button>
          )
        })}
      </div>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
          <span className="break-all">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 text-xs underline">
            关闭
          </button>
        </div>
      )}

      {/* 技能卡片 */}
      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <div className="font-medium">{skills.length === 0 ? '共享库还是空的' : '该分类下没有技能'}</div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {skills.length === 0
              ? '点「安装技能」粘贴 GitHub 或 skills.sh 链接，装进来的技能所有已接入的 Agent 共用。'
              : '换个分类看看，或点「安装技能」补充新技能。'}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => (
            <SkillCard
              key={s.name}
              skill={s}
              busy={busy === 'translate-one'}
              onTranslate={() => {
                setBusy('translate-one')
                void execute(`翻译简介：${s.name}`, () => window.api.skills.translate(s.name, true))
              }}
              onRemove={() => setRemoveTarget(s)}
            />
          ))}
        </div>
      )}

      {/* 安装弹窗 */}
      {installOpen && (
        <Modal title="安装技能" onClose={() => setInstallOpen(false)}>
          <div className="space-y-3 text-sm">
            <div className="text-slate-600 dark:text-slate-300">
              粘贴技能仓库链接，自动下载并装进共享库（装完所有已接入 Agent 共用）：
            </div>
            <input
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              placeholder="https://github.com/owner/repo 或 https://skills.sh/s/owner/repo/skill-name"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <input
                type="checkbox"
                checked={installReplace}
                onChange={(e) => setInstallReplace(e.target.checked)}
                className="accent-sky-500"
              />
              同名技能直接替换为仓库版本（默认跳过）
            </label>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              仓库根有 SKILL.md 视为单个技能；否则每个含 SKILL.md 的子目录各装一个。简介会自动翻译成中文。
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setInstallOpen(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (!installUrl.trim()) return
                setBusy('install')
                setInstallOpen(false)
                void execute(`安装结果：${installUrl.trim()}`, () =>
                  window.api.skills.install(installUrl.trim(), installReplace)
                )
              }}
              disabled={busy !== null || !installUrl.trim()}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-50"
            >
              {busy === 'install' ? '安装中…' : '安装'}
            </button>
          </div>
        </Modal>
      )}

      {/* 移除确认 */}
      {removeTarget && (
        <ConfirmDialog
          title={`移除技能：${removeTarget.name}`}
          confirmLabel="确认移除"
          danger
          busy={busy === 'remove'}
          onConfirm={() => {
            const target = removeTarget
            setRemoveTarget(null)
            setBusy('remove')
            void execute(`移除结果：${target.name}`, () => window.api.skills.remove(target.name))
          }}
          onClose={() => setRemoveTarget(null)}
        >
          <code className="block break-all rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
            {removeTarget.name}
          </code>
          <div className="text-slate-600 dark:text-slate-300">
            将从共享库<b>永久删除</b>该技能目录，所有 Agent 都不再可见。此操作不可撤销。
          </div>
        </ConfirmDialog>
      )}

      {result && (
        <ResultModal title={result.title} logs={result.logs} onClose={() => setResult(null)} />
      )}
    </>
  )
}

function SkillCard({
  skill,
  busy,
  onTranslate,
  onRemove
}: {
  skill: SkillInfo
  busy: boolean
  onTranslate: () => void
  onRemove: () => void
}) {
  const intro = skill.introZh || skill.intro
  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{skill.name}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${chipCls(skill.category)}`}>
          {skill.category}
        </span>
      </div>

      <div className="mt-2 line-clamp-3 min-h-[3.6rem] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {intro || '（无简介）'}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400 dark:text-slate-500">
        {skill.source && (
          <span className="max-w-full truncate">
            来源 {skill.source.replace('https://github.com/', '')}
            {skill.branch ? `@${skill.branch}` : ''}
          </span>
        )}
        {skill.installedAt && <span>装于 {skill.installedAt.slice(0, 10)}</span>}
        {skill.introZh && skill.translatedAt && <span>译于 {skill.translatedAt.slice(0, 10)}</span>}
      </div>

      <div className="mt-3 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
        <div className="ml-auto flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
          {!skill.introZh && (
            <button
              onClick={onTranslate}
              disabled={busy}
              title="翻译该技能简介为中文"
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-sky-500/10 hover:text-sky-500 disabled:opacity-50"
            >
              <Languages className="h-3.5 w-3.5" />
              翻译
            </button>
          )}
          <button
            onClick={() => void window.api.app.openPath(skill.name)}
            title="打开技能目录（在共享库中）"
            className="rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onRemove}
            title="从共享库移除（永久删除）"
            className="flex items-center gap-1 rounded px-2 py-1 hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
            移除
          </button>
        </div>
      </div>
    </div>
  )
}
