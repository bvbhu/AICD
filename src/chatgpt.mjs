/**
 * ChatGPT web driver built on the DSH Browser Control bridge.
 *
 * Everything happens in a dedicated, inactive tab that is closed when the call
 * finishes, so the user's own tabs are untouched. Replies are read from the
 * conversation record API (`/backend-api/conversation/<id>`), not scraped from
 * the DOM, which keeps Markdown (tables, code fences, bold) byte-faithful.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const CHAT_URL = 'https://chatgpt.com/'
const CONV_URL = (id) => `https://chatgpt.com/c/${id}`
const CONV_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
// UI component markers that leak into content.parts, e.g. "<MemoryCite />"
const ARTIFACT_RE = /<[A-Za-z][\w:.-]*(?:\s[^<>]{0,200})?\/>/g

const COMPOSER = 'form div[contenteditable="true"]'
// ChatGPT can keep a hidden, zero-width composer beside the visible one; always
// drive the visible element.
const PICK_COMPOSER = `(() => {
  const list = [...document.querySelectorAll(${JSON.stringify(COMPOSER)})];
  return list.find((el) => el.getBoundingClientRect().width > 0) || list[0] || null;
})()`
const COMPOSER_READY = `!!(${PICK_COMPOSER})`

export class WebError extends Error {
  constructor(message, code = 'web_error') {
    super(message)
    this.name = 'WebError'
    this.code = code
  }
}

export function cleanMarkdown(text) {
  return String(text || '')
    .replace(ARTIFACT_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeConversationId(value) {
  const text = String(value || '').trim()
  if (!text) throw new WebError('conversation id 为空')
  const match = CONV_RE.exec(text)
  if (!match) throw new WebError(`无法从 ${JSON.stringify(value)} 解析 conversation id`)
  return match[1]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function throwIfAborted(signal) {
  if (signal?.aborted) throw new WebError('已取消', 'cancelled')
}

const progress = (onProgress, message) => {
  try {
    onProgress?.(message)
  } catch {
    /* caller progress must never break the run */
  }
}

async function ensureLoggedInComposer(bridge, tabId, timeoutMs = 60000, signal) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      last = await bridge.evalIn(
        tabId,
        `(() => {
          const composer = ${PICK_COMPOSER};
          if (composer) return { ready: true, path: location.pathname, title: document.title };
          const body = document.body ? document.body.innerText.slice(0, 400) : '';
          return { ready: false, path: location.pathname, title: document.title, body };
        })()`,
        { timeoutMs: 20000 },
      )
      if (last?.ready) return last
      if (/\/auth\/login|log in|登录|Sign in/i.test(`${last?.path} ${last?.body}`) && !/chatgpt\.com\/?$/.test(last?.path || '')) {
        throw new WebError('未登录 ChatGPT：请在 Chrome 里打开 chatgpt.com 并登录', 'not_logged_in')
      }
    } catch (error) {
      if (error instanceof WebError) throw error
    }
    await sleep(1000)
  }
  throw new WebError(
    `ChatGPT 输入框未出现（${Math.round(timeoutMs / 1000)}s）：页面未加载完成，或当前 Chrome profile 未登录 chatgpt.com`,
    'composer_missing',
  )
}

async function clearComposer(bridge, tabId) {
  return await bridge.evalIn(
    tabId,
    `(() => {
      const el = ${PICK_COMPOSER};
      if (!el) return false;
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      return el.innerText.trim().length === 0;
    })()`,
  )
}

async function typePrompt(bridge, tabId, text) {
  const focused = await bridge.evalIn(
    tabId,
    `(() => {
      const el = ${PICK_COMPOSER};
      if (!el) return false;
      el.focus();
      return document.activeElement === el || el.contains(document.activeElement);
    })()`,
  )
  if (!focused) throw new WebError('无法聚焦 ChatGPT 输入框', 'composer_focus')
  await bridge.cdp(tabId, 'Input.insertText', { text })
  const typed = await bridge.evalIn(tabId, `(${PICK_COMPOSER})?.innerText || ''`)
  if (!String(typed || '').trim()) throw new WebError('输入框内容为空（CDP 输入失败）', 'input_failed')
  return typed
}

