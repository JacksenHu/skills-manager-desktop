#!/usr/bin/env node
/**
 * P12 真机验证（**需要联网，不进 verify:all**）：用真实网络验证 SkillsBot 免登录链路。
 *
 * 覆盖：分类树 / 热门 / 最新 / 搜索 / 分类分页 / 详情（含 19 位雪花 ID 精度）
 *      / 免登录安装落盘 / 已安装标注 —— 全程不使用任何账号或 token。
 *
 * 前置：先跑一次 p12-smoke.mjs（它会产出本脚本要 import 的 esbuild 包）。
 * 用法：npm run verify:p12:live
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const CACHE = join(ROOT, 'node_modules', '.cache')
const bot = await import('file:///' + join(CACHE, 'p12-smoke-bundle.mjs').replace(/\\/g, '/'))

const {
  fetchBotCategories,
  fetchBotHot,
  fetchBotNew,
  searchBotSkills,
  listBotSkillsByCategory,
  fetchBotSkillDetail,
  writeBotSkillMarkdown,
  flattenBotCategories
} = bot

const sandbox = mkdtempSync(join(tmpdir(), 'p12-live-'))
const config = { sharedRoot: join(sandbox, 'shared'), agents: {}, ui: {}, net: {} }

let failed = 0
const t = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failed++
}

const shorten = (s, n = 70) => (s.length > n ? s.slice(0, n) + '…' : s)

console.log('\n=== 1. 分类树（免登录）===')
const cats = await fetchBotCategories(config, 1)
const flat = flattenBotCategories(cats)
console.log(`  roots=${cats.length}  flat=${flat.flat.length}`)
console.log(`  前三个一级分类: ${cats.slice(0, 3).map((c) => `${c.id}:${c.name}(${c.children?.length ?? 0}子)`).join('  ')}`)
t('分类树非空', cats.length > 0)
t('存在两级结构', flat.flat.length > cats.length)

console.log('\n=== 2. 热门 / 最新（免登录）===')
const hot = await fetchBotHot(config, 1)
const newest = await fetchBotNew(config, 1)
console.log(`  hot=${hot.length}  newest=${newest.length}`)
if (hot[0]) console.log(`  hot[0] = id:${hot[0].id} (${typeof hot[0].id})  ${shorten(hot[0].name)}`)
t('热门有数据', hot.length > 0)
t('最新有数据', newest.length > 0)
t('id 类型是字符串', typeof hot[0]?.id === 'string')
t('热门项带 botUrl', String(hot[0]?.botUrl ?? '').includes('skillsbot.cn/skill/'))

console.log('\n=== 3. 搜索（免登录）===')
const searched = await searchBotSkills(config, { keyword: 'atlas', page: 1 })
console.log(`  关键词 atlas → ${searched.skills.length} 条, total=${searched.total}, hasMore=${searched.hasMore}`)
if (searched.skills[0]) console.log(`  [0] ${shorten(searched.skills[0].name)}`)
t('搜索结果非空', searched.skills.length > 0)
t('分页上限为 12', searched.skills.length <= 12)

console.log('\n=== 4. 分类分页（免登录）===')
const catId = flat.flat.find((c) => (c.children?.length ?? 0) > 0)?.children?.[0]?.id ?? flat.flat[1]?.id
const paged = await listBotSkillsByCategory(config, { categoryId: catId, page: 1, type: 1 })
console.log(`  categoryId=${catId} → ${paged.skills.length} 条`)
t('分类分页可用', paged.skills.length > 0)

console.log('\n=== 5. 详情：普通 ID（含完整 SKILL.md）===')
const d1 = await fetchBotSkillDetail(config, '1')
console.log(`  #${d1.id}  ${d1.name}`)
console.log(`  正文 ${d1.detail.length} 字符 / 包体积 ${d1.fileSize} B → 判定 ${d1.completeness}`)
console.log(`  正文开头: ${JSON.stringify(d1.detail.slice(0, 50))}`)
t('detail 非空', d1.detail.length > 0)
t('正文含 frontmatter', d1.detail.startsWith('---'))
t('完整性已判定', d1.completeness !== 'unknown')

console.log('\n=== 6. 详情：19 位雪花 ID（精度关键路径）===')
const BIG = '2096185237169971201'
const dBig = await fetchBotSkillDetail(config, BIG)
console.log(`  请求 id = ${BIG}`)
console.log(`  返回 id = ${dBig.id}`)
console.log(`  ${dBig.name} / 正文 ${dBig.detail.length} 字符 / 包体积 ${dBig.fileSize} B → ${dBig.completeness}`)
t('19 位 ID 逐字符一致（未丢精度）', dBig.id === BIG)
t('大 ID 技能也有正文', dBig.detail.length > 0)
if (dBig.completeness === 'has-extras') {
  console.log(`  缺失文件（启发式）: ${dBig.missingRefs.join(', ') || '（未列出）'}`)
}

console.log('\n=== 7. 免登录安装落盘（真实数据 → 共享库）===')
const r1 = await writeBotSkillMarkdown(config, d1, { replace: true })
const dir1 = join(config.sharedRoot, r1.skillName)
console.log(`  技能目录: ${dir1}`)
console.log(`  目录内容: ${readdirSync(dir1).join(', ')}`)
console.log(r1.logs.map((l) => '    ' + l).join('\n'))
t('SKILL.md 已写入', existsSync(join(dir1, 'SKILL.md')))
t('_meta.json 已写入', existsSync(join(dir1, '_meta.json')))
const md = readFileSync(join(dir1, 'SKILL.md'), 'utf8')
t('落盘正文与接口正文一致', md.trim() === d1.detail.trim())
const meta = JSON.parse(readFileSync(join(dir1, '_meta.json'), 'utf8'))
t('_meta.source 为站点详情页', meta.source === d1.botUrl)
t('_meta.bot.id 保持字符串', typeof meta.bot?.id === 'string')

console.log('\n=== 8. 安装大 ID 技能（验证 ID 全链路不丢精度）===')
const rBig = await writeBotSkillMarkdown(config, dBig, { replace: true })
console.log(`  技能目录: ${rBig.skillName}  incomplete=${rBig.incomplete}`)
t('大 ID 技能安装成功', existsSync(join(config.sharedRoot, rBig.skillName, 'SKILL.md')))
t('大 ID 技能 _meta 记录字符串 id', JSON.parse(readFileSync(join(config.sharedRoot, rBig.skillName, '_meta.json'), 'utf8')).bot?.id === BIG)

console.log('\n=== 9. 已安装标注 ===')
const again = await searchBotSkills(config, { keyword: 'atlas', page: 1 })
const marked = again.skills.filter((s) => s.installed)
console.log(`  搜索结果中标记为已安装: ${marked.length} 条 → ${marked.map((s) => s.name).join(' / ') || '（无）'}`)
t('刚安装的技能被标注为已安装', marked.length > 0)

try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n${failed === 0 ? '✅' : '❌'} P12 真机验证${failed === 0 ? '全部通过' : `失败 ${failed} 项`}（全程未使用任何账号 / token）`)
process.exit(failed === 0 ? 0 : 1)
