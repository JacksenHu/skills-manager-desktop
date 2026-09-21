import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BadgeCheck, Download, ExternalLink, Package, RefreshCw, Search, X } from 'lucide-react'
import type {
  AppConfig,
  BotCategory,
  BotCompleteness,
  BotInstallResult,
  BotListResult,
  BotSkill,
  BotSkillDetail,
  IpcResult
} from '@shared/types'
import { Modal, ResultModal } from './Modal'
import { runLoggedTask } from '../store/taskLog'

/**
 * SkillsBot（skillsbot.cn）技能库面板 —— 全程免登录。
 *
 * 数据来源全部是站点公开接口（分类 / 搜索 / 热门 / 最新 / 详情）。
 * 安装 = 把详情接口返回的完整 SKILL.md 落盘进共享库；
 * ZIP 完整包需要登录 token（站点 /github/skillfile/** 整个命名空间挂鉴权），
 * 因此本面板对「包内含附加文件」的技能会显式标注不完整，不假装装全了。
 */

type Source = 'hot' | 'new' | 'category' | 'search'

const SOURCE_TABS: { key: Source; label: string }[] = [
  { key: 'hot', label: '热门' },
  { key: 'new', label: '最新' },
  { key: 'category', label: '分类' },
  { key: 'search', label: '搜索' }
]

const COMPLETENESS_META: Record<BotCompleteness, { label: string; cls: string; hint: string }> = {
  'md-only': {
    label: '可完整安装',
    cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    hint: '该技能正文即全部内容，免登录安装视为完整安装'
  },
  'has-extras': {
    label: '含附加文件',
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    hint: '完整包内还有脚本/词表等附加文件，免登录只能装 SKILL.md 正文'
  },
  unknown: {
    label: '完整性未知',
    cls: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    hint: '站点未提供包体积，无法判断包内是否含附加文件'
  }
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="text-xs text-slate-500 dark:text-slate-400">
      {label} <span className="font-medium text-slate-700 dark:text-slate-200">{value}</span>
    </span>
  )
}

