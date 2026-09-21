import { useCallback, useEffect, useRef, useState } from 'react'
import { BadgeCheck, Download, ExternalLink, Package, Plus, RefreshCw, Search, Star, Trash2, X } from 'lucide-react'
import type {
  AppConfig,
  HubCategory,
  HubSkill,
  HubSkillDetail,
  IpcResult,
  MarketManifest,
  MarketPlugin,
  MarketSource,
  OpResult
} from '@shared/types'
import { Modal, ResultModal } from './Modal'
import { useTaskLog } from '../store/taskLog'

const SORT_TABS = [
  { key: 'score', label: '全部' },
  { key: 'installs', label: '近期飙升' },
  { key: 'downloads', label: '下载热榜' },
  { key: 'updated_at', label: '最近上新' }
]

const PAGE_SIZE = 24

function fmtCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  return String(n)
}

// ---------- 套件视图（市场选择 → 套件卡片 → 详情弹窗/安装） ----------

function PackagesView({ onError }: { onError: (msg: string) => void }) {
  const [sources, setSources] = useState<MarketSource[]>([])
  const [activeMarket, setActiveMarket] = useState<string>('')
  const [manifest, setManifest] = useState<MarketManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [marketError, setMarketError] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addType, setAddType] = useState<'git' | 'zip' | 'directory'>('git')
  const [addUrl, setAddUrl] = useState('')

  const [detailPlugin, setDetailPlugin] = useState<MarketPlugin | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [result, setResult] = useState<{ title: string; logs: string[] } | null>(null)

  const loadSources = useCallback(async () => {
    const r = (await window.api.market.sources()) as IpcResult<MarketSource[]>
    if (r.ok) {
      setSources(r.data)
      setActiveMarket((prev) => prev || r.data[0]?.name || '')
    } else {
      onError(r.error)
    }
  }, [onError])

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  const loadMarket = useCallback(async (name: string) => {
    setLoading(true)
    setMarketError(null)
    setManifest(null)
    try {
      const r = (await window.api.market.list(name)) as IpcResult<MarketManifest>
      if (!r.ok) throw new Error(r.error)
      setManifest(r.data)
    } catch (e) {
      setMarketError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeMarket) void loadMarket(activeMarket)
  }, [activeMarket, loadMarket])

  const install = useCallback(
    async (marketName: string, plugin: MarketPlugin) => {
      setInstalling(plugin.name)
      const { start, finish, fail } = useTaskLog.getState()
      const title = `安装套件：${plugin.name}`
      const taskId = start(title, '市场')
      try {
        const r = (await window.api.market.install(marketName, plugin.name)) as IpcResult<OpResult>
        if (!r.ok) throw new Error(r.error)
        setResult({ title, logs: r.data.logs })
        finish(taskId, r.data.logs)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        onError(msg)
        fail(taskId, msg)
      } finally {
        setInstalling(null)
      }
    },
    [onError]
  )

  const activeSource = sources.find((m) => m.name === activeMarket)

  return (
    <>
      {/* 三级：市场 chips + 添加市场 */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {sources.map((m) => (
          <button
            key={m.name}
            onClick={() => setActiveMarket(m.name)}
            className={
              'rounded-full px-2.5 py-1 text-xs transition ' +
              (activeMarket === m.name
                ? 'bg-sky-500 text-white'
                : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
            }
          >
            {m.name}
            <span className="ml-1 opacity-60">{m.type}</span>
          </button>
        ))}
        <button
          onClick={() => setAddOpen(true)}
          title="添加市场（git 仓库 / zip 包 / 本地目录）"
          className="flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:border-sky-400 hover:text-sky-500 dark:border-slate-600 dark:text-slate-400"
        >
          <Plus className="h-3 w-3" />
          添加市场
        </button>
        {activeMarket && (
          <button
            onClick={() => void loadMarket(activeMarket)}
            disabled={loading}
            title="刷新市场（重新拉取清单）"
            className="rounded-full p-1.5 text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
        {activeSource && !activeSource.builtin && (
          <button
            onClick={async () => {
              const r = (await window.api.market.removeSource(activeSource.name)) as IpcResult<unknown>
              if (r.ok) {
                setActiveMarket('')
                await loadSources()
              } else onError(r.error)
            }}
            title="删除该自定义市场"
            className="rounded-full p-1.5 text-slate-400 hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {marketError && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
          <span className="break-all">{marketError}</span>
          <button onClick={() => void loadMarket(activeMarket)} className="shrink-0 text-xs underline">
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            />
          ))}
        </div>
      ) : manifest && manifest.plugins.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <div className="font-medium">该市场没有可用套件</div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            换个市场，或点「添加市场」接入新的套件来源。
          </div>
        </div>
      ) : null}

      {manifest && (
        <>
          <div className="mb-2 text-xs text-slate-400">
            {manifest.description || manifest.name} · {manifest.plugins.length} 个套件（安装后技能进入共享库并归类「套件」）
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {manifest.plugins.map((p) => (
              <div
                key={p.name}
                onClick={() => setDetailPlugin(p)}
                className="group cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:border-red-400/60 hover:shadow-lg hover:shadow-red-500/5 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-start gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/15">
                    <Package className="h-4 w-4 text-red-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="text-[10px] text-slate-400">
                      {p.category ?? '套件'}
                      {p.version ? ` · v${p.version}` : ''}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] text-red-500">套件</span>
                </div>
                <div className="mt-2 line-clamp-2 min-h-[2.4rem] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  {p.description || '（无描述）'}
                </div>
                <div className="mt-2 text-[10px] text-slate-400">{p.skillDirs.length} 个技能</div>
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void install(activeMarket, p)
                    }}
                    disabled={installing !== null}
                    className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-600 disabled:opacity-50"
                  >
                    {installing === p.name ? '安装中…' : '安装套件'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 添加市场弹窗 */}
      {addOpen && (
        <Modal title="添加市场" onClose={() => setAddOpen(false)}>
          <div className="space-y-3 text-sm">
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="市场名称（如 my-market）"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs outline-none focus:border-sky-400 dark:border-slate-600"
            />
            <div className="flex gap-1.5">
              {(['git', 'zip', 'directory'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setAddType(t)}
                  className={
                    'rounded-lg px-2.5 py-1 text-xs transition ' +
                    (addType === t
                      ? 'bg-sky-500 text-white'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
                  }
                >
                  {t === 'git' ? 'git 仓库' : t === 'zip' ? 'zip 包' : '本地目录'}
                </button>
              ))}
            </div>
            <input
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              placeholder={
                addType === 'git'
                  ? 'https://host/group/repo.git'
                  : addType === 'zip'
                    ? 'https://example.com/marketplace.zip'
                    : 'D:\\path\\to\\marketplace（本地）'
              }
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              市场需含 .codebuddy-plugin/marketplace.json 清单（与 WorkBuddy 插件市场同格式）。git 源走系统 git clone --depth 1。
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setAddOpen(false)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              取消
            </button>
            <button
              onClick={async () => {
                if (!addName.trim() || !addUrl.trim()) return
                const r = (await window.api.market.addSource({
                  name: addName.trim(),
                  type: addType,
                  url: addUrl.trim()
                })) as IpcResult<unknown>
                if (r.ok) {
                  setAddOpen(false)
                  setAddName('')
                  setAddUrl('')
                  setActiveMarket(addName.trim())
                  await loadSources()
                  void loadMarket(addName.trim())
                } else {
                  onError(r.error)
                }
              }}
              disabled={!addName.trim() || !addUrl.trim()}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
            >
              添加
            </button>
          </div>
        </Modal>
      )}

      {/* 套件详情弹窗 */}
      {detailPlugin && manifest && (
        <Modal title={`套件：${detailPlugin.name}`} onClose={() => setDetailPlugin(null)} width="max-w-2xl">
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-500">套件</span>
              {detailPlugin.version && <span className="text-xs text-slate-400">v{detailPlugin.version}</span>}
              {detailPlugin.category && <span className="text-xs text-slate-400">{detailPlugin.category}</span>}
              <span className="ml-auto text-xs text-slate-400">
                来自 {manifest.name} · {detailPlugin.skillDirs.length} 个技能
              </span>
            </div>
            <div className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {detailPlugin.description || '（无描述）'}
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
              <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">包含的技能：</div>
              <div className="max-h-52 space-y-1 overflow-auto">
                {detailPlugin.skillDirs.map((s) => (
                  <div key={s} className="flex items-center gap-2 font-mono text-xs">
                    <Package className="h-3 w-3 shrink-0 text-red-400" />
                    <span className="truncate">{s}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              安装后这些技能会平铺进共享库并自动归类「套件」，所有已接入 Agent 即刻可用；已存在的同名技能会被套件版本覆盖。
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setDetailPlugin(null)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              关闭
            </button>
            <button
              onClick={() => {
                void install(activeMarket, detailPlugin)
                setDetailPlugin(null)
              }}
              disabled={installing !== null}
              className="rounded-lg bg-red-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {installing === detailPlugin.name ? '安装中…' : '安装套件'}
            </button>
          </div>
        </Modal>
      )}

      {result && <ResultModal title={result.title} logs={result.logs} onClose={() => setResult(null)} />}
    </>
  )
}

export function SkillHubPanel({
  refreshTick,
  config
}: {
  refreshTick: number
  config: AppConfig | null
}) {
  const [view, setView] = useState<'skills' | 'packages'>('skills')
  const [sortBy, setSortBy] = useState('score')
  const [category, setCategory] = useState('')
  const [keyword, setKeyword] = useState('')
  const [kwInput, setKwInput] = useState('')
  const [categories, setCategories] = useState<HubCategory[]>([])

  const [skills, setSkills] = useState<HubSkill[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [installedKeys, setInstalledKeys] = useState<Set<string>>(new Set())
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [opResult, setOpResult] = useState<{ title: string; logs: string[] } | null>(null)

  const [detail, setDetail] = useState<HubSkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const reqId = useRef(0)

  /** 拉共享库来源列表，判断已安装 */
  const refreshInstalled = useCallback(async () => {
    const r = (await window.api.skills.list()) as IpcResult<{ source?: string; slug?: string }[]>
    if (r.ok) {
      const set = new Set<string>()
      for (const s of r.data) {
        if (s.source) set.add(s.source)
      }
      setInstalledKeys(set)
    }
  }, [])

  const load = useCallback(
    async (pageNo: number, append: boolean) => {
      const id = ++reqId.current
      append ? setLoadingMore(true) : setLoading(true)
      if (!append) setError(null)
      try {
        const r = (await window.api.hub.listWithCategories({
          page: pageNo,
          sortBy,
          keyword: keyword.trim() || undefined,
          category: category || undefined
        })) as IpcResult<{ categories: HubCategory[]; skills: HubSkill[]; total: number }>
        if (id !== reqId.current) return // 已有更新的请求，丢弃过期结果
        if (!r.ok) throw new Error(r.error)
        setCategories(r.data.categories)
        setSkills((prev) => (append ? [...prev, ...r.data.skills] : r.data.skills))
        setTotal(r.data.total)
        setPage(pageNo)
        if (!append) setError(null)
      } catch (e) {
        if (id === reqId.current) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (id === reqId.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [sortBy, keyword, category]
  )

  useEffect(() => {
    void load(1, false)
    void refreshInstalled()
  }, [sortBy, category, keyword, refreshTick, load, refreshInstalled])

  const isInstalled = useCallback(
    (s: HubSkill) => installedKeys.has(`https://skillhub.cn/skills/${s.namespace}/${s.slug}`),
    [installedKeys]
  )

  const install = useCallback(
    async (slug: string, namespace: string, title: string) => {
      setInstallingSlug(slug)
      const { start, finish, fail } = useTaskLog.getState()
      const taskId = start(title, '市场')
      try {
        const r = (await window.api.hub.install(slug, namespace, true)) as IpcResult<OpResult>
        if (!r.ok) throw new Error(r.error)
        setOpResult({ title, logs: r.data.logs })
        finish(taskId, r.data.logs)
        void refreshInstalled()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        fail(taskId, msg)
      } finally {
        setInstallingSlug(null)
      }
    },
    [refreshInstalled]
  )

  const openDetail = useCallback(async (s: HubSkill) => {
    setDetailLoading(true)
    setDetailError(null)
    setDetail({ ...s, summary: s.description, overviewMd: '', createdAt: 0, versionsCount: 0, filesCount: 0, requiresApiKey: false } as HubSkillDetail)
    try {
      const r = (await window.api.hub.detail(s.slug, s.namespace)) as IpcResult<HubSkillDetail>
      if (!r.ok) throw new Error(r.error)
      setDetail(r.data)
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const submitSearch = useCallback(() => setKeyword(kwInput.trim()), [kwInput])

  if (view === 'packages') {
    return (
      <>
        {/* 二级：技能列表 / 套件 切换（套件视图下排序标签禁用态展示） */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-900">
            {SORT_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setView('skills')}
                className="rounded-md px-3 py-1.5 text-sm text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                {t.label}
              </button>
            ))}
            <button className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white">
              套件
            </button>
          </div>
          <span className="ml-auto text-xs text-slate-400">
            套件市场：与 WorkBuddy 插件市场同格式（.codebuddy-plugin/marketplace.json）
          </span>
        </div>
        <PackagesView onError={(msg) => setError(msg)} />
        {error && (
          <div className="mt-4 flex items-start justify-between gap-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
            <span className="break-all">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-xs underline">
              关闭
            </button>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {/* 二级：排序标签 + 套件入口 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg bg-slate-200/70 p-0.5 dark:bg-slate-900">
          {SORT_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setSortBy(t.key)}
              className={
                'rounded-md px-3 py-1.5 text-sm transition ' +
                (sortBy === t.key
                  ? 'bg-white font-medium text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200')
              }
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => setView('packages')}
            title="技能套件市场（WorkBuddy 同款）"
            className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <Package className="h-3.5 w-3.5" />
            套件
          </button>
        </div>

        {/* 搜索框 */}
        <div className="relative ml-auto w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={kwInput}
            onChange={(e) => setKwInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
            placeholder="搜索 SkillHub 技能…"
            className="w-full rounded-lg border border-slate-300 bg-transparent py-1.5 pl-8 pr-7 text-sm outline-none focus:border-sky-400 dark:border-slate-600"
          />
          {kwInput && (
            <button
              onClick={() => {
                setKwInput('')
                setKeyword('')
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button
          onClick={() => void load(1, false)}
          disabled={loading}
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800/70"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 三级：分类 chips（动态拉取，自动归类） */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setCategory('')}
          className={
            'rounded-full px-2.5 py-1 text-xs transition ' +
            (category === ''
              ? 'bg-sky-500 text-white'
              : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
          }
        >
          全部分类
        </button>
        {categories.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategory(category === c.key ? '' : c.key)}
            className={
              'rounded-full px-2.5 py-1 text-xs transition ' +
              (category === c.key
                ? 'bg-sky-500 text-white'
                : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
            }
          >
            {c.name}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
          <span className="break-all">{error}</span>
          <button onClick={() => void load(1, false)} className="shrink-0 text-xs underline">
            重试
          </button>
          <button onClick={() => setError(null)} className="shrink-0 text-xs underline">
            关闭
          </button>
        </div>
      )}

      {/* 卡片网格 */}
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            />
          ))}
        </div>
      ) : skills.length === 0 && !error ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <div className="font-medium">没有匹配的技能</div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            换个关键词或分类试试；SkillHub 数据来自 skillhub.cn 平台。
          </div>
        </div>
      ) : (
        <>
          <div className="mb-2 text-xs text-slate-400">
            共 {fmtCount(total)} 个技能 · 当前显示 {skills.length} 个
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {skills.map((s) => {
              const installed = isInstalled(s)
              return (
                <div
                  key={`${s.namespace}/${s.slug}`}
                  onClick={() => void openDetail(s)}
                  className="group cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 hover:shadow-lg hover:shadow-sky-500/5 dark:border-slate-800 dark:bg-slate-900"
                >
                  <div className="flex items-start gap-2.5">
                    {s.iconUrl ? (
                      <img
                        src={s.iconUrl}
                        alt=""
                        className="h-9 w-9 shrink-0 rounded-lg object-cover"
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.visibility = 'hidden'
                        }}
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sm font-bold text-sky-500">
                        {s.name.slice(0, 1)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{s.name}</span>
                        {s.verified && <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-sky-500" />}
                      </div>
                      <div className="text-[10px] text-slate-400">{s.categoryName}</div>
                    </div>
                    {installed && (
                      <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">
                        已安装
                      </span>
                    )}
                  </div>

                  <div className="mt-2 line-clamp-2 min-h-[2.4rem] text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    {s.description || '（无简介）'}
                  </div>

                  <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <Download className="h-3 w-3" />
                      {fmtCount(s.downloads)}
                    </span>
                    {s.stars > 0 && (
                      <span className="flex items-center gap-1">
                        <Star className="h-3 w-3" />
                        {fmtCount(s.stars)}
                      </span>
                    )}
                    {s.version && <span>v{s.version}</span>}
                  </div>

                  <div className="mt-3 flex items-center justify-end">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void install(s.slug, s.namespace, `安装 SkillHub 技能：${s.name}`)
                      }}
                      disabled={installingSlug !== null}
                      className={
                        'rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ' +
                        (installed
                          ? 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                          : 'bg-sky-500 text-white hover:bg-sky-600')
                      }
                    >
                      {installingSlug === s.slug ? '安装中…' : installed ? '重装/更新' : '安装'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {skills.length < total && (
            <div className="mt-5 text-center">
              <button
                onClick={() => void load(page + 1, true)}
                disabled={loadingMore}
                className="rounded-lg bg-sky-500/10 px-5 py-2 text-sm text-sky-500 transition hover:bg-sky-500/20 disabled:opacity-50"
              >
                {loadingMore ? '加载中…' : `加载更多（已显示 ${skills.length} / ${fmtCount(total)}）`}
              </button>
            </div>
          )}
        </>
      )}

      {/* 详情弹窗 */}
      {detail && (
        <Modal
          title={detailLoading ? '加载详情…' : detail.name}
          onClose={() => setDetail(null)}
          width="max-w-2xl"
        >
          {detailError && (
            <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{detailError}</div>
          )}
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              {detail.verified && (
                <span className="flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-500">
                  <BadgeCheck className="h-3.5 w-3.5" />
                  已认证
                </span>
              )}
              <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {detail.categoryName}
              </span>
              {detail.version && (
                <span className="text-xs text-slate-400">v{detail.version}</span>
              )}
              {detail.requiresApiKey && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500">需配置 API Key</span>
              )}
            </div>

            <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1">
                <Download className="h-3.5 w-3.5" />
                下载 {fmtCount(detail.downloads)}
              </span>
              <span className="flex items-center gap-1">
                <Download className="h-3.5 w-3.5" />
                安装 {fmtCount(detail.installs)}
              </span>
              {detail.stars > 0 && (
                <span className="flex items-center gap-1">
                  <Star className="h-3.5 w-3.5" />
                  {fmtCount(detail.stars)}
                </span>
              )}
              {detail.versionsCount > 0 && <span>{detail.versionsCount} 个版本</span>}
            </div>

            <div className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {detail.summary || detail.description || '（无简介）'}
            </div>

            {detail.overviewMd && (
              <div className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                <pre className="whitespace-pre-wrap font-sans">{detail.overviewMd.slice(0, 6000)}</pre>
              </div>
            )}

            <div className="flex items-center justify-between">
              <a
                href={detail.hubUrl}
                onClick={(e) => {
                  e.preventDefault()
                  void window.api.app.openPath(detail.hubUrl)
                }}
                className="flex items-center gap-1 text-xs text-sky-500 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                在 SkillHub 查看
              </a>
              <button
                onClick={() => {
                  void install(detail.slug, detail.namespace, `安装 SkillHub 技能：${detail.name}`)
                  setDetail(null)
                }}
                disabled={installingSlug !== null}
                className="rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-50"
              >
                {installingSlug === detail.slug ? '安装中…' : '安装到共享库'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {opResult && (
        <ResultModal title={opResult.title} logs={opResult.logs} onClose={() => setOpResult(null)} />
      )}
    </>
  )
}
