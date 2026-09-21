import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRightLeft, Boxes, FolderOpen, Info, Languages, Link2, Plus, RefreshCw, Route, Search, Sparkles, Tag, Tags, Trash2, X } from 'lucide-react'
import type { AppConfig, IpcResult, OpResult, RepoSearchResult, RouterTarget, SkillInfo } from '@shared/types'
import { ConfirmDialog, Modal, ResultModal, RouterConfirm } from './Modal'
import { useTaskLog } from '../store/taskLog'

const CATEGORY_ORDER = [
  '开发与工程',
  '写作与内容',
  '研究与搜索',
  '办公与效率',
  '数据分析',
  '设计与创意',
  '音视频与媒体',
  'Agent 与技能管理',
  '套件',
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

/** GitHub 仓库搜索内联组件：结果点选后回填来源（用户仍需手动确认保存） */
function RepoSearch({ onPick }: { onPick: (url: string) => void }) {
  const [kw, setKw] = useState('')
  const [results, setResults] = useState<RepoSearchResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const doSearch = useCallback(async () => {
    if (!kw.trim()) return
    setBusy(true)
    setErr(null)
    try {
      const r = (await window.api.skills.searchRepos(kw.trim())) as IpcResult<RepoSearchResult[]>
      if (!r.ok) throw new Error(r.error)
      setResults(r.data)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [kw])

  return (
    <div className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-700">
      <div className="flex items-center gap-1.5">
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void doSearch()}
          placeholder="搜索 GitHub 仓库（如技能名 / 关键词）"
          className="flex-1 rounded-md border border-slate-300 bg-transparent px-2.5 py-1 text-xs outline-none focus:border-sky-400 dark:border-slate-600"
        />
        <button
          onClick={() => void doSearch()}
          disabled={busy || !kw.trim()}
          className="flex items-center gap-1 rounded-md bg-sky-500/10 px-2 py-1 text-xs text-sky-500 hover:bg-sky-500/20 disabled:opacity-50"
        >
          <Search className="h-3 w-3" />
          {busy ? '搜索中…' : '搜索'}
        </button>
      </div>
      {err && <div className="mt-1.5 text-xs text-red-400">{err}</div>}
      {results !== null && !busy && (
        <div className="mt-2 max-h-48 space-y-1 overflow-auto">
          {results.length === 0 ? (
            <div className="text-xs text-slate-400">没有匹配的仓库</div>
          ) : (
            results.map((r) => (
              <button
                key={r.repo}
                onClick={() => onPick(`https://github.com/${r.repo}`)}
                title={r.description}
                className="block w-full rounded-md px-2 py-1 text-left transition hover:bg-sky-500/10"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-sky-500">{r.repo}</span>
                  <span className="text-slate-400">★ {r.stars}</span>
                </div>
                {r.description && (
                  <div className="truncate text-[10px] text-slate-400">{r.description}</div>
                )}
              </button>
            ))
          )}
          <div className="text-[10px] text-slate-400">点选结果回填链接，确认后仍需手动保存。</div>
        </div>
      )}
    </div>
  )
}

export function SkillsPanel({
  refreshTick,
  config
}: {
  refreshTick: number
  config: AppConfig | null
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [customCats, setCustomCats] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('全部')
  const [originFilter, setOriginFilter] = useState<string>('')

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
  const [batchSearchRow, setBatchSearchRow] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')

  // 生成路由：目标技能根多选
  const [routerOpen, setRouterOpen] = useState(false)
  const [routerTargets, setRouterTargets] = useState<RouterTarget[]>([])
  const [routerSelected, setRouterSelected] = useState<Set<string>>(new Set())

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

  /** 统一执行 + 结果弹窗（成功后自动刷新列表）；同时登记到全局任务日志 */
  const logStart = useTaskLog((s) => s.start)
  const logFinish = useTaskLog((s) => s.finish)
  const logFail = useTaskLog((s) => s.fail)

  const execute = useCallback(
    async (title: string, action: () => Promise<IpcResult<OpResult>>, done?: () => void) => {
      const taskId = logStart(title, '技能库')
      try {
        const r = await action()
        if (!r.ok) throw new Error(r.error)
        setResult({ title, logs: r.data.logs })
        logFinish(taskId, r.data.logs)
        void run()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        logFail(taskId, msg)
      } finally {
        setBusy(null)
        done?.()
      }
    },
    [run, logStart, logFinish, logFail]
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

  const visible = useMemo(() => {
    let list = filter === '全部' ? skills : skills.filter((s) => s.category === filter)
    // 来源筛选（共享库 / 某 agent 原生根）
    if (originFilter === 'shared') list = list.filter((s) => s.origin?.kind !== 'agent')
    else if (originFilter) list = list.filter((s) => s.origin?.key === originFilter)
    const kw = keyword.trim().toLowerCase()
    if (kw) {
      const byName = config?.search?.name !== false
      const byIntro = config?.search?.intro !== false
      list = list.filter((s) => {
        if (byName && s.name.toLowerCase().includes(kw)) return true
        if (byIntro && (s.introZh || s.intro).toLowerCase().includes(kw)) return true
        return false
      })
    }
    return list
  }, [skills, filter, keyword, config, originFilter])

  /** 来源筛选选项（未接入但根目录真实存在的 agent） */
  const originOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of skills) {
      if (s.origin?.kind === 'agent') m.set(s.origin.key, s.origin.label)
    }
    return [...m.entries()]
  }, [skills])

  /** 共享库已有技能名（agent 技能迁移重名检测） */
  const sharedNames = useMemo(
    () => new Set(skills.filter((s) => s.origin?.kind !== 'agent').map((s) => s.name.toLowerCase())),
    [skills]
  )

  /** 迁移 agent 技能到共享库 */
  const migrate = useCallback(
    async (s: SkillInfo) => {
      if (!s.origin || s.origin.kind !== 'agent') return
      const r = (await window.api.skills.migrateFromAgent(s.origin.key, s.name)) as IpcResult<OpResult>
      if (!r.ok) {
        setError(r.error)
        return
      }
      setResult({ title: `迁移：${s.name}`, logs: r.data.logs })
      void run()
    },
    [run]
  )

  /** 套件分组（filter=套件 时的套件卡片网格数据） */
  const suiteGroups = useMemo(() => {
    const m = new Map<string, { marketplace: string; plugin: string; version?: string; members: SkillInfo[] }>()
    for (const s of skills) {
      if (!s.package) continue
      const key = `${s.package.marketplace}/${s.package.plugin}`
      const g = m.get(key) ?? { marketplace: s.package.marketplace, plugin: s.package.plugin, version: s.package.version, members: [] }
      g.members.push(s)
      if (s.package.version && !g.version) g.version = s.package.version
      m.set(key, g)
    }
    return [...m.values()]
  }, [skills])

  const noSourceCount = skills.filter((s) => !s.source).length
  const hasRouter = skills.some((s) => s.name === 'skill-router')
  const [routerTipDismissed, setRouterTipDismissed] = useState(false)

  /** 启停技能 */
  const toggleEnabled = useCallback(
    async (s: SkillInfo) => {
      const target = !s.enabled
      const r = (await window.api.skills.toggle(s.name, target)) as IpcResult<OpResult>
      if (!r.ok) {
        setError(r.error)
        return
      }
      void run()
    },
    [run]
  )

  /** 组套件 / 解散 */
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupSel, setGroupSel] = useState<Set<string>>(new Set())

  const [suiteDetail, setSuiteDetail] = useState<{ marketplace: string; plugin: string; version?: string; members: SkillInfo[] } | null>(null)

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
            void (async () => {
              try {
                const r = (await window.api.skills.routerTargets()) as IpcResult<RouterTarget[]>
                if (!r.ok) throw new Error(r.error)
                setRouterTargets(r.data)
                setRouterSelected(
                  new Set(r.data.filter((t) => t.exists && t.skillCount > 0).map((t) => t.key))
                )
                setRouterOpen(true)
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              }
            })()
          }}
          disabled={busy !== null}
          title="检测各 Agent 技能根里实际启用的技能，生成 / 刷新套件入口 skill-router（清单只收录真实可调用的技能）"
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
          onClick={() => {
            setGroupName('')
            setGroupSel(new Set())
            setGroupOpen(true)
          }}
          title="把技能库现有技能组成自定义套件（统一套件标记，可整组管理）"
          className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-sm text-red-500 transition hover:bg-red-500/20"
        >
          <Boxes className="h-3.5 w-3.5" />
          组套件
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

      {/* 搜索框 */}
      <div className="mb-4 flex items-center gap-2">
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={
            config?.search?.intro === false
              ? '搜索技能名…'
              : '搜索技能名或简介…'
          }
          className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-sky-400 dark:border-slate-600"
        />
        {keyword && (
          <button
            onClick={() => setKeyword('')}
            className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 来源筛选（共享库 / 未接入但存在的 agent） */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-slate-400">来源</span>
        <button
          onClick={() => setOriginFilter('')}
          className={
            'rounded-full px-2.5 py-1 text-xs transition ' +
            (originFilter === ''
              ? 'bg-sky-500 text-white'
              : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
          }
        >
          全部来源
        </button>
        <button
          onClick={() => setOriginFilter('shared')}
          className={
            'rounded-full px-2.5 py-1 text-xs transition ' +
            (originFilter === 'shared'
              ? 'bg-emerald-500 text-white'
              : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
          }
        >
          共享库技能
        </button>
        {originOptions.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setOriginFilter(originFilter === key ? '' : key)}
            title={`未接入的 agent「${label}」原生技能（可迁移进共享库）`}
            className={
              'rounded-full px-2.5 py-1 text-xs transition ' +
              (originFilter === key
                ? 'bg-blue-500 text-white'
                : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* 路由技能提示条（明显提醒：需在会话中手动启用） */}
      {hasRouter && !routerTipDismissed && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-sky-500/10 px-4 py-3 text-sm text-sky-600 ring-1 ring-sky-500/30 dark:text-sky-400">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <b>套件入口 skill-router 不会自动触发</b>
            ：整个技能库被当成一个套件，用「生成路由」把它写到各 Agent 的真实加载目录后，
            在该 Agent 的<b>新会话</b>里点名 skill-router 并描述需求，它就会按清单匹配技能并直接执行。
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

      {/* 套件分类 → 套件卡片网格；其他分类 → 技能卡片 */}
      {filter === '套件' && suiteGroups.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {suiteGroups.map((g) => {
            const key = `${g.marketplace}/${g.plugin}`
            const enabledCount = g.members.filter((m) => m.enabled !== false).length
            const isCustom = g.marketplace === 'custom'
            return (
              <div
                key={key}
                onClick={() => setSuiteDetail(g)}
                className="group cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:border-red-400/60 hover:shadow-lg hover:shadow-red-500/5 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-start gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/15">
                    <Boxes className="h-4 w-4 text-red-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{g.plugin}</div>
                    <div className="text-[10px] text-slate-400">
                      {isCustom ? '自定义套件' : g.marketplace}
                      {g.version ? ` · v${g.version}` : ''}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-500">套件</span>
                </div>
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {g.members.length} 个技能 · {enabledCount} 启用 / {g.members.length - enabledCount} 停用
                </div>
                <div className="mt-1 line-clamp-1 text-[10px] text-slate-400">
                  {g.members.map((m) => m.name).join('、')}
                </div>
              </div>
            )
          })}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <div className="font-medium">
            {skills.length === 0 ? '共享库还是空的' : filter === '套件' ? '还没有套件' : '该分类下没有技能'}
          </div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {skills.length === 0
              ? '点「安装技能」粘贴 GitHub 或 skills.sh 链接，装进来的技能所有已接入的 Agent 共用。'
              : filter === '套件'
                ? '去 SkillHub 页的「套件」装市场套件，或点上方「组套件」把现有技能组成自定义套件。'
                : '换个分类看看，或点「安装技能」补充新技能。'}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((s) => (
            <SkillCard
              key={`${s.origin?.kind ?? 'shared'}:${s.origin?.key ?? 'shared'}:${s.name}`}
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
              onToggle={() => void toggleEnabled(s)}
              onMigrate={
                s.origin?.kind === 'agent'
                  ? () => void migrate(s)
                  : undefined
              }
              sharedExists={s.origin?.kind === 'agent' ? sharedNames.has(s.name.toLowerCase()) : undefined}
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
            <div>
              <div className="mb-1.5 text-xs text-slate-500 dark:text-slate-400">
                或搜索 GitHub / skills.sh 技能仓库，点选回填（仍需手动确认保存）：
              </div>
              <RepoSearch onPick={(url) => setSourceUrl(url)} />
            </div>
            <button
              onClick={() => {
                const t = sourceTarget
                setSourceTarget(null)
                setBusy('source')
                void execute(`SkillHub 自动匹配：${t.name}`, () => window.api.skills.autoSource(t.name))
              }}
              disabled={busy !== null}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500 transition hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              SkillHub 自动匹配（按技能名/简介搜平台，命中自动写来源+版本）
            </button>
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
            <button
              onClick={() => {
                setBatchOpen(false)
                setBusy('source')
                void execute('SkillHub 自动匹配来源', () => window.api.skills.autoSourceAll())
              }}
              disabled={busy !== null}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500 transition hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              SkillHub 一键自动匹配（按技能名/简介搜索，自动写来源+版本）
            </button>
            <div className="text-center text-xs text-slate-400">— 或手动逐行填写 —</div>
            <div className="max-h-80 space-y-2 overflow-auto pr-1">
              {skills
                .filter((s) => !s.source)
                .map((s) => (
                  <div key={s.name}>
                    <div className="flex items-center gap-2">
                      <span className="w-36 shrink-0 truncate font-mono text-xs">{s.name}</span>
                      <input
                        value={batchUrls[s.name] ?? ''}
                        onChange={(e) => setBatchUrls((m) => ({ ...m, [s.name]: e.target.value }))}
                        placeholder="https://github.com/owner/repo（留空跳过）"
                        className="flex-1 rounded-lg border border-slate-300 bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
                      />
                      <button
                        onClick={() => setBatchSearchRow(batchSearchRow === s.name ? null : s.name)}
                        title="搜索 GitHub 仓库"
                        className={
                          'shrink-0 rounded-md p-1.5 transition ' +
                          (batchSearchRow === s.name
                            ? 'bg-sky-500/15 text-sky-500'
                            : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800')
                        }
                      >
                        <Search className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {batchSearchRow === s.name && (
                      <div className="mt-1.5">
                        <RepoSearch
                          onPick={(url) => {
                            setBatchUrls((m) => ({ ...m, [s.name]: url }))
                            setBatchSearchRow(null)
                          }}
                        />
                      </div>
                    )}
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

      {/* 组套件弹窗 */}
      {groupOpen && (
        <Modal title="组自定义套件" onClose={() => setGroupOpen(false)} width="max-w-2xl">
          <div className="space-y-3 text-sm">
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="套件名称（如 my-daily-suite）"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs outline-none focus:border-sky-400 dark:border-slate-600"
            />
            <div className="max-h-72 space-y-1 overflow-auto rounded-lg bg-slate-50 p-2 dark:bg-slate-950">
              {skills
                .filter((s) => s.origin?.kind !== 'agent') // 组套件只针对共享库技能
                .map((s) => (
                <label
                  key={s.name}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={groupSel.has(s.name)}
                    onChange={(e) => {
                      const next = new Set(groupSel)
                      if (e.target.checked) next.add(s.name)
                      else next.delete(s.name)
                      setGroupSel(next)
                    }}
                    className="accent-sky-500"
                  />
                  <span className="truncate font-mono text-xs">{s.name}</span>
                  {s.package && (
                    <span className="text-[10px] text-red-400">
                      当前：{s.package.plugin}@{s.package.marketplace}
                    </span>
                  )}
                  {s.enabled === false && <span className="text-[10px] text-slate-400">已停用</span>}
                </label>
              ))}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              勾选 {groupSel.size} 个技能。成员会统一打上套件标记并归类「套件」分类（红色标识）；已是其他套件成员的技能会被移入新套件。
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setGroupOpen(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (!groupName.trim() || groupSel.size === 0) return
                const name = groupName.trim()
                setGroupOpen(false)
                setBusy('category')
                void execute(`组套件：${name}`, () => window.api.skills.groupPackage(name, [...groupSel]))
              }}
              disabled={!groupName.trim() || groupSel.size === 0}
              className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              组成套件
            </button>
          </div>
        </Modal>
      )}

      {/* 套件详情弹窗（技能库 · 套件分类下的卡片） */}
      {suiteDetail && (
        <Modal
          title={`套件：${suiteDetail.plugin}`}
          onClose={() => setSuiteDetail(null)}
          width="max-w-2xl"
        >
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-500">套件</span>
              {suiteDetail.version && <span className="text-xs text-slate-400">v{suiteDetail.version}</span>}
              <span className="ml-auto text-xs text-slate-400">
                {suiteDetail.marketplace === 'custom' ? '自定义套件' : `市场 ${suiteDetail.marketplace}`} ·{' '}
                {suiteDetail.members.length} 个技能
              </span>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
              <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">成员技能（可单独启停）：</div>
              <div className="max-h-64 space-y-1.5 overflow-auto">
                {suiteDetail.members.map((m) => (
                  <div key={m.name} className="flex items-center gap-2 rounded px-1 py-0.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.name}</span>
                    <button
                      onClick={() => void toggleEnabled(m)}
                      title={m.enabled !== false ? '点击停用（Agent 不再加载）' : '点击启用（移回共享库）'}
                      className={
                        'relative h-5 w-9 shrink-0 rounded-full transition ' +
                        (m.enabled !== false ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600')
                      }
                    >
                      <span
                        className={
                          'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ' +
                          (m.enabled !== false ? 'left-[18px]' : 'left-0.5')
                        }
                      />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              停用 = 技能移出共享库（Agent 不加载，数据保留在 skills-disabled 区）；启用 = 移回共享库。
            </div>
          </div>
          <div className="mt-5 flex justify-between">
            {suiteDetail.marketplace === 'custom' ? (
              <button
                onClick={async () => {
                  const name = suiteDetail.plugin
                  const r = (await window.api.skills.ungroupPackage(name)) as IpcResult<OpResult>
                  setSuiteDetail(null)
                  if (r.ok) setResult({ title: `解散套件：${name}`, logs: r.data.logs })
                  else setError(r.error)
                }}
                className="rounded-lg px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10"
              >
                解散此套件（保留技能，去除标记）
              </button>
            ) : (
              <span />
            )}
            <button
              onClick={() => setSuiteDetail(null)}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600"
            >
              关闭
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

      {/* 生成路由：选目标技能根 */}
      {routerOpen && (
        <RouterConfirm
          targets={routerTargets}
          selected={routerSelected}
          onToggle={(k) =>
            setRouterSelected((prev) => {
              const next = new Set(prev)
              if (next.has(k)) next.delete(k)
              else next.add(k)
              return next
            })
          }
          onSelectAll={(all) =>
            setRouterSelected(
              all
                ? new Set(
                    routerTargets.filter((t) => t.exists && t.skillCount > 0).map((t) => t.key)
                  )
                : new Set()
            )
          }
          busy={busy === 'router'}
          onConfirm={() => {
            setBusy('router')
            void execute(
              '生成套件路由技能',
              () => window.api.skills.generateRouter([...routerSelected]),
              () => setRouterOpen(false)
            )
          }}
          onClose={() => setRouterOpen(false)}
        />
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
  onSource,
  onToggle,
  onMigrate,
  sharedExists
}: {
  skill: SkillInfo
  busy: boolean
  onTranslate: () => void
  onRemove: () => void
  onCategory: () => void
  onSource: () => void
  onToggle: () => void
  /** agent 原生技能的「迁移到共享库」回调 */
  onMigrate?: () => void
  /** agent 技能与共享库重名（禁用迁移） */
  sharedExists?: boolean
}) {
  const intro = skill.introZh || skill.intro
  const enabled = skill.enabled !== false
  const isAgentEntry = skill.origin?.kind === 'agent'
  return (
    <div
      className={
        'group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 dark:border-slate-800 dark:bg-slate-900 ' +
        (enabled ? '' : 'opacity-60')
      }
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{skill.name}</span>
            {/* 归属标识：共享库（绿） / 某 agent（蓝） */}
            {isAgentEntry ? (
              <span
                className="flex shrink-0 items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-500"
                title={`来自未接入 agent「${skill.origin?.label}」的原生技能`}
              >
                {skill.origin?.label}
              </span>
            ) : (
              <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-500">
                共享库
              </span>
            )}
            {skill.package && (
              <span
                className="flex shrink-0 items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-500"
                title={`套件成员：${skill.package.plugin}@${skill.package.marketplace}${skill.package.version ? ` v${skill.package.version}` : ''}`}
              >
                <Boxes className="h-3 w-3" />
                套件
              </span>
            )}
            {skill.name === 'skill-router' && (
              <span
                className="flex shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-500"
                title="技能套件总入口：在新会话里点名 skill-router 并描述需求，它会按清单匹配技能"
              >
                <Route className="h-3 w-3" />
                套件入口
              </span>
            )}
          </div>
        </div>
        {/* 启停开关：开=共享库启用（Agent 加载），关=移出共享库停用（agent 原生技能不适用） */}
        {!isAgentEntry && (
          <button
            onClick={onToggle}
            title={enabled ? '已在共享库启用，点击停用（Agent 不再加载，数据保留）' : '已停用，点击启用（移回共享库）'}
            className={
              'relative h-5 w-9 shrink-0 rounded-full transition ' +
              (enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600')
            }
          >
            <span
              className={
                'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ' +
                (enabled ? 'left-[18px]' : 'left-0.5')
              }
            />
          </button>
        )}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${chipCls(skill.category)}`}>
          {skill.category}
        </span>
      </div>

      <div className="mt-2 line-clamp-3 min-h-[3.6rem] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        {intro || '（无简介）'}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400 dark:text-slate-500">
        {skill.package && (
          <span className="max-w-full truncate text-red-400/90">
            {skill.package.plugin}@{skill.package.marketplace}
            {skill.package.version ? ` v${skill.package.version}` : ''}
          </span>
        )}
        {skill.source ? (
          <span className="max-w-full truncate" title={skill.source}>
            来源 {skill.source.replace('https://github.com/', '').replace('https://skillhub.cn/skills/', 'SkillHub:')}
            {skill.branch ? `@${skill.branch}` : ''}
          </span>
        ) : (
          <span className="text-amber-500/80">无来源（点「来源」补全后可检测更新）</span>
        )}
        {skill.version && <span>v{skill.version}</span>}
        {!skill.version && skill.commitSha && <span>基准 {skill.commitSha.slice(0, 7)}</span>}
        {skill.installedAt && <span>装于 {skill.installedAt.slice(0, 10)}</span>}
        {skill.introZh && skill.translatedAt && <span>译于 {skill.translatedAt.slice(0, 10)}</span>}
        {!enabled && <span className="text-slate-400">已停用</span>}
      </div>

      <div className="mt-3 flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
        <div className="ml-auto flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
          {isAgentEntry ? (
            onMigrate && (
              <button
                onClick={onMigrate}
                disabled={sharedExists}
                title={
                  sharedExists
                    ? '共享库已存在同名技能，请先处理重名'
                    : '把该技能复制进共享库（agent 原副本保留）'
                }
                className="flex items-center gap-1 rounded bg-blue-500/10 px-2 py-1 text-blue-500 hover:bg-blue-500/20 disabled:opacity-50"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                {sharedExists ? '已在共享库' : '迁移到共享库'}
              </button>
            )
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
