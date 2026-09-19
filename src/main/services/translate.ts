import { Agent, request as httpsRequest } from 'node:https'
import { Buffer } from 'node:buffer'

/**
 * 网络与翻译助手（translate.ps1 公共库的 Node 版 + 国内接口增强）。
 *
 * 翻译接口链：腾讯 TranSmart（国内直连，无需 key）→ MyMemory（免费无需 key）→ Google gtx 兜底；
 * 均失败返回原文，调用方用 hasCjk 判定成败。长简介按句切块翻译再拼接。
 * PS 版只有 MyMemory → Google 两级；腾讯接口是桌面版增强（README 已记，不回写 PS 仓库）。
 */

export interface HttpOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  /** 本机代理根证书不在 Node CA 库时放宽 TLS 校验（对应 PS 版无此问题，Node 侧需要） */
  insecure?: boolean
  method?: string
  /** POST 请求体（原始字符串；httpPostJson 里自动 JSON 序列化） */
  body?: string
}

/** 复用单个放宽校验的 Agent，避免每次请求新建 socket 池 */
let insecureAgent: Agent | null = null
function getInsecureAgent(): Agent {
  if (!insecureAgent) insecureAgent = new Agent({ rejectUnauthorized: false })
  return insecureAgent
}

interface RawResponse {
  status: number
  body: Buffer
  location?: string | string[]
}

function httpsRequestOnce(url: string, opts: HttpOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpsRequest(
      u,
      {
        method: opts.method ?? 'GET',
        headers: { 'User-Agent': 'agent-skills-shared', ...(opts.headers ?? {}) },
        timeout: opts.timeoutMs ?? 15000,
        agent: opts.insecure ? getInsecureAgent() : undefined
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            location: res.headers.location
          })
        )
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

/** GET 并跟随最多 3 次重定向；返回最终 status + body（不抛非 200，调用方按需判定） */
export async function httpGetResponse(
  url: string,
  opts: HttpOptions = {},
  maxRedirects = 3
): Promise<{ status: number; body: Buffer }> {
  let current = url
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await httpsRequestOnce(current, opts)
    if (r.status >= 300 && r.status < 400) {
      const loc = Array.isArray(r.location) ? r.location[0] : r.location
      if (loc) {
        current = new URL(loc, current).toString()
        continue
      }
    }
    return { status: r.status, body: r.body }
  }
  throw new Error('重定向次数过多')
}

/** GET 并要求 200（非 200 抛错，错误消息带状态码） */
export async function httpGet(url: string, opts: HttpOptions = {}): Promise<Buffer> {
  const { status, body } = await httpGetResponse(url, opts)
  if (status !== 200) throw new Error(`HTTP ${status}`)
  return body
}

export async function httpGetJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const body = await httpGet(url, opts)
  return JSON.parse(body.toString('utf8')) as T
}

