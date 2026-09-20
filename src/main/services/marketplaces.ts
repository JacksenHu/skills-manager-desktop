import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import type { AppConfig, MarketManifest, MarketPlugin, MarketSource, OpResult } from '@shared/types'
import { configPath } from './config'
import { httpGet } from './translate'
import { writeMeta } from './skills'

/**
 * P12 技能套件市场（与 WorkBuddy 插件市场体系对齐）。
 *
 * 市场清单格式（.codebuddy-plugin/marketplace.json）：
 * { name, description, metadata.version, plugins: [{ name, description, source(相对市场根),
 *   version, category, skills[](技能目录路径，通常相对市场根；缺省 = 整个 source 目录为单技能) }] }
 *
 * 来源三态：git（系统 git clone --depth 1）/ zip（下载 + 系统 bsdtar 解压）/
 * directory（本地路径直读）。克隆/下载缓存在 <config目录>/marketplaces/<name>。
 *
 * 套件安装：把 plugin 的技能目录逐个拷入共享库根（覆盖），_meta 写
 * { source: 市场来源, version, package: {marketplace, plugin, version}, category: '套件' }。
 */

export const BUILTIN_MARKETS: MarketSource[] = [
  {
    name: 'codebuddy-plugins-official',
    type: 'git',
    url: 'https://cnb.cool/codebuddy/marketplace',
    builtin: true
  },
  {
    name: 'cb_teams_marketplace',
    type: 'zip',
    url: 'https://download.codebuddy.cn/plugin-marketplace/cb_teams_marketplace-de338e37-a9f8-420c-b110-650e8a928873.zip',
    builtin: true
  }
]

function cacheRoot(): string {
  return join(dirname(configPath()), 'marketplaces')
}

function marketCacheDir(name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '_')
  return join(cacheRoot(), safe)
}

