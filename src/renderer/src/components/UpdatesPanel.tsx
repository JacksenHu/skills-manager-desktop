import { useCallback, useEffect, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, FileText, HelpCircle, RefreshCw, Search, ShieldQuestion } from 'lucide-react'
import type { CheckUpdatesResult, IpcResult, OpResult, RepoUpdateInfo, ToolReleaseInfo, ToolUpdateInfo } from '@shared/types'
import { Modal, ResultModal } from './Modal'

const REPO_STATE_META: Record<
  RepoUpdateInfo['state'],
  { label: string; cls: string }
> = {
  update: { label: '有更新', cls: 'bg-amber-500/15 text-amber-500 ring-amber-500/30' },
  latest: { label: '最新', cls: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30' },
  'no-baseline': {
    label: '无基准',
    cls: 'bg-slate-500/15 text-slate-400 ring-slate-500/30'
  },
  'rate-limited': { label: '限速', cls: 'bg-red-500/15 text-red-400 ring-red-500/30' },
  gone: { label: '不可查', cls: 'bg-red-500/15 text-red-400 ring-red-500/30' },
  error: { label: '不可查', cls: 'bg-red-500/15 text-red-400 ring-red-500/30' }
}

const STATE_HINT: Record<RepoUpdateInfo['state'], string> = {
  update: '远程仓库有新提交，可重新安装升级',
  latest: '与安装时基准一致',
  'no-baseline': '旧版安装未记录 commitSha，重新安装一次即可建立基准',
  'rate-limited': 'GitHub API 限速（匿名 60 次/小时），可在设置里配 Token 后重试',
  gone: '仓库不存在或已转为私有',
  error: '网络或接口异常'
}

export function UpdatesPanel({ refreshTick }: { refreshTick: number }) {
  const [result, setResult] = useState<CheckUpdatesResult | null>(null)
  const [tool, setTool] = useState<ToolUpdateInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [upgrading, setUpgrading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opResult, setOpResult] = useState<{ title: string; logs: string[] } | null>(null)

  // 自动更新（electron-updater）状态
  const [dlProgress, setDlProgress] = useState<number | null>(null)
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null)
  const [releases, setReleases] = useState<ToolReleaseInfo[]>([])
  const [changelogOpen, setChangelogOpen] = useState(false)

  useEffect(() => {
    const offProgress = window.api.on('update-progress', (p) => {
      setDlProgress((p as { percent: number }).percent)
    })
    const offDone = window.api.on('update-downloaded', (d) => {
      setDownloadedVersion((d as { version: string }).version)
      setDlProgress(null)
    })
    const offError = window.api.on('update-error', (e) => {
      setError((e as { message: string }).message)
      setDlProgress(null)
    })
    return () => {
      offProgress()
      offDone()
      offError()
    }
  }, [])

  const run = useCallback(async () => {
    setLoading(true)
    try {
      const r = (await window.api.updates.checkSkills()) as IpcResult<CheckUpdatesResult>
      if (!r.ok) throw new Error(r.error)
      setResult(r.data)
      const [t, rel] = await Promise.all([
        window.api.updates.checkTool() as Promise<IpcResult<ToolUpdateInfo>>,
        window.api.updates.toolReleases() as Promise<IpcResult<ToolReleaseInfo[]>>
      ])
      if (!t.ok) throw new Error(t.error)
      setTool(t.data)
      if (rel.ok) setReleases(rel.data)
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

  const updatable = result?.repos.filter((r) => r.state === 'update') ?? []

  const upgrade = useCallback(async (repos: string[]) => {
    setUpgrading(true)
    try {
      const r = (await window.api.updates.updateSkills(repos)) as IpcResult<OpResult>
      if (!r.ok) throw new Error(r.error)
      setOpResult({ title: `升级结果（${repos.length} 个仓库）`, logs: r.data.logs })
      void run()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUpgrading(false)
    }
  }, [run])

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Search className="h-4 w-4 text-slate-400" />
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {result
            ? `${result.repos.length} 个来源仓库 · ${updatable.length} 个可升级 · 无来源技能 ${result.noSource.length} 个`
            : '检测中…'}
        </span>
        {updatable.length > 0 && (
          <button
            onClick={() => void upgrade(updatable.map((r) => r.repo))}
            disabled={upgrading || loading}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-600 disabled:opacity-50"
          >
            <ArrowUpCircle className={`h-3.5 w-3.5 ${upgrading ? 'animate-pulse' : ''}`} />
            {upgrading ? '升级中…' : `一键升级全部（${updatable.length}）`}
          </button>
        )}
        <button
          onClick={() => void run()}
          disabled={loading || upgrading}
          className="ml-auto rounded-lg p-2 text-slate-500 hover:bg-slate-200/70 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800/70"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400 ring-1 ring-red-500/30">
          <span className="break-all">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 text-xs underline">
            关闭
          </button>
        </div>
      )}

      {/* 工具自身 */}
      {tool && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2">
            <span className="font-medium">工具自身</span>
            {tool.state === 'up-to-date' && (
              <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400 ring-1 ring-emerald-500/30">
                <CheckCircle2 className="h-3.5 w-3.5" />
                最新 v{tool.localVersion}
              </span>
            )}
            {tool.state === 'has-update' && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-500 ring-1 ring-amber-500/30">
                有更新 v{tool.localVersion} → v{tool.remoteVersion}
              </span>
            )}
            {tool.state === 'no-baseline' && (
              <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-xs text-slate-400 ring-1 ring-slate-500/30">
                无基准
              </span>
            )}
            {tool.state === 'unavailable' && (
              <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-400 ring-1 ring-red-500/30">
                <ShieldQuestion className="h-3.5 w-3.5" />
                不可查（{tool.reason === 'notfound' ? '仓库未发布或缺少版本信息' : tool.reason === 'auth' ? '被限速' : '网络异常'}）
              </span>
            )}

            {/* 自动更新操作区 */}
            {tool.state === 'has-update' && downloadedVersion && (
              <button
                onClick={() => void window.api.updates.installUpdate()}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-600"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                重启并安装 v{downloadedVersion}
              </button>
            )}
            {tool.state === 'has-update' && !downloadedVersion && dlProgress === null && (
              <button
                onClick={async () => {
                  try {
                    const r = await window.api.updates.downloadUpdate()
                    if (!r.ok) throw new Error(r.error)
                    if (!r.data.started && r.data.version) setError(null)
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e))
                  }
                }}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-600"
              >
                <ArrowUpCircle className="h-3.5 w-3.5" />
                下载更新
              </button>
            )}
          </div>

          {dlProgress !== null && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>正在下载更新…</span>
                <span>{dlProgress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-sky-500 transition-all"
                  style={{ width: `${dlProgress}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-2 flex items-start gap-2">
            <div className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400">
              更新包经 GitHub Releases 分发（electron-updater）；安装包未签名，Windows 可能提示保留。
            </div>
            {releases.length > 0 && (
              <button
                onClick={() => setChangelogOpen(true)}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-sky-500 hover:bg-sky-500/10"
              >
                <FileText className="h-3 w-3" />
                更新日志
              </button>
            )}
          </div>

          {/* 目标版本的更新说明 */}
          {tool.state === 'has-update' && (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
              <div className="mb-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                v{tool.remoteVersion} 更新内容
              </div>
              <div className="max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {releases.find(
                  (r) => r.tagName === `v${tool.remoteVersion}` || r.name === tool.remoteVersion
                )?.body || '（该版本没有填写更新说明）'}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 来源仓库 */}
      {result && result.repos.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <div className="font-medium">没有带 GitHub 来源的技能</div>
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            用「技能库 → 安装技能」从 GitHub 仓库安装的技能才能检测更新。
          </div>
        </div>
      )}
      {result && result.repos.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {result.repos.map((r) => {
            const meta = REPO_STATE_META[r.state]
            return (
              <div
                key={r.repo}
                className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-sky-400/60 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.repo}</div>
                    <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {r.skills.join(', ')}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ${meta.cls}`}>
                    {meta.label}
                  </span>
                </div>
                <div className="mt-3 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <div>{STATE_HINT[r.state]}</div>
                  {r.state === 'update' && (
                    <div className="font-mono text-[10px]">
                      本地 {(r.localSha ?? '').slice(0, 12)} → 远程 {(r.remoteSha ?? '').slice(0, 12)}
                    </div>
                  )}
                </div>
                {r.state === 'update' && (
                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={() => void upgrade([r.repo])}
                      disabled={upgrading}
                      className="flex items-center gap-1 rounded-lg bg-amber-500/10 px-2.5 py-1 text-xs text-amber-500 transition hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      <ArrowUpCircle className="h-3.5 w-3.5" />
                      升级
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 无来源技能（折叠展示） */}
      {result && result.noSource.length > 0 && (
        <div className="mt-4 rounded-lg bg-slate-200/50 px-4 py-3 text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
          <div className="flex items-center gap-1.5">
            <HelpCircle className="h-3.5 w-3.5" />
            无仓库来源（无法远程检测，仅显示本地版本）：{result.noSource.length} 个
          </div>
          <ul className="mt-1.5 grid gap-0.5 sm:grid-cols-2">
            {result.noSource.map((s) => (
              <li key={s.name} className="truncate">
                · {s.name}（{s.version ? `v${s.version}` : '无版本信息'}）
              </li>
            ))}
          </ul>
        </div>
      )}

      {opResult && (
        <ResultModal title={opResult.title} logs={opResult.logs} onClose={() => setOpResult(null)} />
      )}

      {/* 更新日志弹窗 */}
      {changelogOpen && (
        <Modal title="更新日志" onClose={() => setChangelogOpen(false)} width="max-w-2xl">
          <div className="max-h-[70vh] space-y-4 overflow-auto pr-1">
            {releases.map((r, i) => (
              <div key={r.tagName + i} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-950">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{r.tagName}</span>
                  <span className="text-xs text-slate-400">{r.date}</span>
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto text-xs text-sky-500 hover:underline"
                      onClick={(e) => {
                        e.preventDefault()
                        void window.api.app.openPath(r.url)
                      }}
                    >
                      在 GitHub 查看
                    </a>
                  )}
                </div>
                <div className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  {r.body || '（无更新说明）'}
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}