/** POST JSON 并解析 JSON 响应（不跟随重定向——翻译接口不需要） */
export async function httpPostJson<T>(
  url: string,
  payload: unknown,
  opts: HttpOptions = {}
): Promise<T> {
  const body = JSON.stringify(payload)
  const r = await httpsRequestOnce(url, {
    ...opts,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      ...(opts.headers ?? {})
    },
    body
  })
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${url}`)
  return JSON.parse(r.body.toString('utf8')) as T
}

// ---------- 文本工具（与 translate.ps1 同语义） ----------

export function hasCjk(text: string): boolean {
  if (!text || !text.trim()) return false
  return /[\u4e00-\u9fff]/.test(text)
}

export function decodeHtmlEntities(text: string): string {
  if (!text || !text.trim()) return text
  return text
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** 按句边界切块：免费接口单次长度有限，长简介分块翻译再拼接（PS Split-ForTranslate 同口径） */
export function splitForTranslate(text: string, maxLen = 450): string[] {
  const parts = text.split(/(?<=[。！？!?.;；\n])/)
  const chunks: string[] = []
  let cur = ''
  for (const raw of parts) {
    const p = raw
    if (!p.trim()) continue
    if (cur.length > 0 && cur.length + p.length > maxLen) {
      chunks.push(cur)
      cur = ''
    }
    let piece = p
    while (piece.length > maxLen) {
      chunks.push(piece.slice(0, maxLen))
      piece = piece.slice(maxLen)
    }
    cur += piece
  }
  if (cur.length > 0) chunks.push(cur)
  if (chunks.length === 0) chunks.push(text)
  return chunks
}

/**
 * 腾讯交互翻译 TranSmart（transmart.qq.com 网页接口）：无需 key、国内直连、整句质量好。
 * 请求头带浏览器 UA + Referer（网页接口按浏览器场景设计）；任何异常返回 '' 交给下一级兜底。
 */
export async function tencentZh(text: string): Promise<string> {
  try {
    const r = await httpPostJson<{ auto_translation?: string[]; target?: { text_list?: string[] } }>(
      'https://transmart.qq.com/api/imt',
      {
        header: {
          fn: 'auto_translation',
          session: '',
          client_key: 'browser-chromium-Win64-125.0.0.0-Web'
        },
        type: 'plain',
        model_category: 'matrix',
        text_domain: 'general',
        source: { lang: 'en', text_list: [text] },
        target: { lang: 'zh' }
      },
      {
        timeoutMs: 12000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Referer: 'https://transmart.qq.com/zh-CN/browser'
        }
      }
    )
    const zh = (r.auto_translation?.[0] ?? r.target?.text_list?.[0] ?? '').trim()
    return zh || ''
  } catch {
    return ''
  }
}

/** MyMemory 免费接口；接口把错误信息塞在 translatedText 里，必须识别（PS 同款判定） */
async function myMemoryZh(text: string, email?: string): Promise<string> {
  try {
    const q = encodeURIComponent(text)
    let uri = `https://api.mymemory.translated.net/get?q=${q}&langpair=en|zh-CN`
    // 匿名配额很低；带 de=邮箱 可显著提高每日额度（官方支持的用法）
    if (email) uri += `&de=${encodeURIComponent(email)}`
    const r = await httpGetJson<{ responseData?: { translatedText?: string } }>(uri, {
      timeoutMs: 12000
    })
    const zh = (r.responseData?.translatedText ?? '').trim()
    if (!zh || zh === 'NO QUERY SPECIFIED') return ''
    if (/MYMEMORY WARNING/.test(zh)) return ''
    if (/QUERY LENGTH LIMIT EXCEEDED/.test(zh)) return ''
    if (/INVALID (EMAIL|LANGPAIR|SOURCE|TARGET)/.test(zh)) return ''
    return decodeHtmlEntities(zh).trim()
  } catch {
    return ''
  }
}

/** Google gtx 兜底：返回 JSON 数组，第一项的分段数组拼出全文 */
async function googleZh(text: string): Promise<string> {
  try {
    const q = encodeURIComponent(text)
    const uri = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${q}`
    const r = await httpGetJson<unknown>(uri, { timeoutMs: 10000 })
    let zh = ''
    const first = (r as [unknown, ...unknown[]])[0]
    if (Array.isArray(first)) {
      for (const seg of first) {
        if (Array.isArray(seg) && typeof seg[0] === 'string') zh += seg[0]
      }
    }
    return decodeHtmlEntities(zh).trim()
  } catch {
    return ''
  }
}

/** 单块翻译：腾讯 TranSmart（国内优先）→ MyMemory → Google gtx，均失败返回 '' */
export async function translateChunk(text: string, email?: string): Promise<string> {
  const zh = await tencentZh(text)
  if (zh) return zh
  const my = await myMemoryZh(text, email)
  if (my) return my
  return googleZh(text)
}

/** CJK 字符占比：混合文本判定用（"含中文"不够——英文简介常带中文 Trigger 词表） */
export function cjkRatio(text: string): number {
  if (!text || !text.length) return 0
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length / text.length
}

/**
 * 整段简介翻译：
 * - 中文占比 >= 40% 视为已是中文，原样返回（如 "…核心方法：用 LLM 做结构化差异比对…"）
 * - 其余（纯英文 / 英文为主夹少量中文）按句分块：含中文的块保留，纯英文块翻译
 *   ——解决 "Cross-border and logistics: … Trigger: …, 走私, 跨境" 这类混合简介漏翻
 * - 单块翻译失败保留原文
 */
export async function translateDescription(
  description: string,
  email?: string,
  maxLen = 450
): Promise<string> {
  if (!description || !description.trim()) return ''
  const desc = description.trim()
  if (cjkRatio(desc) >= 0.4) return desc
  const chunks = splitForTranslate(desc, maxLen)
  let out = ''
  let changed = false
  for (const c of chunks) {
    if (cjkRatio(c) >= 0.25) {
      out += c
      continue
    }
    let zh = await translateChunk(c, email)
    if (zh) changed = true
    else zh = c
    out += zh
  }
  return changed ? out.trim() : desc
}
