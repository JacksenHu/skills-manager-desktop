#!/usr/bin/env node
/**
 * 校验「发版必须有更新说明」：package.json 的版本在 CHANGELOG.md 里要有非空段落。
 *
 * 用法：
 *   node scripts/check-changelog.mjs            # 校验 package.json 的 version
 *   node scripts/check-changelog.mjs 0.4.0      # 校验指定版本（可写 v0.4.0）
 *
 * 已接入 npm run verify:all 与发布工作流（.github/workflows/release.yml），
 * 忘了写就红灯，不会发出一个没有说明的版本。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROJECT_ROOT,
  readPackageVersion,
  readChangelogText,
  extractVersionSection,
  countBullets,
  today
} from './lib/changelog.mjs'

const version = (process.argv[2] ?? readPackageVersion()).replace(/^v/, '')
const path = join(PROJECT_ROOT, 'CHANGELOG.md')

if (!existsSync(path)) {
  console.error('✗ 找不到 CHANGELOG.md')
  process.exit(1)
}

const section = extractVersionSection(readChangelogText(), version)

if (!section) {
  console.error(`✗ CHANGELOG.md 里没有 [${version}] 段落 —— 这个版本没有更新说明`)
  console.error('')
  console.error('  发版前请把「## [未发布]」改成：')
  console.error(`      ## [${version}] - ${today()}`)
  console.error('  并在上方新开一个空的「## [未发布]」段落。')
  process.exit(1)
}

const bullets = countBullets(section.body)
if (bullets === 0) {
  console.error(`✗ CHANGELOG.md 的 [${version}] 段落是空的，至少写一条「- 说明」`)
  process.exit(1)
}

console.log(`✓ CHANGELOG.md 有 [${version}] 段落${section.date ? `（${section.date}）` : ''}：${bullets} 条说明`)
