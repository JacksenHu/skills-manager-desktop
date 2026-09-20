import { useCallback, useEffect, useRef, useState } from 'react'
import { BadgeCheck, Download, ExternalLink, RefreshCw, Search, Star, X } from 'lucide-react'
import type {
  AppConfig,
  HubCategory,
  HubSkill,
  HubSkillDetail,
  IpcResult,
  OpResult
} from '@shared/types'
import { Modal, ResultModal } from './Modal'

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

export function SkillHubPanel({
  refreshTick,
  config
}: {
  refreshTick: number
  config: AppConfig | null
}) {
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
      try {
        const r = (await window.api.hub.install(slug, namespace, true)) as IpcResult<OpResult>
        if (!r.ok) throw new Error(r.error)
        setOpResult({ title, logs: r.data.logs })
        void refreshInstalled()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
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

  return (
    <>
      {/* 二级：排序标签 */}
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
