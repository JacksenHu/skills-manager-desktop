#!/usr/bin/env node
/**
 * P4 冒烟测试：在临时沙箱里真跑 junction-write.ts 的 建 / 拆 / 归并。
 * 不碰真实共享库；全程断言，任何一步失败 exit 1。
 *
 * 用法：node scripts/p4-smoke.mjs
 */
import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 1) 把 TS 服务打成临时 ESM bundle（与 verify-alignment 同法：验证真实模块）
const bundleDir = mkdtempSync(join(tmpdir(), 'p4-bundle-'))
const bundle = join(bundleDir, 'junction-write.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/main/services/junction-write.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { '@shared': join(ROOT, 'src', 'shared') }
})

// 2) 临时沙箱
const sandbox = mkdtempSync(join(tmpdir(), 'p4-sandbox-'))
const sharedRoot = join(sandbox, 'shared')
mkdirSync(sharedRoot, { recursive: true })

let failed = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failed++
}

function mkSkill(dir, name, body) {
  const d = join(dir, name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), body ?? `---\nname: ${name}\n---\n\n# ${name}\n`)
}

// 共享库里预置一个技能
mkSkill(sharedRoot, 'alpha')

const mod = await import(import.meta.url ? 'file:///' + bundle.replace(/\\/g, '/') : '')
const { planCreate, createJunction, removeJunction, buildMergePlans, mergeGroup } = mod

/** 构造与主进程一致的 config（不依赖 electron） */
function makeConfig(agents) {
  return { sharedRoot, agents, ui: {}, net: {} }
}

console.log('\n[用例 A] 接入真实目录（内容迁移 + 建联接）')
const agentA = join(sandbox, '.testagent-a', 'skills')
mkSkill(agentA, 'beta', '---\nname: beta\n---\n\n# beta local copy\n')
mkSkill(agentA, 'gamma')
const planA = planCreate('test-a', agentA, makeConfig({}))
check('预案场景为 real-dir', planA.scenario === 'real-dir')
check('预案列出 2 项迁移', planA.items.length === 2 && planA.items.every((i) => i.action === 'move'))
check('预案不阻塞', !planA.blocked, planA.blockedReason ?? '')
const resA = createJunction(agentA, makeConfig({}))
check('建联接日志含 [OK]', resA.logs.some((l) => l.startsWith('[OK]')))
check('联接存在且为符号链接', lstatSync(agentA).isSymbolicLink())
check('联接指向共享库', readlinkSync(agentA).toLowerCase() === sharedRoot.toLowerCase())
check('迁移后经联接可见 3 个技能', readdirSync(agentA).sort().join(',') === 'alpha,beta,gamma')

console.log('\n[用例 B] 重复接入（already-active）')
const planB = planCreate('test-a', agentA, makeConfig({ 'test-a': agentA }))
check('场景为 already-active', planB.scenario === 'already-active')
const resB = createJunction(agentA, makeConfig({}))
check('日志为 [SKIP]', resB.logs.some((l) => l.includes('[SKIP]')))

console.log('\n[用例 C] 去重：内容一致的冗余副本被删除，不一致的冲突阻塞')
const agentC = join(sandbox, '.testagent-c', 'skills')
mkdirSync(agentC, { recursive: true })
mkSkill(agentC, 'alpha') // 与共享库 alpha 内容一致 → 去重
mkSkill(agentC, 'alpha2', '---\nname: alpha\n---\n\n# DIFFERENT\n')
// 注意：alpha2 目录名不同，真正冲突需同名 —— 改用同名目录制造冲突
rmSync(join(agentC, 'alpha2'), { recursive: true })
mkSkill(agentC, 'alpha-x')
mkdirSync(join(sharedRoot, 'alpha-x'), { recursive: true })
writeFileSync(join(sharedRoot, 'alpha-x', 'SKILL.md'), '---\nname: alpha-x\n---\n\n# SHARED VERSION\n')
const planC = planCreate('test-c', agentC, makeConfig({}))
check('冲突计数 = 1', planC.conflictCount === 1, `实际 ${planC.conflictCount}`)
check('去重计数 = 1', planC.items.filter((i) => i.action === 'dedupe').length === 1)
check('预案阻塞', planC.blocked)

console.log('\n[用例 D] 拆除联接（数据保留）')
const resD = removeJunction(agentA)
check('日志含 [OK] 已拆除', resD.logs.some((l) => l.includes('[OK]')))
check('联接已消失', !existsSync(agentA))
check('共享库数据完好（3 技能）', readdirSync(sharedRoot).sort().join(',') === 'alpha,alpha-x,beta,gamma')

console.log('\n[用例 E] 拆除非联接目录 → SKIP；拆除不存在 → SKIP')
const resE1 = removeJunction(sharedRoot)
check('真实目录 SKIP', resE1.logs.some((l) => l.includes('[SKIP]')))
const resE2 = removeJunction(join(sandbox, 'no-such-dir'))
check('不存在 SKIP', resE2.logs.some((l) => l.includes('[SKIP]')))

console.log('\n[用例 F] 归并：两个活跃根同组 → 保留推荐根，其余变空目录')
const root1 = join(sandbox, '.doubao', 'agent_mode', 'workspace', '.user_skills')
const root2 = join(sandbox, 'home', '.agents', 'skills')
for (const r of [root1, root2]) {
  mkdirSync(dirname0(r), { recursive: true })
  const { symlinkSync } = await import('node:fs')
  symlinkSync(sharedRoot, r, 'junction')
}
function dirname0(p) {
  return p.slice(0, p.lastIndexOf('\\'))
}
const cfgF = makeConfig({ doubao_user: root1, agents_dir: root2 })
const plans = buildMergePlans(cfgF)
check('产出 1 个归并预案', plans.length === 1, `实际 ${plans.length} 组`)
const planF = plans[0]
check('组名为 Doubao（豆包）', planF.name.startsWith('Doubao'), planF.name)
check('推荐保留 .agents\\skills（覆盖组最多）', planF.keepPath === root2, planF.keepPath)
const resF = mergeGroup(planF.name, planF.keepPath, cfgF)
check('归并日志含 [OK]', resF.logs.some((l) => l.includes('[OK] 已归并')))
check('被归并根变为空目录（真实目录，非联接）', existsSync(root1) && !lstatSync(root1).isSymbolicLink() && readdirSync(root1).length === 0)
check('保留根仍是指向共享库的联接', lstatSync(root2).isSymbolicLink() && readlinkSync(root2).toLowerCase() === sharedRoot.toLowerCase())
const plansAfter = buildMergePlans(cfgF)
check('归并后再跑预案：无活跃根 >= 2 的组', plansAfter.length === 0)

console.log('\n[用例 G] 归并守卫：保留路径不在组内 → 拒绝')
let threw = false
try {
  mergeGroup(planF.name, join(sandbox, 'evil'), cfgF)
} catch {
  threw = true
}
check('非法保留路径被拒绝', threw)

// 清理沙箱与 bundle
if (!failed) {
  rmSync(sandbox, { recursive: true, force: true })
  rmSync(bundleDir, { recursive: true, force: true })
  console.log('\n✅ P4 冒烟测试全部通过，沙箱已清理')
} else {
  console.log(`\n❌ ${failed} 项断言失败（沙箱保留供排查: ${sandbox}）`)
  process.exit(1)
}

// 防止 esbuild 未使用导入告警传导（cpSync/readFileSync 供后续扩展）
void cpSync
void readFileSync
void spawnSync