export function SkillsBotPanel({
  refreshTick,
  config
}: {
  refreshTick: number
  config: AppConfig | null
}) {
  const [catType, setCatType] = useState<1 | 2>(1)
  const [categories, setCategories] = useState<BotCategory[]>([])
  const [gotCategories, setGotCategories] = useState(false)

  const [source, setSource] = useState<Source>('hot')
  const [rootId, setRootId] = useState<number | null>(null)
  const [subId, setSubId] = useState<number | null>(null)

  const [hot, setHot] = useState<BotSkill[]>([])
  const [newest, setNewest] = useState<BotSkill[]>([])

  const [skills, setSkills] = useState<BotSkill[]>([])
  const [total, setTotal] = useState(-1)
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(1)

  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [kwInput, setKwInput] = useState('')
  const [keyword, setKeyword] = useState('')

  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<BotSkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [installing, setInstalling] = useState<string | null>(null)
  const [result, setResult] = useState<{ title: string; logs: string[] } | null>(null)

  /** 丢弃过期响应（切分类/搜索时旧请求可能后到） */
  const reqId = useRef(0)

  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  // ---------- 首屏：分类树 + 热门 + 最新 ----------
  const bootstrap = useCallback(async (type: 1 | 2) => {
    const r = (await window.api.bot.bootstrap(type)) as IpcResult<{
      categories: BotCategory[]
      hot: BotSkill[]
      newest: BotSkill[]
    }>
    if (!r.ok) {
      setError(r.error)
      setGotCategories(true)
      return
    }
    setError(null)
    setCategories(r.data.categories ?? [])
    setHot(r.data.hot ?? [])
    setNewest(r.data.newest ?? [])
    setGotCategories(true)
  }, [])

  useEffect(() => {
    void bootstrap(catType)
  }, [bootstrap, catType, refreshTick])

  // ---------- 列表加载（分类 / 搜索） ----------
  const loadList = useCallback(
    async (targetPage: number, append: boolean) => {
      if (source !== 'category' && source !== 'search') return
      if (append) setLoadingMore(true)
      else setLoading(true)

      const my = ++reqId.current
      const activeType = catType
      try {
        let r: IpcResult<BotListResult>
        if (source === 'search') {
          r = (await window.api.bot.search({
            keyword,
            page: targetPage,
            type: activeType
          })) as IpcResult<BotListResult>
        } else {
          const catId = subId ?? rootId
          if (catId === null) {
            setSkills([])
            setTotal(-1)
            setHasMore(false)
            return
          }
          r = (await window.api.bot.listByCategory({
            categoryId: catId,
            page: targetPage,
            type: activeType
          })) as IpcResult<BotListResult>
        }

        if (my !== reqId.current) return // 过期响应丢弃
        if (!r.ok) {
          setError(r.error)
          if (!append) setSkills([])
          return
        }
        setError(null)
        setTotal(r.data.total)
        setHasMore(r.data.hasMore)
        setPage(targetPage)
        setSkills((prev) => (append ? [...prev, ...r.data.skills] : r.data.skills))
      } catch (e) {
        if (my === reqId.current) setError(errText(e))
      } finally {
        if (my === reqId.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [source, keyword, rootId, subId, catType]
  )

  // 分类/搜索条件变化 → 重新从第 1 页拉
  useEffect(() => {
    if (source === 'category' || source === 'search') void loadList(1, false)
  }, [loadList, source])

  // ---------- 详情 ----------
  const openDetail = async (skill: BotSkill) => {
    setDetailId(skill.id)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const r = (await window.api.bot.detail(skill.id)) as IpcResult<BotSkillDetail>
      if (!r.ok) setDetailError(r.error)
      else setDetail(r.data)
    } catch (e) {
      setDetailError(errText(e))
    } finally {
      setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    setDetailId(null)
    setDetail(null)
    setDetailError(null)
  }

  // ---------- 安装 ----------
  const doInstall = async (skill: BotSkill | BotSkillDetail) => {
    setInstalling(skill.id)
    const res = await runLoggedTask(`安装 SkillsBot 技能：${skill.name}`, 'SkillsBot', async () => {
      const r = (await window.api.bot.install(skill.id, { replace: true })) as IpcResult<BotInstallResult>
      if (!r.ok) throw new Error(r.error)
      return r.data
    })
    setInstalling(null)
    if (res.ok) {
      setResult({ title: `安装 ${skill.name}`, logs: res.data.logs })
      closeDetail()
      // 重标「已安装」：热榜/最新走 bootstrap，列表走 loadList
      if (source === 'category' || source === 'search') void loadList(1, false)
      else void bootstrap(catType)
    } else {
      setResult({ title: `安装失败：${skill.name}`, logs: [`[X] ${res.error}`] })
    }
  }

  // ---------- 派生数据 ----------
  const shownSkills: BotSkill[] =
    source === 'hot' ? hot : source === 'new' ? newest : skills

  const activeRoot = categories.find((c) => c.id === rootId) ?? null
  const subCategories = activeRoot?.children ?? []

  const pickRoot = (id: number | null) => {
    setRootId(id)
    setSubId(null)
  }

  const submitSearch = () => {
    const kw = kwInput.trim()
    if (!kw) return
    setKeyword(kw)
    setSource('search')
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 免登录说明条 */}
      <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
        <Package className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          免登录模式：分类 / 搜索 / 详情全部来自 skillsbot.cn 公开接口，安装即把完整 SKILL.md 写入共享库。
          站点把每个技能另打包成 ZIP，但 ZIP 下载需要登录（接口整个命名空间挂鉴权），
          因此包内含脚本等附加文件的技能会标注「含附加文件」并列出缺哪些，不会假装装全。
        </span>
      </div>

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
          {SOURCE_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                if (t.key === 'search' && !keyword) return
                setSource(t.key)
              }}
              className={
                'rounded-md px-3 py-1 text-xs transition ' +
                (source === t.key
                  ? 'bg-sky-500 font-medium text-white'
                  : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800')
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setCatType(1)}
            className={
              'rounded-md px-2 py-1 text-xs ' +
              (catType === 1
                ? 'bg-slate-200 font-medium dark:bg-slate-700'
                : 'text-slate-500 dark:text-slate-400')
            }
            title="常规分类体系"
          >
            常规
          </button>
          <button
            onClick={() => setCatType(2)}
            className={
              'rounded-md px-2 py-1 text-xs ' +
              (catType === 2
                ? 'bg-slate-200 font-medium dark:bg-slate-700'
                : 'text-slate-500 dark:text-slate-400')
            }
            title="物理 AI 分类体系（站点 type=2）"
          >
            物理 AI
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch()
              }}
              placeholder="搜索技能，回车确认"
              className="w-48 bg-transparent text-xs outline-none placeholder:text-slate-400"
            />
            {kwInput && (
              <button
                onClick={() => {
                  setKwInput('')
                  setKeyword('')
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => void bootstrap(catType)}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
            title="刷新"
          >
            <RefreshCw className={'h-3.5 w-3.5 ' + (loading ? 'animate-spin' : '')} />
          </button>
        </div>
      </div>

      {/* 分类 chips（两级） */}
      {source === 'category' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => pickRoot(null)}
              className={
                'rounded-full px-2.5 py-1 text-xs ' +
                (rootId === null
                  ? 'bg-sky-500 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300')
              }
            >
              全部分类
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => pickRoot(c.id)}
                className={
                  'rounded-full px-2.5 py-1 text-xs ' +
                  (rootId === c.id
                    ? 'bg-sky-500 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300')
                }
              >
                {c.name}
              </button>
            ))}
            {!gotCategories && <span className="px-2 text-xs text-slate-400">分类加载中…</span>}
          </div>

          {subCategories.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-2">
              <button
                onClick={() => setSubId(null)}
                className={
                  'rounded-full px-2 py-0.5 text-[11px] ' +
                  (subId === null
                    ? 'bg-slate-300 text-slate-800 dark:bg-slate-600 dark:text-slate-100'
                    : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800')
                }
              >
                全部
              </button>
              {subCategories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSubId(c.id)}
                  className={
                    'rounded-full px-2 py-0.5 text-[11px] ' +
                    (subId === c.id
                      ? 'bg-slate-300 text-slate-800 dark:bg-slate-600 dark:text-slate-100'
                      : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800')
                  }
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 错误 */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          加载失败：{error}
        </div>
      )}

      {/* 列表 */}
      {loading ? (
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
          ))}
        </div>
      ) : source === 'category' && rootId === null ? (
        <div className="py-10 text-center text-sm text-slate-400">请选择上方分类</div>
      ) : source === 'search' && !keyword ? (
        <div className="py-10 text-center text-sm text-slate-400">输入关键词后回车搜索</div>
      ) : shownSkills.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-400">没有找到技能</div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {shownSkills.map((s) => (
            <SkillCard
              key={s.id}
              skill={s}
              installing={installing === s.id}
              onOpen={() => void openDetail(s)}
              onInstall={() => void doInstall(s)}
            />
          ))}
        </div>
      )}

      {/* 加载更多（仅分类/搜索分页视图） */}
      {(source === 'category' || source === 'search') && hasMore && (
        <div className="flex justify-center">
          <button
            disabled={loadingMore}
            onClick={() => void loadList(page + 1, true)}
            className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {loadingMore ? '加载中…' : `加载更多（已显示 ${shownSkills.length}${total >= 0 ? ` / ${total}` : ''}）`}
          </button>
        </div>
      )}

      {/* 详情弹窗 */}
      {detailId !== null && (
        <Modal title="技能详情" onClose={closeDetail} width="max-w-2xl">
          {detailLoading && <div className="py-8 text-center text-sm text-slate-400">加载中…</div>}
          {detailError && <div className="py-4 text-sm text-red-600 dark:text-red-400">{detailError}</div>}
          {detail && (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-medium">{detail.name}</div>
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {[detail.parentCategoryName, detail.categoryName].filter(Boolean).join(' / ') || '未分类'}
                    {detail.enName ? ` · ${detail.enName}` : ''}
                  </div>
                </div>
                <span
                  className={'shrink-0 rounded-full px-2 py-0.5 text-[11px] ' + COMPLETENESS_META[detail.completeness].cls}
                  title={COMPLETENESS_META[detail.completeness].hint}
                >
                  {COMPLETENESS_META[detail.completeness].label}
                </span>
              </div>

              <div className="flex flex-wrap gap-3">
                <Stat label="浏览" value={detail.viewCount} />
                <Stat label="下载" value={detail.downloadCount} />
                <Stat label="版本" value={detail.version ?? '-'} />
                <Stat label="包体积" value={detail.fileSize ? `${detail.fileSize} B` : '-'} />
                <Stat label="作者" value={detail.githubProjectName || '-'} />
              </div>

              <div className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">{detail.description}</div>

              {detail.unescaped && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400">
                  平台正文含字面量 \n，安装时已自动还原为真实换行
                </div>
              )}

              {detail.completeness === 'has-extras' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="flex items-center gap-1 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5" /> 免登录安装不完整
                  </div>
                  <div className="mt-1">
                    该技能完整 ZIP 包内还有附加文件，免登录只能写入 SKILL.md 正文。正文引用到的文件：
                    {detail.missingRefs.length > 0 ? (
                      <span className="ml-1 font-mono">{detail.missingRefs.join(', ')}</span>
                    ) : (
                      <span className="ml-1">（正文未列出具体文件名）</span>
                    )}
                  </div>
                  <div className="mt-1 opacity-80">清单为启发式识别，仅供参考；如需完整包请到站点登录后下载。</div>
                </div>
              )}

              <div>
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                  SKILL.md 正文（{detail.detail.length} 字符）
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-[11px] leading-relaxed text-slate-700 dark:bg-slate-900 dark:text-slate-300">
                  {detail.detail.slice(0, 6000)}
                  {detail.detail.length > 6000 ? '\n\n…（已截断）' : ''}
                </pre>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => void window.api.app.openExternal(detail.botUrl)}
                  className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> 在 SkillsBot 查看
                </button>
                <button
                  disabled={installing === detail.id}
                  onClick={() => void doInstall(detail)}
                  className="flex items-center gap-1 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  {installing === detail.id ? '安装中…' : detail.installed ? '重新安装到共享库' : '安装到共享库'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* 结果弹窗 */}
      {result && (
        <ResultModal title={result.title} logs={result.logs} onClose={() => setResult(null)} />
      )}
    </div>
  )
}

function SkillCard({
  skill,
  installing,
  onOpen,
  onInstall
}: {
  skill: BotSkill
  installing: boolean
  onOpen: () => void
  onInstall: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-sky-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-sky-700">
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium" title={skill.name}>
            {skill.name}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
            {[skill.parentCategoryName, skill.categoryName].filter(Boolean).join(' / ') || '未分类'}
          </div>
        </button>
        {skill.installed && (
          <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            <BadgeCheck className="h-3 w-3" />
            已安装
          </span>
        )}
      </div>

      <button onClick={onOpen} className="line-clamp-2 text-left text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
        {skill.description || '（无简介）'}
      </button>

      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <Stat label="浏览" value={skill.viewCount} />
          <Stat label="下载" value={skill.downloadCount} />
        </div>
        <button
          disabled={installing}
          onClick={onInstall}
          className="flex items-center gap-1 rounded-lg bg-sky-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-600 disabled:opacity-50"
        >
          <Download className="h-3 w-3" />
          {installing ? '安装中' : skill.installed ? '重装' : '安装'}
        </button>
      </div>
    </div>
  )
}
