#!/usr/bin/env node
/**
 * P12 冒烟测试（离线部分）：在临时沙箱里真跑 SkillsBot 免登录服务层的
 * URL 组装 / honeypot 守卫 / 19 位 ID 保真 / 正文归一化 / 完整性预判 /
 * 附加文件识别 / 目录名净化 / 分类树展平 / 免登录安装落盘全流程。
 *
 * 不发任何网络请求（真实分类/搜索/详情拉取留给真机验证）。
 *
 * 用法：node scripts/p12-smoke.mjs
 */
import { buildSync } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 打包到 node_modules/.cache，让 external 的 extract-zip 等能按相对路径解析
const cacheDir = join(ROOT, 'node_modules', '.cache')
mkdirSync(cacheDir, { recursive: true })
const bundle = join(cacheDir, 'p12-smoke-bundle.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/main/services/skillsbot.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  packages: 'external',
  alias: { '@shared': join(ROOT, 'src', 'shared') }
})

const mod = await import('file:///' + bundle.replace(/\\/g, '/'))
const {
  resolveBotApiUrl,
  resolveBotUrl,
  assertNotHoneypot,
  normalizeSkillMd,
  judgeCompleteness,
  listMissingRefs,
  sanitizeSkillDirName,
  flattenBotCategories,
  writeBotSkillMarkdown,
  BOT_PAGE_SIZE,
  BotApiError
} = mod

// 额外打包 skills.ts，用于验证「装完能被技能库面板扫到」（两条链路真实互通）
const skillsBundle = join(cacheDir, 'p12-smoke-skills-bundle.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/main/services/skills.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: skillsBundle,
  packages: 'external',
  alias: { '@shared': join(ROOT, 'src', 'shared') }
})
const { listSkills } = await import('file:///' + skillsBundle.replace(/\\/g, '/'))

let failed = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failed++
}

const SANDBOX = mkdtempSync(join(tmpdir(), 'p12-smoke-'))
const cleanup = () => { try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* ignore */ } }

/** 造一个 BotSkillDetail（免登录安装的唯一入参） */
function mkDetail(over = {}) {
  return {
    id: '12345',
    name: '测试技能',
    enName: 'test-skill',
    description: '用于冒烟测试的技能',
    categoryId: 15,
    categoryName: 'DevOps',
    parentCategoryId: 1,
    parentCategoryName: '软件开发',
    version: 1,
    githubProjectName: 'someone',
    originalName: 'test-skill.zip',
    fileName: 'blog/2026/01/01/abc.zip',
    fileSize: 1000,
    viewCount: 1,
    downloadCount: 2,
    type: 1,
    createTime: '2026-01-01 00:00:00',
    updateTime: '2026-01-01 00:00:00',
    botUrl: 'https://skillsbot.cn/skill/12345',
    completeness: 'md-only',
    detail: '---\nname: test-skill\ndescription: 冒烟用\n---\n\n# 测试技能\n\n正文内容。\n',
    enDetail: null,
    fileUrl: null,
    missingRefs: [],
    unescaped: false,
    ...over
  }
}

const mkConfig = (sharedRoot) => ({ sharedRoot, agents: {}, ui: {}, net: {} })

console.log('\n[URL 组装] resolveBotApiUrl / resolveBotUrl')
const base = 'https://skillsbot.cn/skillv3/api'
check('默认 API 路径', resolveBotApiUrl(base, '/category/list', { type: 1 }) === `${base}/category/list?type=1`)
check(
  '/v2/ 走根域（剥掉 API 前缀）',
  resolveBotApiUrl(base, '/v2/userStrategyNum', { productId: 9883 }) ===
    'https://skillsbot.cn/v2/userStrategyNum?productId=9883'
)
check('apiBase 覆盖生效', resolveBotApiUrl('https://x.test/api', '/category/list').startsWith('https://x.test/api'))
check(
  'query 跳过 undefined / null / 空串',
  resolveBotApiUrl(base, '/p', { a: 1, b: undefined, c: null, d: '' }) === `${base}/p?a=1`
)
check('分类分页路径拼接', resolveBotApiUrl(base, '/github/file/category/163/page/2', { limit: 12, type: 1 }) ===
  `${base}/github/file/category/163/page/2?limit=12&type=1`)
