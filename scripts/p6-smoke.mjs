#!/usr/bin/env node
/**
 * P6 冒烟测试（离线部分）：来源解析 / 六态判定 / 分组逻辑。
 * 不发网络请求（真实 GitHub 检测由一次性脚本单独验证）。
 *
 * 用法：node scripts/p6-smoke.mjs
 */
import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(ROOT, 'node_modules', '.cache')
mkdirSync(cacheDir, { recursive: true })
const bundle = join(cacheDir, 'p6-smoke-bundle.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/main/services/updates.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  packages: 'external',
  alias: { '@shared': join(ROOT, 'src', 'shared') }
})
const { parseRepoKey, judgeRepoUpdate, groupByRepo } = await import(
  import.meta.url ? 'file:///' + bundle.replace(/\\/g, '/') : ''
)

let failed = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failed++
}

console.log('\n[来源解析] parseRepoKey')
check('github 链接', parseRepoKey('https://github.com/a/b') === 'a/b')
check('去 .git', parseRepoKey('https://github.com/a/b.git') === 'a/b')
check('带分支/锚点不带入', parseRepoKey('https://github.com/a/b/tree/main') === 'a/b')
check('非 GitHub → null', parseRepoKey('https://gitlab.com/a/b') === null)
check('空 → null', parseRepoKey(undefined) === null)

console.log('\n[六态判定] judgeRepoUpdate')
check('最新', judgeRepoUpdate('abc', 'abc', 0) === 'latest')
check('有更新', judgeRepoUpdate('abc', 'def', 0) === 'update')
check('无基准（本地空）', judgeRepoUpdate('', 'def', 0) === 'no-baseline')
check('限速 403', judgeRepoUpdate('abc', '', 403) === 'rate-limited')
check('限速 429', judgeRepoUpdate('abc', '', 429) === 'rate-limited')
check('仓库消失 404', judgeRepoUpdate('abc', '', 404) === 'gone')
check('网络异常', judgeRepoUpdate('abc', '', 0) === 'error')

console.log('\n[分组] groupByRepo')
const skills = [
  { name: 's1', source: 'https://github.com/owner1/repoA', commitSha: '' },
  { name: 's2', source: 'https://github.com/owner1/repoA', commitSha: 'sha222' },
  { name: 's3', source: 'https://github.com/owner2/repoB', commitSha: 'sha333' },
  { name: 'local-only', source: undefined, commitSha: undefined },
  { name: 'market-skill', source: 'https://example.com/x', commitSha: undefined }
]
const g = groupByRepo(skills)
check('识别 2 个仓库', g.repos.length === 2, `实际 ${g.repos.length}`)
check('同仓库多技能归组', g.repos[0].skills.join(',') === 's1,s2')
check('基准取任一非空 SHA', g.repos[0].localSha === 'sha222', g.repos[0].localSha)
check('第二仓库独立基准', g.repos[1].localSha === 'sha333')
check('无来源 2 个（含版本字段透传）', g.noSource.length === 2)
check('无来源不含 GitHub 来源技能', !g.noSource.some((s) => s.name === 's1'))

if (!failed) {
  rmSync(bundle, { force: true })
  console.log('\n✅ P6 冒烟测试全部通过（离线部分）')
  console.log('   未覆盖（需真机网络）：checkSkillUpdates 真实 API 调用、updateSkills 升级、checkToolUpdate')
} else {
  console.log(`\n❌ ${failed} 项断言失败`)
  process.exit(1)
}