function spawnRun(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true })
    let err = ''
    child.stderr?.on('data', (c) => (err += c))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}: ${err.slice(0, 300)}`))
    )
  })
}

/** 递归找 .codebuddy-plugin/marketplace.json（zip 解压后可能多一层目录） */
function findManifestFile(dir: string, depth = 0): string | null {
  if (depth > 4) return null
  const direct = join(dir, '.codebuddy-plugin', 'marketplace.json')
  if (existsSync(direct)) return direct
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const hit = findManifestFile(join(dir, e.name), depth + 1)
    if (hit) return hit
  }
  return null
}

async function fetchGit(source: MarketSource, dir: string): Promise<void> {
  if (existsSync(join(dir, '.git'))) {
    try {
      await spawnRun('git', ['pull', '--ff-only'], dir)
      return
    } catch {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  mkdirSync(dirname(dir), { recursive: true })
  await spawnRun('git', ['clone', '--depth', '1', source.url, dir])
}

async function fetchZip(source: MarketSource, dir: string): Promise<void> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const zipPath = join(dirname(dir), `${basename(dir)}.zip`)
  const buf = await httpGet(source.url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeoutMs: 120000,
    insecure: false
  })
  writeFileSync(zipPath, buf)
  // Windows 自带 bsdtar（System32\tar.exe）可解 zip；Git Bash 的 GNU tar 不行
  const sysTar = 'C:\\Windows\\System32\\tar.exe'
  const tarBin = existsSync(sysTar) ? sysTar : 'tar'
  try {
    await spawnRun(tarBin, ['-xf', zipPath, '-C', dir])
  } finally {
    rmSync(zipPath, { force: true })
  }
}

interface ParsedMarket {
  manifest: MarketManifest
  /** pluginName -> (技能目录名 -> 缓存内绝对路径) */
  skillAbs: Map<string, Map<string, string>>
  marketRoot: string
}

function parseManifestAt(marketRoot: string, source: MarketSource): ParsedMarket {
  const manifestFile = join(marketRoot, '.codebuddy-plugin', 'marketplace.json')
  if (!existsSync(manifestFile)) throw new Error(`市场 ${source.name} 里找不到 .codebuddy-plugin/marketplace.json`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(readFileSync(manifestFile, 'utf8')) as any
  const skillAbs = new Map<string, Map<string, string>>()
  const plugins: MarketPlugin[] = []
  for (const p of (raw.plugins ?? []) as Record<string, unknown>[]) {
    const name = String(p.name ?? '')
    if (!name) continue
    const src = String(p.source ?? '').replace(/^\.\//, '')
    const pluginDir = join(marketRoot, src)
    const absMap = new Map<string, string>()
    const listed = (p.skills as string[] | undefined) ?? []
    if (listed.length > 0) {
      for (const s of listed) {
        const rel = s.replace(/^\.\//, '')
        // skills 路径通常相对市场根（含插件目录前缀）；兼容相对插件目录
        const fromRoot = join(marketRoot, rel)
        const fromPlugin = join(pluginDir, rel.replace(new RegExp('^' + src.replace(/[\\/]/g, '\\$&') + '[\\\\/]'), ''))
        const abs = existsSync(fromRoot) ? fromRoot : existsSync(fromPlugin) ? fromPlugin : null
        if (!abs) continue // 清单与磁盘不一致（该市场常见），跳过不存在的条目
        if (existsSync(join(abs, 'SKILL.md'))) {
          // 条目本身就是技能目录
          absMap.set(basename(abs), abs)
        } else if (existsSync(join(abs, 'skills'))) {
          // 条目指向插件根：真正的技能在其 skills/ 子目录下（如 internal-comms）
          const sub = join(abs, 'skills')
          for (const e of readdirSync(sub, { withFileTypes: true })) {
            if (e.isDirectory() && existsSync(join(sub, e.name, 'SKILL.md'))) {
              absMap.set(e.name, join(sub, e.name))
            }
          }
        }
        // 既无 SKILL.md 也无 skills/ 子目录 → 无法识别为技能，跳过
      }
    } else {
      const skillsDir = join(pluginDir, 'skills')
      if (existsSync(skillsDir)) {
        for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md'))) {
            absMap.set(e.name, join(skillsDir, e.name))
          }
        }
      } else if (existsSync(join(pluginDir, 'SKILL.md'))) {
        absMap.set(basename(pluginDir), pluginDir)
      }
    }
    if (absMap.size === 0) continue
    skillAbs.set(name, absMap)
    plugins.push({
      name,
      description: String(p.description ?? p.description_en ?? '').trim(),
      version: p.version ? String(p.version) : undefined,
      category: p.category ? String(p.category) : undefined,
      skillDirs: [...absMap.keys()]
    })
  }
  return {
    manifest: {
      name: String(raw.name ?? source.name),
      description: String(raw.description ?? '').trim(),
      source,
      plugins
    },
    skillAbs,
    marketRoot
  }
}

/** 拉取（或读缓存）市场并解析清单 */
export async function resolveMarketplace(config: AppConfig, source: MarketSource): Promise<ParsedMarket> {
  const dir = marketCacheDir(source.name)
  if (source.type === 'git') await fetchGit(source, dir)
  else if (source.type === 'zip') await fetchZip(source, dir)
  else {
    if (!existsSync(source.url)) throw new Error(`本地市场路径不存在: ${source.url}`)
    if (dir !== source.url) {
      rmSync(dir, { recursive: true, force: true })
      cpSync(source.url, dir, { recursive: true })
    }
  }
  const manifestFile = findManifestFile(dir)
  if (!manifestFile) throw new Error(`市场 ${source.name} 缓存里找不到 marketplace.json`)
  return parseManifestAt(dirname(dirname(manifestFile)), source)
}

/** 内置 + 用户自定义市场列表 */
export function listMarketSources(config: AppConfig): MarketSource[] {
  return [...BUILTIN_MARKETS, ...(config.marketplaces ?? [])]
}

/** 安装套件：plugin 的技能目录逐个拷入共享库（覆盖），_meta 打套件标记 */
export async function installMarketPlugin(
  config: AppConfig,
  source: MarketSource,
  pluginName: string
): Promise<OpResult> {
  const { skillAbs } = await resolveMarketplace(config, source)
  const absMap = skillAbs.get(pluginName)
  if (!absMap) throw new Error(`市场 ${source.name} 里找不到套件 ${pluginName}`)

  const logs: string[] = [`安装套件: ${pluginName}（来自 ${source.name}，共 ${absMap.size} 个技能）`]
  let copied = 0
  for (const [skillDirName, srcDir] of absMap) {
    const dest = join(config.sharedRoot, skillDirName)
    mkdirSync(config.sharedRoot, { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    cpSync(srcDir, dest, { recursive: true })
    writeMeta(dest, {
      source: source.url,
      category: '套件',
      package: { marketplace: source.name, plugin: pluginName }
    })
    copied++
    logs.push(`[OK] ${skillDirName}（已标记套件 ${pluginName}@${source.name}）`)
  }
  if (copied === 0) throw new Error('没有任何技能被安装')

  // 补写套件版本号（从 manifest 原始数据取）
  const manifestFile = findManifestFile(marketCacheDir(source.name))
  if (manifestFile) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = JSON.parse(readFileSync(manifestFile, 'utf8')) as any
      const rawPlugin = (raw.plugins ?? []).find((p: Record<string, unknown>) => p.name === pluginName)
      const version = rawPlugin?.version ? String(rawPlugin.version) : undefined
      if (version) {
        for (const skillDirName of absMap.keys()) {
          const dest = join(config.sharedRoot, skillDirName)
          if (existsSync(dest)) writeMeta(dest, { version, package: { marketplace: source.name, plugin: pluginName, version } })
        }
        logs.push(`[OK] 套件版本 v${version} 已写入各技能`)
      }
    } catch {
      // 版本补写失败不影响安装结果
    }
  }

  logs.unshift(`[OK] 套件安装完成：${copied} 个技能已进入共享库并归类「套件」`)
  return { logs }
}