check('站内相对地址补全', resolveBotUrl('/a/b.zip') === 'https://skillsbot.cn/a/b.zip')
check('绝对地址原样', resolveBotUrl('https://cdn.x/y.zip') === 'https://cdn.x/y.zip')
check('无前导斜杠也补全', resolveBotUrl('a/b.zip') === 'https://skillsbot.cn/a/b.zip')

console.log('\n[反爬守卫] assertNotHoneypot')
let honeypotThrew = false
try { assertNotHoneypot('/skillv3/api/github/file/honeypot') } catch (e) { honeypotThrew = e instanceof BotApiError && e.code === 'honeypot' }
check('honeypot 路径被拦截（错误码 honeypot）', honeypotThrew)
let normalPass = true
try { assertNotHoneypot('/skillv3/api/github/file/8610') } catch { normalPass = false }
check('正常路径不误拦', normalPass)

console.log('\n[ID 保真] 19 位雪花 ID 不得经数值转换')
const BIG_ID = '2096185237169971201'
check('String 拼接后逐字符一致', String(BIG_ID) === BIG_ID)
check('Number() 会破坏精度（反向验证坑存在）', String(Number(BIG_ID)) !== BIG_ID, `Number 后 = ${String(Number(BIG_ID))}`)
const idUrl = resolveBotApiUrl(base, `/github/file/${BIG_ID}`)
check('URL 中 ID 逐字符保留', idUrl.endsWith(`/github/file/${BIG_ID}`), idUrl)
check('URL 不含被舍入的 ...1200', !idUrl.includes('2096185237169971200'))

console.log('\n[正文归一化] normalizeSkillMd')
const plain = '---\nname: a\n---\n\n# a\n'
const n1 = normalizeSkillMd(plain)
check('正常正文仅剥离首尾空白、未标记 unescaped', n1.text === plain.trim() && n1.unescaped === false)
check('正常正文内部换行未被改动', n1.text === '---\nname: a\n---\n\n# a')
const escaped = '---\\nname: stockapi\\ndescription: x\\n---\\n\\n# stockapi\\n'
const n2 = normalizeSkillMd(escaped)
check('字面量 \\n 被还原为真实换行', n2.text.includes('\nname: stockapi\n') && n2.unescaped === true)
check('还原后以 --- 开头（frontmatter 可解析）', n2.text.startsWith('---'))
const n3 = normalizeSkillMd('\uFEFF---\nname: b\n---\n')
check('去 BOM（首字符非 0xFEFF）', n3.text.charCodeAt(0) !== 0xfeff && n3.text.startsWith('---'))
const n4 = normalizeSkillMd('a\r\nb\r\n')
check('CRLF 归一为 LF', n4.text === 'a\nb')
check('空串安全', normalizeSkillMd('').text === '')

console.log('\n[完整性预判] judgeCompleteness（阈值用真实样本校准）')
const s1 = judgeCompleteness('x'.repeat(5778), 3194)
check('#1  5778字/3194B  → md-only', s1 === 'md-only', `实际 ${s1}`)
const s2583 = judgeCompleteness('x'.repeat(2040), 1151)
check('#2583 2040字/1151B → md-only', s2583 === 'md-only', `实际 ${s2583}`)
const s2304 = judgeCompleteness('x'.repeat(843), 1366)
check('#2304  843字/1366B → has-extras', s2304 === 'has-extras', `实际 ${s2304}`)
const s158 = judgeCompleteness('x'.repeat(5473), 35687)
check('#158  5473字/35687B → has-extras', s158 === 'has-extras', `实际 ${s158}`)
check('无 fileSize → unknown', judgeCompleteness('abc', null) === 'unknown')
check('无正文 → unknown', judgeCompleteness('', 1000) === 'unknown')

