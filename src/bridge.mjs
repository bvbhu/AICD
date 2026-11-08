/**
 * Minimal client for the DSH Browser Control local bridge.
 *
 * The bridge is served by @angelky7/dsh-browser-control and shared with the
 * DSH-Browser-Control Chrome extension (the same extension DSH's browser_*
 * tools use). It listens on http://127.0.0.1:<port> and exposes:
 *
 *   GET  /api/status          link state, extension version, capabilities
 *   POST /api/command         {command, params, timeoutMs?} with a bearer token
 *
 * This module deliberately imports nothing from the browser-control package:
 * only the documented HTTP face is used, so the gpt tool keeps working when
 * that plugin is upgraded, and it never loads a second browser extension.
 */

export class BridgeError extends Error {
  constructor(command, message, code = 'command_failed') {
    super(message)
    this.name = 'BridgeError'
    this.command = command
    this.code = code
  }
}

const DEFAULT_URL = 'http://127.0.0.1:9777'
const DEFAULT_TOKEN = 'dsh-local'

export class BrowserBridge {
  constructor(options = {}) {
    this.url = String(options.url || process.env.DSH_BROWSER_BRIDGE_URL || DEFAULT_URL).replace(/\/+$/, '')
    this.token = String(options.token || process.env.DSH_BROWSER_BRIDGE_TOKEN || DEFAULT_TOKEN)
    this.timeoutMs = Number(options.timeoutMs || 120000)
  }

  async #http(pathname, { method = 'GET', body, timeoutMs } = {}) {
    const controller = new AbortController()
    const budget = Math.max(1000, Number(timeoutMs || this.timeoutMs))
    const timer = setTimeout(() => controller.abort(), budget + 5000)
    try {
      const res = await fetch(this.url + pathname, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let data
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        throw new BridgeError(pathname, `桥接返回非 JSON：${text.slice(0, 300)}`)
      }
      if (!res.ok) {
        throw new BridgeError(pathname, data?.error || `桥接 HTTP ${res.status}`, data?.code || 'http_error')
      }
      return data
    } catch (error) {
      if (error instanceof BridgeError) throw error
      if (error?.name === 'AbortError') {
        throw new BridgeError(pathname, `桥接请求超时（${Math.round(budget / 1000)}s）`, 'command_timeout')
      }
      const hint = /ECONNREFUSED|fetch failed/i.test(String(error?.message || error))
        ? `无法连接 DSH Browser Control 桥接 ${this.url}：确认已安装 @angelky7/dsh-browser-control 且其在设置中启用、Chrome 扩展在线`
        : String(error?.message || error)
      throw new BridgeError(pathname, hint, 'bridge_unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  /** Link state (`extensionConnected`, `hello.version`, capabilities …). */
  async status() {
    return await this.#http('/api/status', { timeoutMs: 10000 })
  }

  /** Raw bridge command; resolves with the command's `result`. */
  async command(command, params = {}, options = {}) {
    const body = { command, params }
    if (Number.isFinite(options.timeoutMs)) body.timeoutMs = Math.trunc(options.timeoutMs)
    const data = await this.#http('/api/command', {
      method: 'POST',
      body,
      timeoutMs: Number(options.timeoutMs || this.timeoutMs),
    })
    if (!data?.ok) throw new BridgeError(command, data?.error || '桥接命令失败')
    return data.result
  }

  // ---------------------------------------------------------------- helpers

  async listTabs() {
    return await this.command('tabs.list', {})
  }

  async openTab(url, { active = false, waitUntil = 'domcontentloaded', timeoutMs = 30000, group = false } = {}) {
    const result = await this.command('tabs.open', { url, active, waitUntil, group, timeoutMs }, { timeoutMs: timeoutMs + 10000 })
    return Number(result?.tabId)
  }

  async closeTab(tabId) {
    if (!Number.isFinite(tabId)) return
    await this.command('tabs.close', { tabId })
  }

  async navigate(tabId, url, { waitUntil = 'domcontentloaded', timeoutMs = 30000 } = {}) {
    return await this.command('nav', { url, tabId, waitUntil, timeoutMs }, { timeoutMs: timeoutMs + 10000 })
  }

  async evalIn(tabId, expression, { timeoutMs = 60000 } = {}) {
    const result = await this.command('eval', { expression, tabId, timeoutMs }, { timeoutMs: timeoutMs + 5000 })
    return result?.value
  }

  async text(tabId) {
    const result = await this.command('content', { mode: 'text', tabId })
    return String(result?.content || '')
  }

  async click(tabId, selector) {
    return await this.command('click', { selector, tabId })
  }

  async press(tabId, key) {
    return await this.command('press', { key, tabId })
  }

  /** Focus an element, then insert text through CDP (ProseMirror-safe). */
  async typeInto(tabId, selector, value, { submit = false } = {}) {
    const focused = await this.evalIn(tabId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return true;
    })()`)
    if (!focused) throw new BridgeError('input', `找不到输入框 ${selector}`)
    await this.command('cdp', { method: 'Input.insertText', params: { text: value }, tabId })
    if (submit) await this.command('press', { key: 'Enter', tabId })
  }

  async cdp(tabId, method, params = {}) {
    return await this.command('cdp', { method, params, tabId })
  }

  async waitFor(tabId, fn, { timeoutMs = 30000, intervalMs = 700 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      try {
        last = await this.evalIn(tabId, fn, { timeoutMs: 20000 })
        if (last) return last
      } catch {
        /* page mid-navigation; retry */
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    return last
  }
}
