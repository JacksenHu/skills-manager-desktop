import { useCallback, useEffect, useState } from 'react'
import { Download, FolderOpen, Info, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react'
import type { AppConfig } from '@shared/types'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-3 text-sm font-medium">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-sky-500"
      />
      <span>{label}</span>
      {hint && <span className="text-xs text-slate-400 dark:text-slate-500">{hint}</span>}
    </label>
  )
}

export function SettingsPanel({
  config,
  onConfigChanged
}: {
  config: AppConfig | null
  onConfigChanged: (config: AppConfig) => void
}) {
  const [sharedRoot, setSharedRoot] = useState(config?.sharedRoot ?? '')
  const [newKey, setNewKey] = useState('')
  const [newPath, setNewPath] = useState('')
  const [version, setVersion] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [backupPath, setBackupPath] = useState(config?.backup?.path ?? '')

  useEffect(() => {
    if (config) {
      setSharedRoot(config.sharedRoot)
      setBackupPath(config.backup?.path ?? '')
    }
  }, [config])

  useEffect(() => {
    void window.api.app.version().then((r) => {
      if (r.ok) setVersion(r.data)
    })
    void window.api.settings.configPath().then((r) => {
      if (r.ok) setConfigPath(r.data)
    })
  }, [])

  const update = useCallback(
    async (patch: unknown, okMsg?: string) => {
      try {
        const r = await window.api.settings.update(patch)
        if (!r.ok) throw new Error(r.error)
        onConfigChanged(r.data)
        if (okMsg) {
          setMsg(okMsg)
          setTimeout(() => setMsg(null), 2500)
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e))
      }
    },
    [onConfigChanged]
  )

  const theme = config?.ui?.theme ?? 'system'
  const closeToTray = config?.ui?.closeToTray !== false
  const agents = Object.entries(config?.agents ?? {}).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {msg && (
        <div className="rounded-lg bg-sky-500/10 px-4 py-2.5 text-sm text-sky-500 ring-1 ring-sky-500/30">
          {msg}
        </div>
      )}

      {/* 共享库路径 */}
      <Section title="共享技能库">
        <div className="flex items-center gap-2">
          <input
            value={sharedRoot}
            onChange={(e) => setSharedRoot(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
          />
          <button
            onClick={() => void window.api.app.openPath(sharedRoot)}
            title="打开目录"
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <FolderOpen className="h-4 w-4" />
          </button>
          <button
            onClick={() => void update({ sharedRoot }, '共享库路径已保存')}
            disabled={sharedRoot.trim() === config?.sharedRoot}
            className="rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-sky-600 disabled:opacity-50"
          >
            保存
          </button>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          所有 Agent 联接的指向目标。修改路径不会自动迁移联接——已接入的 Agent 需在「联接/探测」页拆除后重新接入。
        </div>
      </Section>

      {/* Agent 配置管理 */}
      <Section title={`Agent 配置（${agents.length}）`}>
        {agents.length > 0 && (
          <div className="space-y-1.5">
            {agents.map(([key, path]) => (
              <div
                key={key}
                className="group flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-950"
              >
                <span className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-500">
                  {key}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                  {path}
                </span>
                <button
                  onClick={async () => {
                    const r = await window.api.config.removeAgent(key)
                    if (r.ok) onConfigChanged(r.data)
                    setMsg(`已移除配置项「${key}」`)
                  }}
                  title="从配置移除（不动磁盘上的目录）"
                  className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="标识名（如 claude-code）"
            className="w-40 rounded-lg border border-slate-300 bg-transparent px-3 py-1.5 text-xs outline-none focus:border-sky-400 dark:border-slate-600"
          />
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="技能根路径（绝对路径）"
            className="flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-1.5 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
          />
          <button
            onClick={async () => {
              if (!newKey.trim() || !newPath.trim()) return
              const r = await window.api.config.upsertAgent(newKey.trim(), newPath.trim())
              if (r.ok) onConfigChanged(r.data)
              setMsg(`已添加「${newKey.trim()}」`)
              setNewKey('')
              setNewPath('')
            }}
            disabled={!newKey.trim() || !newPath.trim()}
            title="添加 / 更新"
            className="rounded-lg p-2 text-sky-500 hover:bg-sky-500/10 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          这里只管「配置表」。要为某个 Agent 建联接，去「探测」页点接入。
        </div>
      </Section>

      {/* 外观与窗口 */}
      <Section title="外观与窗口">
        <div className="flex items-center gap-1.5">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => void update({ ui: { theme: t } })}
              className={
                'rounded-lg px-3 py-1.5 text-sm transition ' +
                (theme === t
                  ? 'bg-sky-500 font-medium text-white'
                  : 'bg-slate-200/70 text-slate-500 hover:bg-slate-300/70 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700')
              }
            >
              {t === 'system' ? '跟随系统' : t === 'light' ? '亮色' : '暗色'}
            </button>
          ))}
        </div>
        <Toggle
          checked={closeToTray}
          onChange={(v) => void update({ ui: { closeToTray: v } }, v ? '关闭时最小化到托盘' : '关闭时直接退出')}
          label="关闭窗口时最小化到托盘"
          hint="关闭后从托盘图标退出程序"
        />
      </Section>

      {/* 技能库搜索范围 */}
      <Section title="技能库搜索范围">
        <div className="flex flex-wrap items-center gap-4">
          <Toggle
            checked={config?.search?.name !== false}
            onChange={(v) => void update({ search: { name: v } }, v ? '搜索包含技能名' : '搜索不含技能名')}
            label="按技能名搜索"
          />
          <Toggle
            checked={config?.search?.intro !== false}
            onChange={(v) => void update({ search: { intro: v } }, v ? '搜索包含简介' : '搜索不含简介')}
            label="按简介搜索"
          />
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          至少保留一项，否则技能库搜索框无结果。
        </div>
      </Section>

      {/* 接入备份 */}
      <Section title="接入备份">
        <Toggle
          checked={config?.backup?.enabled ?? false}
          onChange={(v) => void update({ backup: { enabled: v } }, v ? '已开启接入备份' : '已关闭接入备份')}
          label="首次接入时备份原技能根目录"
          hint="内容迁移进共享库之前，先整目录复制一份留底"
        />
        <input
          value={backupPath}
          onChange={(e) => setBackupPath(e.target.value)}
          onBlur={() => {
            if (backupPath.trim() !== (config?.backup?.path ?? ''))
              void update({ backup: { path: backupPath.trim() } }, '备份路径已保存')
          }}
          placeholder="备份存放目录（绝对路径，如 D:\skills-backup）"
          className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
        />
        <div className="text-xs text-slate-500 dark:text-slate-400">
          备份到「{backupPath.trim() || '（未设置）'}」，备份名 = 技能根目录名-时间戳。备份失败会中止接入，不会动原目录。
        </div>
      </Section>

      {/* 网络 */}
      <Section title="网络与翻译">
        <div className="flex items-center gap-2">
          <input
            type="password"
            defaultValue={config?.net?.token ?? ''}
            placeholder="GitHub Token（可选，提高 API 配额）"
            onBlur={(e) => void update({ net: { token: e.target.value.trim() } }, 'GitHub Token 已保存')}
            className="flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
          />
        </div>
        <input
          type="email"
          defaultValue={config?.net?.translateEmail ?? ''}
          placeholder="翻译接口邮箱（可选，MyMemory 提额用）"
          onBlur={(e) =>
            void update({ net: { translateEmail: e.target.value.trim() } }, '翻译邮箱已保存')
          }
          className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-sky-400 dark:border-slate-600"
        />
        <Toggle
          checked={config?.net?.allowInsecureTls ?? false}
          onChange={(v) => void update({ net: { allowInsecureTls: v } }, v ? '已放宽 TLS 校验' : '已恢复 TLS 校验')}
          label="放宽 TLS 校验（本机代理根证书不在 Node CA 库时勾选）"
        />
        <div className="flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          翻译接口顺序：腾讯 TranSmart（国内直连）→ MyMemory → Google gtx，全部失败时保留原文。
        </div>
      </Section>

      {/* 导入导出 */}
      <Section title="导入 / 导出配置">
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              const r = await window.api.settings.exportConfig()
              if (r.ok && r.data.saved) setMsg(`已导出到 ${r.data.path}`)
            }}
            className="flex items-center gap-1.5 rounded-lg bg-sky-500/10 px-3 py-1.5 text-sm text-sky-500 transition hover:bg-sky-500/20"
          >
            <Download className="h-3.5 w-3.5" />
            导出
          </button>
          <button
            onClick={async () => {
              const r = await window.api.settings.importConfig()
              if (r.ok && r.data.imported && r.data.config) {
                onConfigChanged(r.data.config)
                setMsg('配置已导入（联接不会自动改动，可在探测页核对）')
              }
            }}
            className="flex items-center gap-1.5 rounded-lg bg-sky-500/10 px-3 py-1.5 text-sm text-sky-500 transition hover:bg-sky-500/20"
          >
            <Upload className="h-3.5 w-3.5" />
            导入
          </button>
        </div>
        <div className="break-all text-xs text-slate-500 dark:text-slate-400">
          配置文件：{configPath || '—'}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          导入只覆盖配置表（含共享库路径 / Agent 列表 / 主题 / 网络设置），不会自动建拆联接。
        </div>
      </Section>

      {/* 关于 */}
      <Section title="关于">
        <div className="flex items-center gap-2 text-sm">
          <Info className="h-4 w-4 text-slate-400" />
          <span>技能共享库管理</span>
          <span className="rounded bg-slate-200/70 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            v{version || '…'}
          </span>
        </div>
        <button
          onClick={() => void window.api.app.openPath('https://github.com/JacksenHu/skills-manager-desktop')}
          className="text-xs text-sky-500 underline"
        >
          开源地址：github.com/JacksenHu/skills-manager-desktop
        </button>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          跨 Agent 技能共享库的桌面管理程序（Electron + React）。与 PowerShell 版 agent-skills-shared
          通过共享库目录与三张事实表数据耦合，逻辑独立实现。
        </div>
      </Section>
    </div>
  )
}