async function clickSend(bridge, tabId) {
  const result = await bridge.evalIn(
    tabId,
    `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const send = buttons.filter((x) => {
        const label = (x.getAttribute('aria-label') || '').trim();
        return label === '发送' || label === 'Send' || label === 'Send message'
          || x.getAttribute('data-testid') === 'send-button' || x.id === 'composer-submit-button';
      });
      if (send.length === 0) return 'no-send';
      const clickable = send.find((x) => !x.disabled && x.getBoundingClientRect().width > 0)
        || send.find((x) => !x.disabled);
      if (!clickable) return 'disabled';
      clickable.click();
      return 'sent';
    })()`,
  )
  if (result !== 'sent') throw new WebError(`发送失败（${result}）：发送按钮不可用`, 'send_failed')
}

async function currentConversation(bridge, tabId) {
  return await bridge.evalIn(
    tabId,
    `(() => {
      const m = location.pathname.match(/\\/c\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return { id: m ? m[1] : '', path: location.pathname, title: document.title };
    })()`,
  )
}

/** Pick an already-open chatgpt.com tab so tools can reuse the user's session. */
export async function findChatTab(bridge) {
  const tabs = await bridge.listTabs().catch(() => null)
  const list = tabs?.tabs || []
  return list.find((tab) => /^https:\/\/chatgpt\.com\//i.test(tab.url || ''))?.id || 0
}

/** Bring a reused tab to a fresh chat (or the requested conversation). */
async function prepareConversationTab(bridge, tabId, conversation, signal) {
  throwIfAborted(signal)
  if (conversation) {
    const current = await currentConversation(bridge, tabId)
    if (current.id !== conversation) {
      await bridge.navigate(tabId, CONV_URL(conversation), { waitUntil: 'domcontentloaded', timeoutMs: 30000 })
    }
    return
  }
  const current = await currentConversation(bridge, tabId).catch(() => null)
  if (!current || current.id || current.path !== '/') {
    const clicked = await bridge.evalIn(
      tabId,
      `(() => {
        const btn = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '新聊天' && x.getBoundingClientRect().width > 0);
        if (!btn) return 'no';
        btn.click();
        return 'clicked';
      })()`,
    ).catch(() => 'no')
    if (clicked !== 'clicked') {
      await bridge.navigate(tabId, CHAT_URL, { waitUntil: 'domcontentloaded', timeoutMs: 30000 })
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const state = await currentConversation(bridge, tabId).catch(() => null)
      if (state && !state.id && state.path === '/') return
      await sleep(500)
    }
  }
}

function conversationStateExpr(id) {
  return `(async () => {
    const id = ${JSON.stringify(id)};
    const session = await fetch('/api/auth/session').then((r) => r.json()).catch(() => ({}));
    const token = session.accessToken || '';
    const res = await fetch('/backend-api/conversation/' + id, { headers: { authorization: 'Bearer ' + token } });
    if (!res.ok) return { ok: false, error: 'http_' + res.status };
    const data = await res.json();
    const nodes = Object.values(data.mapping || {}).filter((n) => n && n.message && n.message.author);
    nodes.sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
    const assistants = nodes.filter((n) => n.message.author.role === 'assistant' && n.message.content);
    const last = assistants[assistants.length - 1];
    const parts = (last && last.message.content && last.message.content.parts) || [];
    const text = parts.filter((p) => typeof p === 'string').join('');
    const images = [];
    for (const node of nodes) {
      const role = node.message.author.role;
      // Only assistant/tool images count; a user upload is not a generated image.
      if (role === 'user') continue;
      const content = node.message.content || {};
      for (const part of content.parts || []) {
        if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer' && part.asset_pointer) {
          images.push({ pointer: part.asset_pointer, width: part.width || 0, height: part.height || 0 });
        }
      }
    }
    return {
      ok: true,
      title: data.title || '',
      count: nodes.length,
      assistants: assistants.length,
      images,
      lastText: text,
      last: last ? {
        status: last.message.status || '',
        end: !!last.message.end_turn,
        ct: (last.message.content && last.message.content.content_type) || '',
        len: text.length
      } : null
    };
  })()`
}

async function readState(bridge, tabId, id) {
  const raw = await bridge.evalIn(tabId, conversationStateExpr(id), { timeoutMs: 30000 })
  if (!raw?.ok) throw new WebError(`读取会话记录失败：${raw?.error || '未知错误'}`, 'conversation_read')
  return raw
}

async function readReplyText(bridge, tabId, id) {
  const raw = await bridge.evalIn(
    tabId,
    `(async () => {
      const session = await fetch('/api/auth/session').then((r) => r.json()).catch(() => ({}));
      const token = session.accessToken || '';
      const res = await fetch('/backend-api/conversation/' + ${JSON.stringify(id)}, { headers: { authorization: 'Bearer ' + token } });
      if (!res.ok) return { ok: false, error: 'http_' + res.status };
      const data = await res.json();
      const nodes = Object.values(data.mapping || {}).filter((n) => n && n.message && n.message.author);
      nodes.sort((a, b) => (a.message.create_time || 0) - (b.message.create_time || 0));
      const assistants = nodes.filter((n) => n.message.author.role === 'assistant' && n.message.content);
      const last = assistants[assistants.length - 1];
      const parts = (last && last.message.content && last.message.content.parts) || [];
      return { ok: true, text: parts.filter((p) => typeof p === 'string').join('') };
    })()`,
    { timeoutMs: 30000 },
  )
  if (!raw?.ok) throw new WebError(`读取回复失败：${raw?.error || '未知错误'}`, 'conversation_read')
  return raw.text || ''
}

async function waitForConversationId(bridge, tabId, timeoutMs = 90000, signal) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    const current = await currentConversation(bridge, tabId).catch(() => null)
    if (current?.id) return current.id
    await sleep(1000)
  }
  return ''
}

