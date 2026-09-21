#!/usr/bin/env node
/**
 * 输出某个版本的更新说明（默认 = package.json 的 version），作为 GitHub Release 的正文。
 *
 * 用法：
 *   node scripts/release-notes.mjs                       # 打到标准输出（本地预览）
 *   node scripts/release-notes.mjs --out NOTES.md         # 写文件（CI 里配合 gh release create --notes-file）
 *   node scripts/release-notes.mjs --version 0.4.0
 *
 * 找不到对应版本段落时报错退出（exit 1）—— 宁可发布失败，也不发出没有说明的版本。
 */
import { writeFileSync } from 'node:fs'
import {
  PROJECT_ROOT,
  readPackageVersion,
  readChangelogText,
  extractVersionSection,
  countBullets,
  today
} from './lib/changelog.mjs'

const args = process.argv.slice(2)
let version = readPackageVersion()
let out = null
let tail = true

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i]
  else if (args[i] === '--version') version = String(args[++i]).replace(/^v/, '')
  else if (args[i] === '--no-tail') tail = false
  else if (!args[i].startsWith('-')) version = args[i].replace(/^v/, '')
}

void PROJECT_ROOT

const section = extractVersionSection(readChangelogText(), version)
if (!section || countBullets(section.body) === 0) {
  console.error(`✗ CHANGELOG.md 缺少 [${version}] 段落（或有段落但没内容），无法生成更新说明`)
  console.error('')
  console.error(`  请把「## [未发布]」改成：  ## [${version}] - ${today()}`)
  console.error('  并在上方新开一个空的「## [未发布]」。')
  process.exit(1)
}

const parts = []
parts.push(`### ${version}${section.date ? ` · ${section.date}` : ''}`)
parts.push('')
parts.push(section.body)
if (tail) {
  parts.push('')
  parts.push('---')
  parts.push('已安装旧版本的用户：打开应用 → 「更新」页 → 检测到新版本后一键下载升级。')
}

const body = parts.join('\n') + '\n'

if (out) {
  writeFileSync(out, body, 'utf8')
  console.log(`✓ 已写入 ${out}（版本 ${version}，${countBullets(section.body)} 条说明）`)
} else {
  process.stdout.write(body)
}
