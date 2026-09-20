import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Info, Languages, Link2, Plus, RefreshCw, Route, Tag, Tags, Trash2, X } from 'lucide-react'
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

/** 分类徽章配色（按序取色，视觉上区分各类；自定义分类按 hash 取色） */
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
  if (idx >= 0) return CHIP_COLORS[idx]
  // 自定义分类：按名字 hash 稳定取色
  let h = 0
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return CHIP_COLORS[h % (CHIP_COLORS.length - 1)]
}

export function SkillsPanel({ refreshTick }: { refreshTick: number }) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [customCats, setCustomCats] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('全部')

  // 操作流状态
  const [installOpen, setInstallOpen] = useState(false)
  const [installUrl, setInstallUrl] = useState('')
  const [installReplace, setInstallReplace] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<SkillInfo | null>(null)
  const [busy, setBusy] = useState<
    'install' | 'remove' | 'translate' | 'translate-one' | 'router' | 'category' | 'source' | null
  >(null)
  const [result, setResult] = useState<{ title: string; logs: string[] } | null>(null)

  // 分类 / 来源弹窗
  const [categoryTarget, setCategoryTarget] = useState<SkillInfo | null>(null)
  const [categoryNew, setCategoryNew] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [renameFrom, setRenameFrom] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [sourceTarget, setSourceTarget] = useState<SkillInfo | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchUrls, setBatchUrls] = useState<Record<string, string>>({})

  const run = useCallback(async () => {
    setLoading(true)
    try {
      const [r, cc] = await Promise.all([
        window.api.skills.list() as Promise<IpcResult<SkillInfo[]>>,
        window.api.skills.customCategories() as Promise<IpcResult<string[]>>
      ])
      if (!r.ok) throw new Error(r.error)
      setSkills(r.data)
      if (cc.ok) setCustomCats(cc.data)
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
    async (title: string, action: () => Promise<IpcResult<OpResult>>, done?: () => void) => {
      try {
        const r = await action()
        if (!r.ok) throw new Error(r.error)
        setResult({ title, logs: r.data.logs })
        void run()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
        done?.()
      }
    },
    [run]
  )

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of skills) m.set(s.category, (m.get(s.category) ?? 0) + 1)
    return m
  }, [skills])

  // 过滤栏分类：内置序 + 自定义分类 + 未分类
  const allCats = useMemo(() => {
    const builtin = new Set(CATEGORY_ORDER as readonly string[])
    const extra = [...new Set(skills.map((s) => s.category))].filter(
      (c) => !builtin.has(c) && c !== '未分类'
    )
    return [...CATEGORY_ORDER, ...extra.sort()]
  }, [skills])

  const visible = filter === '全部' ? skills : skills.filter((s) => s.category === filter)
  const noSourceCount = skills.filter((s) => !s.source).length
  const hasRouter = skills.some((s) => s.name === 'router-guide')
  const [routerTipDismissed, setRouterTipDismissed] = useState(false)

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
          title="把英文简介译成中文，写入 _meta.json；已是中文的自动跳过（混合中英只翻英文部分）"
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
        {noSourceCount > 0 && (
          <button
            onClick={() => {
              setBatchUrls({})
              setBatchOpen(true)
            }}
            title={`为 ${noSourceCount} 个没有来源的技能配置 GitHub / skills.sh 链接（建立版本基准，供更新检测）`}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-1.5 text-sm text-amber-500 transition hover:bg-amber-500/20"
          >
            <Link2 className="h-3.5 w-3.5" />
            补全来源（{noSourceCount}）
          </button>
        )}
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
        {['全部', ...allCats].map((c) => {
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
        <button
          onClick={() => setManageOpen(true)}
          title="分类管理：重命名 / 删除自定义分类"
          className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-800"
        >
          <Tags className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 路由技能提示条（明显提醒：需在会话中手动启用） */}
      {hasRouter && !routerTipDismissed && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-sky-500/10 px-4 py-3 text-sm text-sky-600 ring-1 ring-sky-500/30 dark:text-sky-400">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <b>skill-router 路由技能不会自动触发</b>
            ：请在各 Agent 的新会话里手动选择 / 点名 skill-router 启用一次，它才会按索引为你的任务推荐技能。
          </div>
          <button
            onClick={() => setRouterTipDismissed(true)}
            className="shrink-0 rounded p-0.5 text-sky-400 hover:bg-sky-500/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
              onCategory={() => {
                setCategoryTarget(s)
                setCategoryNew('')
              }}
              onSource={() => {
                setSourceTarget(s)
                setSourceUrl(s.source ?? '')
              }}
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

      {/* 分类选择弹窗 */}
      {categoryTarget && (
        <Modal title={`分类：${categoryTarget.name}`} onClose={() => setCategoryTarget(null)}>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-1.5">
              {[...allCats].map((c) => (
                <button
                  key={c}
                  onClick={() => {
                    const t = categoryTarget
                    setCategoryTarget(null)
                    setBusy('category')
                    void execute(`分类：${t.name}`, () => window.api.skills.setCategory(t.name, c))
                  }}
                  className={
                    'rounded-lg px-2.5 py-1.5 text-xs transition ' +
                    (categoryTarget.category === c
                      ? 'bg-sky-500 font-medium text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700')
                  }
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={categoryNew}
                onChange={(e) => setCategoryNew(e.target.value)}
                placeholder="新建自定义分类…"
                className="flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-sky-400 dark:border-slate-600"
              />
              <button
                onClick={() => {
                  if (!categoryNew.trim()) return
                  const t = categoryTarget
                  const name = categoryNew.trim()
                  setCategoryTarget(null)
                  setCategoryNew('')
                  setBusy('category')
                  void execute(`分类：${t.name}`, () => window.api.skills.setCategory(t.name, name))
                }}
                disabled={!categoryNew.trim()}
                className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
              >
                创建并使用
              </button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              手动分类保存在技能的 _meta.json，优先于按关键词的自动分类；选「未分类」不等于清除手动设置，要恢复自动分类请选当前分类后再点下方按钮。
            </div>
            <button
              onClick={() => {
                const t = categoryTarget
                setCategoryTarget(null)
                setBusy('category')
                void execute(`分类：${t.name}`, () => window.api.skills.setCategory(t.name, ''))
              }}
              className="text-xs text-sky-500 underline"
            >
              恢复自动分类
            </button>
          </div>
        </Modal>
      )}

      {/* 分类管理弹窗（重命名 / 删除自定义分类） */}
      {manageOpen && (
        <Modal title="分类管理（自定义分类）" onClose={() => setManageOpen(false)}>
          <div className="space-y-3 text-sm">
            {customCats.length === 0 ? (
              <div className="text-slate-500 dark:text-slate-400">
                还没有自定义分类。在技能卡片的「分类」里输入新名字即可创建。
              </div>
            ) : (
              <div className="space-y-1.5">
                {customCats.map((c) =>
                  renameFrom === c ? (
                    <div key={c} className="flex items-center gap-2">
                      <input
                        value={renameTo}
                        onChange={(e) => setRenameTo(e.target.value)}
                        autoFocus
                        className="flex-1 rounded-lg border border-sky-400 bg-transparent px-3 py-1.5 text-xs outline-none dark:border-sky-600"
                      />
                      <button
                        onClick={() => {
                          if (!renameTo.trim()) return
                          setRenameFrom(null)
                          setManageOpen(false)
                          setBusy('category')
                          void execute(`重命名分类：${c}`, () =>
                            window.api.skills.renameCategory(c, renameTo.trim())
                          )
                        }}
                        disabled={!renameTo.trim()}
                        className="rounded-lg bg-sky-500 px-2.5 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setRenameFrom(null)}
                        className="rounded-lg px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <div
                      key={c}
                      className="group flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-950"
                    >
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${chipCls(c)}`}>{c}</span>
                      <span className="text-xs text-slate-400">{counts.get(c) ?? 0} 个技能</span>
                      <div className="ml-auto flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          onClick={() => {
                            setRenameFrom(c)
                            setRenameTo(c)
                          }}
                          className="rounded px-2 py-0.5 text-xs text-sky-500 hover:bg-sky-500/10"
                        >
                          重命名
                        </button>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
            <div className="text-xs text-slate-500 dark:text-slate-400">
              内置 9 大分类来自关键词词典（防漂移表），不支持改名；删除自定义分类请先把其中技能改到别的分类（重命名到「未分类」除外，重命名即批量迁移）。
            </div>
          </div>
        </Modal>
      )}

      {/* 来源设置弹窗（单技能） */}
      {sourceTarget && (
        <Modal title={`来源 / 版本基准：${sourceTarget.name}`} onClose={() => setSourceTarget(null)}>
          <div className="space-y-3 text-sm">
            <div className="text-slate-600 dark:text-slate-300">
              配置开源仓库链接后，更新页即可检测新版本。保存时会自动获取仓库当前最新提交作为版本基准。
            </div>
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
            />
            {sourceTarget.source && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                当前来源：{sourceTarget.source}
                {sourceTarget.commitSha ? `（基准 ${sourceTarget.commitSha.slice(0, 12)}）` : '（无基准）'}
              </div>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setSourceTarget(null)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (!sourceUrl.trim()) return
                const t = sourceTarget
                setSourceTarget(null)
                setBusy('source')
                void execute(`来源：${t.name}`, () => window.api.skills.setSource(t.name, sourceUrl.trim()))
              }}
              disabled={!sourceUrl.trim()}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              保存并索引版本
            </button>
          </div>
        </Modal>
      )}

      {/* 批量补全来源弹窗 */}
      {batchOpen && (
        <Modal title={`批量补全来源（${skills.filter((s) => !s.source).length} 个技能）`} onClose={() => setBatchOpen(false)} width="max-w-2xl">
          <div className="space-y-3 text-sm">
            <div className="text-slate-600 dark:text-slate-300">
              为没有来源信息的技能逐个填仓库链接（可留空跳过）。保存时自动获取当前提交作为版本基准。
            </div>
            <div className="max-h-80 space-y-2 overflow-auto pr-1">
              {skills
                .filter((s) => !s.source)
                .map((s) => (
                  <div key={s.name} className="flex items-center gap-2">
                    <span className="w-40 shrink-0 truncate font-mono text-xs">{s.name}</span>
                    <input
                      value={batchUrls[s.name] ?? ''}
                      onChange={(e) => setBatchUrls((m) => ({ ...m, [s.name]: e.target.value }))}
                      placeholder="https://github.com/owner/repo（留空跳过）"
                      className="flex-1 rounded-lg border border-slate-300 bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
                    />
                  </div>
                ))}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setBatchOpen(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              取消
            </button>
            <button
              onClick={() => {
                const filled = Object.entries(batchUrls).filter(([, u]) => u.trim())
                if (filled.length === 0) return
                setBatchOpen(false)
                setBusy('source')
                void execute(`补全来源（${filled.length} 个）`, async () => {
                  const logs: string[] = []
                  let okCount = 0
                  for (const [name, url] of filled) {
                    const r = await window.api.skills.setSource(name, url.trim())
                    if (r.ok) {
                      logs.push(...r.data.logs)
                      okCount++
                    } else {
                      logs.push(`[FAIL] ${name}: ${r.error}`)
                    }
                  }
                  return { ok: true as const, data: { logs } }
                })
              }}
              disabled={Object.values(batchUrls).every((u) => !u.trim())}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              批量保存
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
  onRemove,
  onCategory,
  onSource
}: {
  skill: SkillInfo
  busy: boolean
  onTranslate: () => void
  onRemove: () => void
  onCategory: () => void
  onSource: () => void
}) {
  const intro = skill.introZh || skill.intro
  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{skill.name}</span>
            {skill.name === 'router-guide' && (
              <span
                className="flex shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-500"
                title="路由技能：需在 Agent 会话中手动选择 / 点名 skill-router 启用"
              >
                <Route className="h-3 w-3" />
                路由·需手动启用
              </span>
            )}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${chipCls(skill.category)}`}>
          {skill.category}
        </span>
      </div>

      <div className="mt-2 line-clamp-3 min-h-[3.6rem] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {intro || '（无简介）'}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400 dark:text-slate-500">
        {skill.source ? (
          <span className="max-w-full truncate" title={skill.source}>
            来源 {skill.source.replace('https://github.com/', '')}
            {skill.branch ? `@${skill.branch}` : ''}
          </span>
        ) : (
          <span className="text-amber-500/80">无来源（点「来源」补全后可检测更新）</span>
        )}
        {skill.version && <span>v{skill.version}</span>}
        {!skill.version && skill.commitSha && <span>基准 {skill.commitSha.slice(0, 7)}</span>}
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
            onClick={onSource}
            title="设置开源仓库链接（建立版本基准，供更新检测）"
            className="flex items-center gap-1 rounded px-2 py-1 hover:bg-sky-500/10 hover:text-sky-500"
          >
            <Link2 className="h-3.5 w-3.5" />
            来源
          </button>
          <button
            onClick={onCategory}
            title="设置分类（手动分类优先于自动）"
            className="flex items-center gap-1 rounded px-2 py-1 hover:bg-sky-500/10 hover:text-sky-500"
          >
            <Tag className="h-3.5 w-3.5" />
            分类
          </button>
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
