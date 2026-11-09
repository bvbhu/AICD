/** Output paths, Markdown rendering and the "last conversation" ledger. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const OFFSET_MS = 8 * 60 * 60 * 1000 // Asia/Shanghai has no DST

export function nowIso() {
  return new Date(Date.now() + OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

export function nowStamp() {
  return new Date(Date.now() + OFFSET_MS).toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

export function slugify(text, limit = 32) {
  const cleaned = String(text || '')
    .replace(/[^\w\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned.slice(0, limit).replace(/-+$/g, '') || 'chat')
}

export function defaultPluginRoot() {
  return process.env.DSH_GPT_ROOT || join(homedir(), '.dsh', 'gpt-web')
}

export class Store {
  constructor(root) {
    this.root = root
    this.conversations = join(root, 'conversations')
    this.images = join(root, 'images')
    this.videoFrames = join(root, 'video-frames')
    this.state = join(root, '.state')
    this.lastFile = join(this.state, 'last.json')
    this.tmp = join(this.state, 'tmp')
  }

  ensure() {
    for (const dir of [this.conversations, this.images, this.videoFrames, this.state, this.tmp]) mkdirSync(dir, { recursive: true })
    return this
  }

  readLast() {
    if (!existsSync(this.lastFile)) return null
    try {
      return JSON.parse(readFileSync(this.lastFile, 'utf8'))
    } catch {
      return null
    }
  }

  remember(meta, path) {
    this.ensure()
    const record = { ...meta, path }
    writeFileSync(this.lastFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return record
  }

  /** Render the transcript and write it to disk. */
  saveConversation({ prompt, reply, meta, plain = false, out }) {
    const markdown = renderMarkdown(prompt, reply, meta, plain)
    if (!out) {
      this.ensure()
      const stamp = nowStamp()
      const slug = slugify(prompt)
      const id = String(meta.conversation_id || '')
      out = join(this.conversations, id ? `${id.slice(0, 8)}-${stamp}-${slug}.md` : `${stamp}-${slug}.md`)
    }
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, markdown, 'utf8')
    return { markdown, path: out }
  }
}

export function renderMarkdown(prompt, reply, meta, plain) {
  const body = String(reply || '').trim()
  if (plain) return `${body}\n`
  const head = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `---\n${head}\ntool: gpt (DSH Browser Control bridge -> chatgpt.com)\n---\n\n# ChatGPT 对话记录\n\n## 提问\n\n${String(prompt || '').trim()}\n\n## 回复\n\n${body}\n`
}
