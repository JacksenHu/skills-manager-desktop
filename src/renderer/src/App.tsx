import { useCallback, useEffect, useState } from 'react'
import { HardDrive, Link2, Monitor, Moon, RefreshCw, Search, Settings, Store, Sun } from 'lucide-react'
import type {
  AgentStatus,
  AppConfig,
  CreatePlan,
  DetectPresetsResult,
  IpcResult,
  MergePlan,
  OpResult
} from '@shared/types'
import { AgentCard } from './components/AgentCard'
import { SkillsPanel } from './components/SkillsPanel'
import { SkillHubPanel } from './components/SkillHubPanel'
import { UpdatesPanel } from './components/UpdatesPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { CreateConfirm, MergeConfirm, ResultModal, ConfirmDialog, Modal } from './components/Modal'

type Tab = 'connect' | 'detect' | 'skills' | 'hub' | 'updates'

const TABS: { key: Tab; label: string }[] = [
  { key: 'connect', label: '联接' },
  { key: 'detect', label: '探测' },
  { key: 'skills', label: '技能库' },
  { key: 'hub', label: 'SkillHub' },
  { key: 'updates', label: '更新' }
]

/** 待确认操作（二次确认弹窗的数据源） */
type Pending =
  | { kind: 'create'; plan: CreatePlan }
  | { kind: 'remove'; key: string; path: string }
  | { kind: 'merge'; plan: MergePlan; keepPath: string }
  | null