/** Send one prompt in a fresh or existing conversation. */
export async function sendPrompt({ bridge, prompt, conversation, timeoutSec = 300, onProgress, signal, tabId, reuseExistingTab = true }) {
  throwIfAborted(signal)
  const timeoutMs = Math.max(30, Number(timeoutSec) || 300) * 1000
  const existingId = conversation ? normalizeConversationId(conversation) : ''
  const reused = tabId || (reuseExistingTab ? await findChatTab(bridge) : 0)
  const targetTab = reused || await bridge.openTab(existingId ? CONV_URL(existingId) : CHAT_URL, {
    active: false,
    waitUntil: 'domcontentloaded',
    timeoutMs: 30000,
  })
  const owned = !reused
  const tabIdResolved = targetTab
  let closed = false
  const onAbort = () => {
    bridge.closeTab(tabIdResolved).catch(() => {})
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    if (reused) await prepareConversationTab(bridge, tabIdResolved, existingId, signal)
    await ensureLoggedInComposer(bridge, tabIdResolved, 60000, signal)
    throwIfAborted(signal)
    let before = null
    if (existingId) {
      before = await readState(bridge, tabIdResolved, existingId)
      progress(onProgress, `挂载会话 ${existingId}（已有 ${before.count} 条消息）`)
    }

    await clearComposer(bridge, tabIdResolved)
    await typePrompt(bridge, tabIdResolved, prompt)
    progress(onProgress, `发送到 ChatGPT 网页（timeout=${Math.round(timeoutMs / 1000)}s）…`)
    await clickSend(bridge, tabIdResolved)

    const id = existingId || (await waitForConversationId(bridge, tabIdResolved, 90000, signal))
    if (!id) throw new WebError('发送后没有拿到 conversation id：页面没有进入会话页', 'no_conversation_id')
    if (!existingId) progress(onProgress, `新会话 ${id}`)

    const deadline = Date.now() + timeoutMs
    await sleep(1500)
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const state = await readState(bridge, tabIdResolved, id).catch(() => null)
      if (state) {
        const last = state.last
        const started = existingId ? state.assistants > before.assistants : state.count > 0
        if (started && last?.end && last.status === 'finished_successfully' && last.len > 0) {
          const text = await readReplyText(bridge, tabIdResolved, id)
          if (!text.trim()) throw new WebError('回复为空', 'empty_reply')
          return {
            conversation_id: id,
            title: state.title,
            text: cleanMarkdown(text),
            turns: existingId ? Math.max(state.count - before.count, 0) / 2 : 1,
          }
        }
      }
      await sleep(2000)
    }
    throw new WebError(
      `等待回复超时（${Math.round(timeoutMs / 1000)}s）：生成未在时限内完成，或消息没有提交`,
      'timeout',
    )
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    if (!closed && owned) {
      closed = true
      await bridge.closeTab(tabIdResolved).catch(() => {})
    }
  }
}

