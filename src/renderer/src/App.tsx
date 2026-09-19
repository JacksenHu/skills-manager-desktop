import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, FolderOpen, HardDrive, Link2, Moon, RefreshCw, Search, Settings, Sun } from 'lucide-react'
import type { AgentStatus, AppConfig, DetectPresetsResult, JunctionState } from '@shared/types'

type Tab = 'connect' | 'detect' | 'skills' | 'updates' | 'settings'

const TABS: { key: Tab; label: string }[] = [
  { key: 'connect', label: '联接' },
  { key: 'detect', label: '探测' },
  { key: 'skills', label: '技能库' },
  { key: 'updates', label: '更新' },
  { key: 'settings', label: '设置' }
]

const STATE_META: Record<JunctionState, { label: string; cls: string }> = {
  active: { label: '已接入', cls: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30' },
  'merged-empty': { label: '已归并', cls: 'bg-amber-500/15 text-amber-400 ring-amber-500/30' },
  empty: { label: '空目录', cls: 'bg-orange-500/15 text-orange-400 ring-orange-500/30' },
  missing: { label: '不存在', cls: 'bg-slate-500/15 text-slate-400 ring-slate-500/30' },
  'other-link': { label: '指向他处', cls: 'bg-red-500/15 text-red-400 ring-red-500/30' },
  'real-dir': { label: '未联接', cls: 'bg-orange-500/15 text-orange-400 ring-orange-500/30' }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('connect')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const cfg = await window.api.config.get()
      if (!cfg.ok) throw new Error(cfg.error)
      setConfig(cfg.data)

      const status = await window.api.agents.status()
      if (!status.ok) throw new Error(status.error)
      setAgents(status.data)
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
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title="切换主题"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800/70"
          >
            {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </button>
          <Settings className="h-4 w-4 text-slate-400" />
        </div>
      </header>

      {/* 内容区 */}
      <main className="flex-1 overflow-auto p-5">
        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
            {error}
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
                已接入 {activeCount} / 共 {agents.length}
              </span>
            </div>

            {agents.length === 0 ? (
              <Empty
                title="还没有配置任何 Agent"
                hint="先在设置里导入，或从 PowerShell 版项目的 config\agents.json 迁移过来（P7 提供导入导出）。"
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {agents.map((a) => (
                  <AgentCard key={a.key} agent={a} />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'skills' && <Empty title="技能库" hint="P5 实现：列表 / 分类 / 安装 / 移除 / 翻译简介 / 生成路由。" />}
        {tab === 'updates' && <Empty title="更新检测" hint="P6 实现：技能来源仓库与工具自身版本检测。" />}
        {tab === 'settings' && (
          <Empty
            title="设置"
            hint="P2 起逐步补齐：共享库路径、主题、GitHub Token、导入导出、关于。"
          />
        )}
      </main>
    </div>
  )
}

/** 24 项预设全量探测面板（与 PowerShell 版 verify.ps1 同一套状态机，P3 对齐验收通过） */
function DetectPanel({ sharedRoot }: { sharedRoot: string }) {
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
  }, [run])

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
            <AlertTriangle className="h-4 w-4" />
            「同一 Agent 多技能根」重复加载风险
          </div>
          {result.conflicts.map((c) => (
            <div key={c.name} className="mt-2 text-slate-600 dark:text-slate-300">
              <span className="text-amber-500">{c.name}</span> 可能被同一软件同时读取：
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
            这些目录若都指向同一共享库，该软件会把每个技能重复加载多份。P4 的归并功能将根治。
          </div>
        </div>
      )}

      {result && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {result.detected.map((d) => (
            <AgentCard key={`${d.key}|${d.path}`} agent={d} />
          ))}
        </div>
      )}
    </>
  )
}

function AgentCard({
  agent
}: {
  agent: AgentStatus & { presetLabel?: string; configured?: boolean }
}) {
  const meta = STATE_META[agent.state]
  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 truncate font-medium">
            {agent.label}
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
        <button
          onClick={() => void window.api.app.openPath(agent.path)}
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 opacity-0 transition group-hover:opacity-100 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          打开目录
        </button>
      </div>
    </div>
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