export default function App() {
  const [tab, setTab] = useState<Tab>('connect')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [agents, setAgents] = useState<AgentStatus[]>([])
  /** 联接页合并展示：探测发现"已联接但未配置"的入口（共享库联接存在但没写配置） */
  const [linkedUnconfigured, setLinkedUnconfigured] = useState<AgentStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<{ key: string; path: string } | null>(null)
  const [editKey, setEditKey] = useState('')
  const [editPath, setEditPath] = useState('')

  // P4 操作流状态
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ title: string; logs: string[] } | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // 主题：偏好存配置（system/light/dark），system 跟随 prefers-color-scheme
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  const themePref = config?.ui?.theme ?? 'system'
  const dark = themePref === 'dark' || (themePref === 'system' && systemDark)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  /** 主题按钮：system → light → dark 循环并持久化 */
  const cycleTheme = useCallback(async () => {
    const next = themePref === 'system' ? 'light' : themePref === 'light' ? 'dark' : 'system'
    const r = await window.api.settings.update({ ui: { theme: next } })
    if (r.ok) setConfig(r.data)
  }, [themePref])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [cfg, status, detect] = await Promise.all([
        window.api.config.get() as Promise<IpcResult<AppConfig>>,
        window.api.agents.status() as Promise<IpcResult<AgentStatus[]>>,
        window.api.agents.detectPresets() as Promise<IpcResult<DetectPresetsResult>>
      ])
      if (!cfg.ok) throw new Error(cfg.error)
      setConfig(cfg.data)
      if (!status.ok) throw new Error(status.error)
      setAgents(status.data)

      // 联接页合并：探测到"已联接（指向共享库）但未写入配置"的入口一并展示
      if (detect.ok) {
        const known = new Set(Object.values(cfg.data.agents).map((p) => p.toLowerCase()))
        setLinkedUnconfigured(
          detect.data.detected.filter(
            (d) => d.state === 'active' && !d.configured && !known.has(d.path.toLowerCase())
          )
        )
      } else {
        setLinkedUnconfigured([])
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const activeCount = agents.filter((a) => a.state === 'active').length

  /** 操作成功后统一收尾：关弹窗、刷新两个数据源 */
  const afterOp = useCallback(
    (title: string, r: OpResult) => {
      setPending(null)
      setResult({ title, logs: r.logs })
      void refresh()
      setRefreshTick((t) => t + 1)
    },
    [refresh]
  )

  /** 接入入口：先取预案，再弹确认 */
  const startConnect = useCallback(async (key: string, path: string, dynamic?: boolean) => {
    // 动态预设（Marvis 多用户）共享同一个 preset key，写配置时按路径派生子键防撞车
    const configKey =
      dynamic && path.includes('\\skills\\')
        ? `${key}-${path.split('\\').slice(-3)[0]}`
        : key
    try {
      const r = await window.api.junction.createPlan(configKey, path)
      if (!r.ok) throw new Error(r.error)
      setPending({ kind: 'create', plan: r.data })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const startRemove = useCallback((key: string) => {
    const agent = agents.find((a) => a.key === key)
    if (!agent) return
    setPending({ kind: 'remove', key, path: agent.path })
  }, [agents])

  const startMerge = useCallback(async (groupName: string) => {
    try {
      const r = (await window.api.junction.mergePlan()) as IpcResult<MergePlan[]>
      if (!r.ok) throw new Error(r.error)
      const plan = r.data.find((p) => p.name === groupName)
      if (!plan) throw new Error(`该组当前没有 >= 2 个活跃根，无需归并。`)
      setPending({ kind: 'merge', plan, keepPath: plan.keepPath })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const confirmPending = useCallback(async () => {
    if (!pending) return
    setBusy(true)
    try {
      if (pending.kind === 'create') {
        const r = await window.api.junction.create(pending.plan.key, pending.plan.path)
        if (!r.ok) throw new Error(r.error)
        afterOp(`接入结果：${pending.plan.key}`, r.data)
      } else if (pending.kind === 'remove') {
        const r = await window.api.junction.remove(pending.key)
        if (!r.ok) throw new Error(r.error)
        afterOp(`拆除结果：${pending.key}`, r.data)
      } else {
        const r = await window.api.junction.merge(pending.plan.name, pending.keepPath)
        if (!r.ok) throw new Error(r.error)
        afterOp(`归并结果：${pending.plan.name}`, r.data)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPending(null)
    } finally {
      setBusy(false)
    }
  }, [pending, afterOp])

  /** 打开编辑弹窗（改配置键名 / 路径；只动配置表，不动磁盘联接） */
  const startEditAgent = useCallback((key: string) => {
    const agent = agents.find((a) => a.key === key)
    if (!agent) return
    setEditingAgent({ key, path: agent.path })
    setEditKey(key)
    setEditPath(agent.path)
  }, [agents])

  const confirmEditAgent = useCallback(async () => {
    if (!editingAgent) return
    const nk = editKey.trim()
    const np = editPath.trim()
    if (!nk || !np) return
    try {
      const up = await window.api.config.upsertAgent(nk, np)
      if (!up.ok) throw new Error(up.error)
      if (nk !== editingAgent.key) {
        const rm = await window.api.config.removeAgent(editingAgent.key)
        if (!rm.ok) throw new Error(rm.error)
      }
      setEditingAgent(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [editingAgent, editKey, editPath, refresh])

  return (
    <div className="flex h-screen flex-col bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* 顶部导航（对照 CC Switch） */}
      <header className="flex items-center gap-4 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-sky-500" />
          <span className="font-semibold">技能共享库管理</span>
        </div>

        <nav className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                'rounded-lg px-3 py-1.5 text-sm transition ' +
                (tab === t.key
                  ? 'bg-slate-200 font-medium dark:bg-slate-800'
                  : 'text-slate-500 hover:bg-slate-200/60 dark:text-slate-400 dark:hover:bg-slate-800/60')
              }
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void refresh()}
            disabled={loading}
            title="重新探测"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800/70"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => void cycleTheme()}
            title={`主题：${themePref === 'system' ? '跟随系统' : themePref === 'light' ? '亮色' : '暗色'}（点击切换）`}
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800/70"
          >
            {themePref === 'system' ? (
              <Monitor className="h-4 w-4" />
            ) : dark ? (
              <Moon className="h-4 w-4" />
            ) : (
              <Sun className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title="设置"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800/70"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* 内容区 */}
      <main className="flex-1 overflow-auto p-5">
        {error && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
            <span className="break-all">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-xs underline">
              关闭
            </button>
          </div>
        )}

        {tab === 'connect' && (
          <>
            <div className="mb-4 flex items-center gap-3">
              <HardDrive className="h-4 w-4 text-slate-400" />
              <span className="text-sm text-slate-500 dark:text-slate-400">共享技能库</span>
              <code className="rounded bg-slate-200 px-2 py-0.5 text-xs dark:bg-slate-800">
                {config?.sharedRoot ?? '—'}
              </code>
              <span className="ml-auto text-sm text-slate-500 dark:text-slate-400">
                已接入 {activeCount + linkedUnconfigured.length} / 共 {agents.length + linkedUnconfigured.length}
                {linkedUnconfigured.length > 0 && '（含未配置）'}
              </span>
            </div>

            {agents.length === 0 && linkedUnconfigured.length === 0 ? (
              <Empty
                title="还没有配置任何 Agent"
                hint="去「探测」页点任意 Agent 的「接入」，即可建联接并写入配置。"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {agents.map((a) => (
                  <AgentCard
                    key={a.key}
                    agent={a}
                    onConnect={startConnect}
                    onRemove={startRemove}
                    onEdit={startEditAgent}
                  />
                ))}
                {linkedUnconfigured.map((d) => (
                  <AgentCard key={`unconf|${d.key}|${d.path}`} agent={d} onConnect={startConnect} />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'detect' && (
          <DetectPanel
            sharedRoot={config?.sharedRoot ?? ''}
            refreshTick={refreshTick}
            onConnect={startConnect}
            onRemove={startRemove}
            onMerge={startMerge}
            onEdit={startEditAgent}
          />
        )}

        {tab === 'skills' && <SkillsPanel refreshTick={refreshTick} config={config} />}
        {tab === 'hub' && <SkillHubPanel refreshTick={refreshTick} config={config} />}
        {tab === 'updates' && <UpdatesPanel refreshTick={refreshTick} />}
      </main>

      {/* P4 弹窗层 */}
      {pending?.kind === 'create' && (
        <CreateConfirm
          plan={pending.plan}
          backupEnabled={!!config?.backup?.enabled}
          busy={busy}
          onConfirm={() => void confirmPending()}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'remove' && (
        <ConfirmDialog
          title={`拆除联接：${pending.key}`}
          confirmLabel="确认拆除"
          danger
          busy={busy}
          onConfirm={() => void confirmPending()}
          onClose={() => setPending(null)}
        >
          <code className="block break-all rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
            {pending.path}
          </code>
          <div className="text-slate-600 dark:text-slate-300">
            只拆除联接（「门」），共享库中的技能数据<b>原封不动</b>。之后可随时重新接入。
          </div>
        </ConfirmDialog>
      )}
      {pending?.kind === 'merge' && (
        <MergeConfirm
          plan={pending.plan}
          keepPath={pending.keepPath}
          onKeepChange={(p) => setPending({ ...pending, keepPath: p })}
          busy={busy}
          onConfirm={() => void confirmPending()}
          onClose={() => setPending(null)}
        />
      )}
      {result && (
        <ResultModal title={result.title} logs={result.logs} onClose={() => setResult(null)} />
      )}

      {/* 设置弹窗（导航栏不再单设设置页；Modal 基础组件已自带 70vh 滚动区，这里不再套一层滚动，避免双滚动条） */}
      {settingsOpen && (
        <Modal title="设置" onClose={() => setSettingsOpen(false)} width="max-w-3xl">
          <SettingsPanel
            config={config}
            onConfigChanged={(c) => {
              setConfig(c)
              void refresh()
            }}
          />
        </Modal>
      )}

      {/* 编辑 Agent 配置（标识名 / 路径） */}
      {editingAgent && (
        <ConfirmDialog
          title={`编辑 Agent 配置：${editingAgent.key}`}
          confirmLabel="保存"
          busy={false}
          onConfirm={() => void confirmEditAgent()}
          onClose={() => setEditingAgent(null)}
        >
          <div className="space-y-2">
            <input
              value={editKey}
              onChange={(e) => setEditKey(e.target.value)}
              placeholder="标识名"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-sky-400 dark:border-slate-600"
            />
            <input
              value={editPath}
              onChange={(e) => setEditPath(e.target.value)}
              placeholder="技能根路径"
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
            />
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            只修改配置表，不动磁盘上的联接。改路径后旧路径的联接仍在原处（可在「探测」页处理）；改标识名会移除旧配置项。
          </div>
        </ConfirmDialog>
      )}
    </div>
  )
}

/** 24 项预设全量探测面板（与 PowerShell 版 verify.ps1 同一套状态机，P3 对齐验收通过） */
function DetectPanel({
  sharedRoot,
  refreshTick,
  onConnect,
  onRemove,
  onMerge,
  onEdit
}: {
  sharedRoot: string
  refreshTick: number
  onConnect: (key: string, path: string, dynamic?: boolean) => void
  onRemove: (key: string) => void
  onMerge: (groupName: string) => void
  onEdit: (key: string) => void
}) {
  const [result, setResult] = useState<DetectPresetsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.api.agents.detectPresets()
      if (!r.ok) throw new Error(r.error)
      setResult(r.data)
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

  const active = result?.detected.filter((d) => d.state === 'active').length ?? 0
  const configured = result?.detected.filter((d) => d.configured).length ?? 0

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Search className="h-4 w-4 text-slate-400" />
        <span className="text-sm text-slate-500 dark:text-slate-400">共享库</span>
        <code className="rounded bg-slate-200 px-2 py-0.5 text-xs dark:bg-slate-800">{sharedRoot}</code>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {result ? `已接入 ${active} / 已配置 ${configured} / 共 ${result.detected.length} 条入口` : '探测中…'}
        </span>
        <button
          onClick={() => void run()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-sky-500/10 px-3 py-1.5 text-sm text-sky-500 transition hover:bg-sky-500/20 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          重新探测
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
          {error}
        </div>
      )}

      {result && result.conflicts.length > 0 && (
        <div className="mb-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm ring-1 ring-red-500/30">
          <div className="flex items-center gap-2 font-medium text-red-400">
            重复加载风险：同一软件目录下存在多个技能根
          </div>
          {result.conflicts.map((c) => (
            <div key={c.name} className="mt-2 text-slate-600 dark:text-slate-300">
              <div className="flex items-center gap-2">
                <span className="truncate text-amber-500">
                  软件目录 {c.name} 下有 {c.paths.length} 个技能根
                </span>
                {onMerge && (
                  <button
                    onClick={() => void onMerge(c.name)}
                    className="rounded bg-red-500/15 px-2 py-0.5 text-xs text-red-400 transition hover:bg-red-500/25"
                  >
                    一键归并
                  </button>
                )}
              </div>
              <ul className="mt-1 space-y-0.5">
                {c.paths.map((p) => (
                  <li key={p} className="truncate pl-4 font-mono text-xs text-slate-500 dark:text-slate-400">
                    · {p}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            这些技能根同属一个软件专属目录，软件可能把同一份技能加载多次。归并 = 保留一个根接入共享库，其余拆联接后变空目录，消除重复加载。
          </div>
        </div>
      )}

      {result && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {result.detected.map((d) => (
            <AgentCard
              key={`${d.key}|${d.path}`}
              agent={d}
              onConnect={onConnect}
              onRemove={onRemove}
              onEdit={onEdit}
            />
          ))}
        </div>
      )}
    </>
  )
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{hint}</div>
    </div>
  )
}