/** Create a new conversation and generate one image; returns the saved page image URLs. */
export async function generateImage({ bridge, prompt, refs = [], timeoutSec = 300, onProgress, out, signal, tabId, reuseExistingTab = true }) {
  throwIfAborted(signal)
  const timeoutMs = Math.max(30, Number(timeoutSec) || 300) * 1000
  const reused = tabId || (reuseExistingTab ? await findChatTab(bridge) : 0)
  const tabIdResolved = reused || await bridge.openTab(CHAT_URL, { active: false, waitUntil: 'domcontentloaded', timeoutMs: 30000 })
  const owned = !reused
  let closed = false
  const onAbort = () => {
    bridge.closeTab(tabIdResolved).catch(() => {})
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  try {
    if (reused) await prepareConversationTab(bridge, tabIdResolved, '', signal)
    await ensureLoggedInComposer(bridge, tabIdResolved, 60000, signal)
    throwIfAborted(signal)
    // Clear FIRST: select-all + delete in the composer would also wipe an
    // attachment chip, so attachments are added only after the box is empty.
    await clearComposer(bridge, tabIdResolved)
    if (refs.length > 0) {
      await attachFiles(bridge, tabIdResolved, refs)
      progress(onProgress, `已附加 ${refs.length} 张参考图`)
    }
    await typePrompt(bridge, tabIdResolved, prompt)
    progress(onProgress, `发送生图请求（timeout=${Math.round(timeoutMs / 1000)}s）…`)
    await clickSend(bridge, tabIdResolved)

    const id = await waitForConversationId(bridge, tabIdResolved, 90000, signal)
    if (!id) throw new WebError('发送后没有拿到 conversation id：页面没有进入会话页', 'no_conversation_id')
    progress(onProgress, `新会话 ${id}`)

    const deadline = Date.now() + timeoutMs
    let textSeenAt = 0
    await sleep(2000)
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const state = await readState(bridge, tabIdResolved, id).catch(() => null)
      if (state) {
        if (state.images.length > 0) {
          // ChatGPT virtualises the transcript: scroll to the newest turn so the
          // <img> exists, then retry for a few seconds while it lazy-loads.
          const renderDeadline = Date.now() + 15000
          let images = []
          while (Date.now() < renderDeadline) {
            await bridge.evalIn(tabIdResolved, `window.scrollTo(0, document.body.scrollHeight)`, { timeoutMs: 10000 }).catch(() => {})
            await sleep(800)
            images = await collectRenderedImages(bridge, tabIdResolved)
            if (images.length > 0) break
          }
          if (images.length > 0) {
            const chosen = images.sort((a, b) => b.width * b.height - a.width * a.height)[0]
            const saved = await saveImageBytes(bridge, tabIdResolved, chosen.src, out)
            return { conversation_id: id, title: state.title, path: saved.path, width: chosen.width, height: chosen.height, source: chosen.src }
          }
        }
        const last = state.last
        if (last?.end && state.lastText) {
          if (/上限|额度|无法|不能|cannot|quota|limit|not available|unavailable|not able/i.test(state.lastText)) {
            throw new WebError(`ChatGPT 未生成图片：${state.lastText.slice(0, 400)}`, 'image_refused')
          }
          textSeenAt ||= Date.now()
          if (Date.now() - textSeenAt > 20000) {
            throw new WebError(`ChatGPT 没有返回图片：${state.lastText.slice(0, 400)}`, 'no_image')
          }
        }
      }
      await sleep(2000)
    }
    throw new WebError(
      `等待出图超时（${Math.round(timeoutMs / 1000)}s）：网页没有在时限内返回图片`,
      'timeout',
    )
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
    if (!closed && owned) {
      closed = true
      await bridge.closeTab(tabIdResolved).catch(() => {})
    }
  }
}

