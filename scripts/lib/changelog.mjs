/**
 * CHANGELOG.md 解析（check-changelog / release-notes 共用）。
 *
 * 认这几种标题写法（大小写与方括号宽松）：
 *   ## [1.2.3] - 2026-09-21
 *   ## 1.2.3（2026-09-21）
 *   ## [v1.2.3]
 *   ## [未发布] / ## [Unreleased]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(HERE, '..', '..')

export function readPackageVersion(root = PROJECT_ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

export function readChangelogText(root = PROJECT_ROOT) {
  return readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
}

const HEADING =
  /^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+|未发布|Unreleased)\]?\s*(?:[-–—(（]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*[)）]?)?\s*$/

/** 拆成 [{ version, date, body }]（body 为段落正文，已 trim） */
export function parseChangelog(text) {
  const sections = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const m = HEADING.exec(raw.trim())
    if (m) {
      cur = { version: m[1], date: m[2], lines: [] }
      sections.push(cur)
      continue
    }
    if (cur) cur.lines.push(raw)
  }
  return sections.map((s) => ({
    version: s.version,
    date: s.date,
    body: s.lines.join('\n').trim()
  }))
}

/** 取某个版本的段落；没有则返回 null */
export function extractVersionSection(text, version) {
  const want = String(version).replace(/^v/, '')
  return parseChangelog(text).find((s) => s.version === want) ?? null
}

/** 段落里的说明条数（以 `- ` 开头的行） */
export function countBullets(body) {
  return body.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\S/.test(l)).length
}

/** 今天的 YYYY-MM-DD */
export function today() {
  return new Date().toISOString().slice(0, 10)
}
