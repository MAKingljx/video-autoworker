const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export interface N8nEditorTarget {
  href: string | null
  canOpen: boolean
  canEmbed: boolean
  openReason: string | null
  embedReason: string | null
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(normalizedHostname(url))
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(String(raw || '').trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    if (parsed.username || parsed.password) return null
    return parsed
  } catch {
    return null
  }
}

function unavailable(reason: string): N8nEditorTarget {
  return {
    href: null,
    canOpen: false,
    canEmbed: false,
    openReason: reason,
    embedReason: reason,
  }
}

/**
 * Resolve the browser-facing n8n editor target without deriving it from the
 * request Host header or user-controlled workflow data.
 */
export function resolveN8nEditorTarget(baseUrl: string, pageUrl: string): N8nEditorTarget {
  const editor = parseHttpUrl(baseUrl)
  if (!editor) return unavailable('n8n 编辑器地址无效，只支持不含账号密码的 HTTP/HTTPS 地址。')

  const page = parseHttpUrl(pageUrl)
  if (!page) return unavailable('无法确认当前页面地址，已停用 n8n 编辑器入口。')

  editor.search = ''
  editor.hash = ''
  if (!editor.pathname.endsWith('/')) editor.pathname += '/'
  const href = editor.toString()

  if (isLoopbackUrl(editor) && !isLoopbackUrl(page)) {
    const reason = '当前页面不是通过本机回环地址访问；浏览器中的 127.0.0.1 会指向当前设备。请改用双端口 SSH 转发。'
    return {
      href,
      canOpen: false,
      canEmbed: false,
      openReason: reason,
      embedReason: reason,
    }
  }

  if (
    isLoopbackUrl(editor)
    && isLoopbackUrl(page)
    && normalizedHostname(editor) !== normalizedHostname(page)
  ) {
    return {
      href,
      canOpen: true,
      canEmbed: false,
      openReason: null,
      embedReason: '内嵌时控制台与 n8n 必须使用相同的回环主机名，以保证登录 Cookie 可用。请统一使用 127.0.0.1，或改用新窗口。',
    }
  }

  if (page.protocol === 'https:' && editor.protocol === 'http:') {
    return {
      href,
      canOpen: true,
      canEmbed: false,
      openReason: null,
      embedReason: 'HTTPS 页面不能内嵌 HTTP n8n 编辑器，请使用新窗口打开。',
    }
  }

  return {
    href,
    canOpen: true,
    canEmbed: true,
    openReason: null,
    embedReason: null,
  }
}