async function imageBytes(bridge, tabId, src) {
  if (/^https?:/i.test(src)) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(90000) })
      if (res.ok) {
        const type = res.headers.get('content-type') || ''
        if (type.startsWith('image/') || type === 'application/octet-stream') {
          return Buffer.from(await res.arrayBuffer())
        }
      }
    } catch {
      /* fall through to the page-side fetch */
    }
  }
  if (/^blob:/i.test(src)) {
    const base64 = await bridge.evalIn(
      tabId,
      `(async () => {
        const res = await fetch(${JSON.stringify(src)});
        const blob = await res.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      })()`,
      { timeoutMs: 120000 },
    )
    return Buffer.from(String(base64 || ''), 'base64')
  }
  return null
}

async function saveImageBytes(bridge, tabId, src, out) {
  if (!out) throw new WebError('缺少输出路径', 'missing_out')
  const bytes = await imageBytes(bridge, tabId, src)
  if (!bytes?.length) throw new WebError(`图片下载失败（${String(src).slice(0, 80)}）`, 'image_download')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, bytes)
  return { path: out, bytes: bytes.length }
}

async function attachFiles(bridge, tabId, files) {
  const root = await bridge.cdp(tabId, 'DOM.getDocument', { depth: 0 })
  const rootId = root?.root?.nodeId
  if (!rootId) throw new WebError('无法读取 DOM（DOM.getDocument 失败）', 'dom_unavailable')
  const queried = await bridge.cdp(tabId, 'DOM.querySelector', { nodeId: rootId, selector: 'input[type=file]' })
  const nodeId = queried?.nodeId
  if (!nodeId) throw new WebError('页面没有文件上传入口，无法附加参考图', 'no_file_input')
  await bridge.cdp(tabId, 'DOM.setFileInputFiles', { nodeId, files })
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const count = await bridge.evalIn(tabId, `document.querySelectorAll('form img').length`)
    if (Number(count) >= files.length) return
    await sleep(1000)
  }
  throw new WebError('参考图上传超时（未出现缩略图）', 'upload_timeout')
}

async function collectRenderedImages(bridge, tabId) {
  return await bridge.evalIn(
    tabId,
    `(() => {
      const all = [...document.querySelectorAll('main img')]
        .map((img) => ({ src: img.currentSrc || img.src || '', alt: img.alt || '', width: img.naturalWidth || 0, height: img.naturalHeight || 0 }))
        .filter((x) => x.src && !x.src.startsWith('data:') && !/avatar|logo/i.test(x.alt) && x.width >= 256);
      const generated = all.filter((x) => /已生成图像|generated image|image generated/i.test(x.alt));
      if (generated.length > 0) return generated;
      return all.filter((x) => !/用户附件|uploaded|attachment|附件/i.test(x.alt));
    })()`,
  )
}