console.log('\n[附加文件识别] listMissingRefs')
const refs = listMissingRefs('需要 wordlist.txt 与 scripts/enum.py，另见 live_hosts.txt\n以及 https://github.com/a/b 和 Node.js / Cargo.toml 这类名词')
check('抓到脚本与数据文件', refs.includes('wordlist.txt') && refs.includes('scripts/enum.py') && refs.includes('live_hosts.txt'), JSON.stringify(refs))
check('过滤技术名词 Node.js', !refs.includes('Node.js'))
check('过滤 SKILL.md 自身', !refs.includes('SKILL.md'))
check('结果去重且有上限', refs.length === new Set(refs).size && refs.length <= 20)

console.log('\n[目录名净化] sanitizeSkillDirName')
check('路径分隔转连字符', sanitizeSkillDirName('a/b', 'fb') === 'a-b')
check('Windows 非法字符净化', !/[<>:"/\\|?*]/.test(sanitizeSkillDirName('a:b*c?d', 'fb')))
check('.. 落到 fallback', sanitizeSkillDirName('..', 'fb') === 'fb')
check('空值落到 fallback', sanitizeSkillDirName('   ', 'fb') === 'fb')
check('保留设备名加前缀', sanitizeSkillDirName('CON', 'fb') === '_CON')
check('中文原样保留', sanitizeSkillDirName('我的技能', 'fb') === '我的技能')
check('结尾点/空格剥离', sanitizeSkillDirName('abc. ', 'fb') === 'abc')

console.log('\n[分类树] flattenBotCategories')
const tree = [
  { id: 2, name: '人工智能', parentId: 0, type: 1, children: [
    { id: 17, name: '机器学习', parentId: 2, type: 1, children: [] },
    { id: 190, name: '大模型微调', parentId: 2, type: 1, children: [] }
  ] },
  { id: 1, name: '软件开发', parentId: 0, type: 1, children: [] }
]
const flat = flattenBotCategories(tree)
check('roots 计数正确', flat.roots.length === 2)
check('flat 含全部层级', flat.flat.length === 4, `实际 ${flat.flat.length}`)
check('子节点归并正确', flat.flat.some((c) => c.name === '机器学习'))

console.log('\n[免登录安装] writeBotSkillMarkdown 端到端（离线沙箱）')
const shared = join(SANDBOX, 'shared')
const cfg = mkConfig(shared)

const r1 = await writeBotSkillMarkdown(cfg, mkDetail())
const d1 = join(shared, 'test-skill')
check('技能目录已创建', existsSync(d1))
const md1 = readFileSync(join(d1, 'SKILL.md'), 'utf8')
check('SKILL.md 以 --- 开头', md1.startsWith('---'))
check('SKILL.md 首字符非 BOM', md1.charCodeAt(0) !== 0xfeff)
check('返回 mode=markdown', r1.mode === 'markdown')
check('md-only 判定为完整安装', r1.incomplete === false && r1.completeness === 'md-only')
const meta1 = JSON.parse(readFileSync(join(d1, '_meta.json'), 'utf8'))
check('_meta.source 指向站点详情页', meta1.source === 'https://skillsbot.cn/skill/12345', meta1.source)
check('_meta.bot.mode = markdown', meta1.bot?.mode === 'markdown')
check('_meta.bot.id 为字符串且未丢精度', typeof meta1.bot?.id === 'string')
check('_meta 已自动分类', typeof meta1.category === 'string' && meta1.category.length > 0, meta1.category)

console.log('\n[与技能库互通] skills.listSkills 能扫到刚装的技能')
const noFmRes = await writeBotSkillMarkdown(cfg, mkDetail({ detail: '# 无 frontmatter 的正文\n', enName: 'no-fm' }))
const dNoFm = join(shared, 'no-fm')
const mdNoFm = readFileSync(join(dNoFm, 'SKILL.md'), 'utf8')
check('无 frontmatter 自动补 ---', mdNoFm.startsWith('---'))
check('补上的 frontmatter 含 name', /name:\s*no-fm/.test(mdNoFm))
check('返回了日志行', Array.isArray(noFmRes.logs) && noFmRes.logs.length > 0)

const listed = listSkills(cfg)
const names = listed.map((s) => s.name)
check('技能库扫到 test-skill', names.includes('test-skill'), JSON.stringify(names))
check('技能库扫到 no-fm', names.includes('no-fm'))
const listedOne = listed.find((s) => s.name === 'test-skill')
check('技能库识别出站点来源', String(listedOne?.source ?? '').includes('skillsbot.cn/skill/'), String(listedOne?.source ?? ''))
check('技能库带出中文简介', Boolean(String(listedOne?.introZh ?? '').trim()))

console.log('\n[覆盖语义] replace')
await writeBotSkillMarkdown(cfg, mkDetail({ detail: '---\nname: v1\n---\n\n第一版\n' }), { replace: true })
const skip = await writeBotSkillMarkdown(cfg, mkDetail({ detail: '---\nname: v2\n---\n\n第二版\n' }), { replace: false })
const afterSkip = readFileSync(join(d1, 'SKILL.md'), 'utf8')
check('replace=false 时跳过并保留原内容', afterSkip.includes('第一版'))
check('跳过日志可见', skip.logs.some((l) => l.includes('[跳过]')))
await writeBotSkillMarkdown(cfg, mkDetail({ detail: '---\nname: v2\n---\n\n第二版\n' }), { replace: true })
check('replace=true 时内容被覆盖', readFileSync(join(d1, 'SKILL.md'), 'utf8').includes('第二版'))

console.log('\n[安全守卫] 目标是联接时禁止递归删除')
const linkTarget = join(SANDBOX, 'real-elsewhere')
mkdirSync(linkTarget, { recursive: true })
writeFileSync(join(linkTarget, 'IMPORTANT.txt'), '不能被删')
const junctionPath = join(shared, 'linked-skill')
let junctionOk = false
try {
  symlinkSync(linkTarget, junctionPath, 'junction')
  junctionOk = true
} catch {
  junctionOk = false
}
if (junctionOk) {
  let guardThrew = false
  try {
    await writeBotSkillMarkdown(cfg, mkDetail({ enName: 'linked-skill' }), { replace: true })
  } catch (e) {
    guardThrew = /安全守卫|联接/.test(String(e?.message ?? e))
  }
  check('目标为联接时被 assertRealDir 拒绝', guardThrew)
  check('联接指向的真实目录内容未被删除', existsSync(join(linkTarget, 'IMPORTANT.txt')))
} else {
  console.log('  ~ 跳过：当前环境无法创建 junction（非 Windows 或权限不足）')
}

console.log('\n[包含附加文件的技能] 应标注不完整')
const rExtra = await writeBotSkillMarkdown(cfg, mkDetail({
  enName: 'with-extras',
  fileSize: 35687,
  completeness: 'has-extras',
  missingRefs: ['wordlist.txt', 'subdomains.txt'],
  detail: '---\nname: with-extras\ndescription: x\n---\n\n见 wordlist.txt 与 subdomains.txt\n'
}))
check('返回 incomplete=true', rExtra.incomplete === true)
check('日志明确写出不完整', rExtra.logs.some((l) => l.includes('免登录安装不完整')))
check('日志列出缺失文件', rExtra.logs.some((l) => l.includes('wordlist.txt')))

check('分页常量与站点一致（固定 12）', BOT_PAGE_SIZE === 12)

cleanup()

console.log(`\n${failed === 0 ? '✅' : '❌'} P12 冒烟测试${failed === 0 ? '全部通过' : `失败 ${failed} 项`}（离线部分）`)
console.log('未覆盖（需真机网络/无账号环境）：真实分类树 / 搜索 / 热门 / 最新 / 详情拉取，')
console.log('  以及 19 位 ID 技能的真实详情与安装。')
process.exit(failed === 0 ? 0 : 1)
