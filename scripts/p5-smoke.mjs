#!/usr/bin/env node
/**
 * P5 冒烟测试（离线部分）：在临时沙箱里真跑 skills.ts 的
 * 链接解析 / 分类 / frontmatter / 列表 / 路由生成 / 移除守卫 / 翻译跳过逻辑。
 * 不发任何网络请求（安装与真实翻译留给真机验证）。
 *
 * 用法：node scripts/p5-smoke.mjs
 */
import { buildSync } from 'esbuild'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 打包到 node_modules/.cache 下，让 external 的 extract-zip 能按相对路径解析
const cacheDir = join(ROOT, 'node_modules', '.cache')
mkdirSync(cacheDir, { recursive: true })
const bundle = join(cacheDir, 'p5-smoke-bundle.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/main/services/skills.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  packages: 'external',
  alias: { '@shared': join(ROOT, 'src', 'shared') }
})

const mod = await import(import.meta.url ? 'file:///' + bundle.replace(/\\/g, '/') : '')
const {
  parseSourceUrl,
  classifySkill,
  readFrontmatter,
  listSkills,
  buildRouterMarkdown,
  generateRouter,
  removeSkill,
  translateIntros
} = mod

let failed = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failed++
}
function mkSkill(root, name, desc, extraMeta) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`)
  if (extraMeta) writeFileSync(join(dir, '_meta.json'), JSON.stringify(extraMeta, null, 2))
  return dir
}

console.log('\n[链接解析] parseSourceUrl')
const u1 = parseSourceUrl('https://github.com/hgta23/findskills')
check('github 完整链接', u1.owner === 'hgta23' && u1.repo === 'findskills')
const u2 = parseSourceUrl('vercel-labs/skills.git')
check('owner/repo 短链接（去 .git）', u2.owner === 'vercel-labs' && u2.repo === 'skills')
const u3 = parseSourceUrl('https://skills.sh/s/vercel-labs/skills/find-skills')
check('skills.sh 指定技能', u3.owner === 'vercel-labs' && u3.repo === 'skills' && u3.wantedSkill === 'find-skills')
let threw = false
try { parseSourceUrl('https://gitlab.com/a/b') } catch { threw = true }
check('不认识的来源报错', threw)

console.log('\n[分类] classifySkill')
check('frontmatter category 精确命中', classifySkill('x', '', { category: '数据分析' }) === '数据分析')
check('frontmatter tags 关键词命中', classifySkill('x', '', { tags: 'unit test for py' }) === '开发与工程')
check('英文关键词不做子串匹配（词边界）', classifySkill('x', '', { tags: 'unit testing for py' }) === '未分类')
check('名称英文词边界命中', classifySkill('git-commit-helper', '') === '开发与工程')
check('简介中文子串命中', classifySkill('whatever', '帮你写小红书爆款文案') === '写作与内容')
check('全不命中 → 未分类', classifySkill('zzz-qqq', 'nothing here') === '未分类')

console.log('\n[frontmatter] readFrontmatter')
const fmDir = mkdtempSync(join(tmpdir(), 'p5-fm-'))
const fmPath = join(fmDir, 'SKILL.md')
writeFileSync(
  fmPath,
  '---\nname: t\ndescription: first line\n  continued here\ndescription2: >\n  folded text\n  more\n---\n'
)
const fm = readFrontmatter(fmPath)
check('单行键值', fm['name'] === 't')
check('缩进续行拼接', fm['description'] === 'first line continued here')
check('折叠块并入正文', fm['description2'] === 'folded text more')
rmSync(fmDir, { recursive: true, force: true })

console.log('\n[列表 + 路由 + 移除] 沙箱全流程')
const sandbox = mkdtempSync(join(tmpdir(), 'p5-sandbox-'))
const sharedRoot = join(sandbox, 'shared')
mkdirSync(sharedRoot, { recursive: true })
const cfg = { sharedRoot, agents: {}, ui: {}, net: {} }

mkSkill(sharedRoot, 'code-reviewer', 'Review code and suggest improvements for python projects', {
  name: 'code-reviewer',
  description: 'Review code and suggest improvements for python projects',
  descriptionZh: '审查代码并提出改进建议'
})
mkSkill(sharedRoot, 'xiaohongshu-writer', '写小红书爆款笔记', {
  name: 'xiaohongshu-writer',
  description: '写小红书爆款笔记',
  descriptionZh: '写小红书爆款笔记',
  source: 'https://github.com/a/b',
  branch: 'main',
  commitSha: 'abc123',
  installedAt: '2026-09-20 04:00:00',
  translatedAt: '2026-09-20 04:10:00'
})
// 注意：简介必须含中文（或已有 descriptionZh），否则翻译环节会真发网络请求，破坏离线确定性；
// 且不能命中任何分类关键词（如「内容」「数据」），否则未分类断言会挂
mkSkill(sharedRoot, 'mystery-box', '随便写的几个字')

const list = listSkills(cfg)
check('扫描到 3 个技能', list.length === 3, `实际 ${list.length}`)
check('按名称排序', list.map((s) => s.name).join(',') === 'code-reviewer,mystery-box,xiaohongshu-writer')
check('分类：开发与工程', list[0].category === '开发与工程', list[0].category)
check('分类：写作与内容', list[2].category === '写作与内容', list[2].category)
check('分类：未分类', list[1].category === '未分类', list[1].category)
const zhOne = list[2]
check('meta 字段齐全', zhOne.introZh === '写小红书爆款笔记' && zhOne.source === 'https://github.com/a/b' && zhOne.commitSha === 'abc123' && zhOne.translatedAt === '2026-09-20 04:10:00')

// 联接混入共享库：列表必须跳过，不能当作技能
const evilTarget = join(sandbox, 'elsewhere')
mkdirSync(evilTarget, { recursive: true })
const evilLink = join(sharedRoot, 'evil-junction-skill')
symlinkSync(evilTarget, evilLink, 'junction')
const list2 = listSkills(cfg)
check('联接目录不进技能列表', list2.length === 3, `实际 ${list2.length}`)

// 移除守卫
let threwRemove = false
try { removeSkill(cfg, '../outside') } catch { threwRemove = true }
check('路径穿越被拒绝', threwRemove)
threwRemove = false
try { removeSkill(cfg, 'evil-junction-skill') } catch { threwRemove = true }
check('联接目录被守卫拒绝', threwRemove)
threwRemove = false
try { removeSkill(cfg, 'no-such-skill') } catch { threwRemove = true }
check('不存在的技能报错', threwRemove)
const resRemove = removeSkill(cfg, 'mystery-box')
check('移除真实技能成功', resRemove.logs.some((l) => l.includes('[OK]')) && !existsSync(join(sharedRoot, 'mystery-box')))

// 路由生成
const resRouter = await generateRouter(cfg)
check('路由生成 [OK]', resRouter.logs.some((l) => l.includes('[OK]')))
const routerPath = join(sharedRoot, 'router-guide', 'SKILL.md')
check('router-guide/SKILL.md 存在', existsSync(routerPath))
const routerRaw = readFileSync(routerPath, 'utf8')
check('UTF-8 BOM 开头', routerRaw.charCodeAt(0) === 0xfeff)
const routerMd = routerRaw.replace(/^\uFEFF/, '')
check('frontmatter name: skill-router', routerMd.startsWith('---\nname: skill-router\n'))
check('收录剩余 2 技能 + 路由自身排除', routerMd.includes('共 2 个技能') && !routerMd.includes('router-guide'), '')
check('分类分组标题出现', routerMd.includes('### 开发与工程（1）') && routerMd.includes('### 写作与内容（1）'))
check('中文简介优先展示', routerMd.includes('**xiaohongshu-writer**：写小红书爆款笔记'))
// 纯函数一致性：buildRouterMarkdown 输出与文件内容一致
const items = listSkills(cfg).filter((s) => s.name !== 'router-guide').map((s) => ({ name: s.name, intro: s.introZh || s.intro, category: s.category }))
check('buildRouterMarkdown 与文件一致', buildRouterMarkdown(items, sharedRoot) === routerMd)

// 翻译跳过逻辑（离线：全部技能均有中文简介 → 不应发请求、0 写入）
const resTr = await translateIntros(cfg, {})
check('翻译全库：全部命中跳过（不发请求）', resTr.logs.some((l) => l.includes('已有中文简介')))
check('翻译 0 个写入', resTr.logs.some((l) => l.includes('已翻译写入: 0 个')))

// 清理
if (!failed) {
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(bundle, { force: true })
  console.log('\n✅ P5 冒烟测试全部通过（离线部分），沙箱已清理')
  console.log('   未覆盖（需真机网络）：skills:install 真实下载安装、translateIntros 真实调用翻译接口')
} else {
  console.log(`\n❌ ${failed} 项断言失败（沙箱保留供排查: ${sandbox}）`)
  process.exit(1)
}
void existsSync
void lstatSync
void readdirSync
