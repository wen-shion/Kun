import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettingsV1 } from '../../shared/app-settings'
import { extractPrototypeHtmlDocument, isHtmlEmbedSrc } from '../../shared/write-prototype'
import { requestWritePrototype } from './write-prototype-service'

let workspace: string

const SAMPLE_HTML = '<!doctype html><html><head><title>x</title></head><body><button>点我</button></body></html>'

function settingsWithChatProvider(overrides: Record<string, unknown> = {}): AppSettingsV1 {
  return {
    provider: {
      apiKey: 'sk-chat',
      baseUrl: 'https://api.chat.test',
      providers: []
    },
    agents: {
      kun: {
        model: 'test-chat-model',
        ...overrides
      }
    }
  } as unknown as AppSettingsV1
}

function fakeFetch(content: string, status = 200): { fetchFn: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchFn = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    })
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status, headers: { 'Content-Type': 'application/json' } }
    )
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('extractPrototypeHtmlDocument', () => {
  it('strips markdown fences and preambles around the document', () => {
    expect(extractPrototypeHtmlDocument('```html\n' + SAMPLE_HTML + '\n```')).toBe(SAMPLE_HTML)
    expect(extractPrototypeHtmlDocument(`好的，这是原型：\n\n${SAMPLE_HTML}\n\n希望有帮助`)).toBe(SAMPLE_HTML)
  })

  it('accepts documents starting at <html> without a doctype', () => {
    const bare = '<html><body>hi</body></html>'
    expect(extractPrototypeHtmlDocument(bare)).toBe(bare)
  })

  it('returns null for truncated or non-HTML output', () => {
    expect(extractPrototypeHtmlDocument('<!doctype html><html><body>cut off')).toBeNull()
    expect(extractPrototypeHtmlDocument('这是一段说明文字，没有页面。')).toBeNull()
    expect(extractPrototypeHtmlDocument('')).toBeNull()
  })
})

describe('isHtmlEmbedSrc', () => {
  it('matches local html paths only', () => {
    expect(isHtmlEmbedSrc('../../proto/page.html')).toBe(true)
    expect(isHtmlEmbedSrc('proto/page.htm')).toBe(true)
    expect(isHtmlEmbedSrc('img/photo.png')).toBe(false)
    expect(isHtmlEmbedSrc('https://example.com/page.html')).toBe(false)
    expect(isHtmlEmbedSrc('kun-pending-infographic://abc')).toBe(false)
    expect(isHtmlEmbedSrc('proto/page.html?x=1')).toBe(false)
    expect(isHtmlEmbedSrc('#anchor.html')).toBe(false)
    expect(isHtmlEmbedSrc(undefined)).toBe(false)
  })
})

describe('write prototype service', () => {
  beforeEach(() => {
    // realpath: macOS tmpdir lives behind a /var -> /private/var symlink and
    // the service canonicalizes workspace paths the same way.
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'write-prototype-')))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('rejects when the chat provider is not configured', async () => {
    const settings = {
      provider: { apiKey: '', baseUrl: '', providers: [] },
      agents: { kun: { model: '' } }
    } as unknown as AppSettingsV1
    const result = await requestWritePrototype(settings, {
      text: '需求',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('not configured') })
  })

  it('rejects documents outside the workspace', async () => {
    const { fetchFn } = fakeFetch(SAMPLE_HTML)
    const result = await requestWritePrototype(settingsWithChatProvider(), {
      text: '需求',
      filePath: '/tmp/elsewhere/doc.md',
      workspaceRoot: workspace
    }, { fetchFn })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('inside the workspace') })
  })

  it('writes the prototype into the output dir and returns a markdown-ready path', async () => {
    const { fetchFn, calls } = fakeFetch('```html\n' + SAMPLE_HTML + '\n```')
    const result = await requestWritePrototype(settingsWithChatProvider(), {
      text: '需求：扫码登录页面。',
      filePath: join(workspace, '.kunsdd', 'draft', 'dc040c2d', 'requirement.md'),
      workspaceRoot: workspace,
      outputDir: '.kunsdd/proto'
    }, { fetchFn })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toMatch(/^\.\.\/\.\.\/proto\/prototype-\d{14}-[0-9a-f]{4}\.html$/)
    expect(result.absolutePath).toBe(join(workspace, '.kunsdd', 'proto', result.fileName))
    expect(existsSync(result.absolutePath)).toBe(true)
    expect(readFileSync(result.absolutePath, 'utf8')).toBe(SAMPLE_HTML)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.chat.test/v1/chat/completions')
    expect(calls[0].body.model).toBe('test-chat-model')
    expect(calls[0].body.max_tokens).toBe(8192)
    const messages = calls[0].body.messages as Array<{ role: string; content: string }>
    expect(messages[0].role).toBe('system')
    expect(messages[1]).toMatchObject({ role: 'user', content: '需求：扫码登录页面。' })
  })

  it('defaults to the proto output dir for non-SDD documents', async () => {
    const { fetchFn } = fakeFetch(SAMPLE_HTML)
    const result = await requestWritePrototype(settingsWithChatProvider(), {
      text: 'root document',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { fetchFn })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toMatch(/^proto\/prototype-\d{14}-[0-9a-f]{4}\.html$/)
  })

  it('uses the custom selectionAssist.prototypePrompt as the system message', async () => {
    const { fetchFn, calls } = fakeFetch(SAMPLE_HTML)
    const settings = {
      ...settingsWithChatProvider(),
      write: {
        selectionAssist: {
          prototypePrompt: '永远输出暗色主题的原型。',
          quickActions: []
        }
      }
    } as unknown as AppSettingsV1
    const result = await requestWritePrototype(settings, {
      text: '需求',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { fetchFn })

    expect(result.ok).toBe(true)
    const messages = calls[0].body.messages as Array<{ role: string; content: string }>
    expect(messages[0].content).toBe('永远输出暗色主题的原型。')
  })

  it('fails clearly when the model returns no complete HTML document', async () => {
    const { fetchFn } = fakeFetch('抱歉，我只能描述这个页面长什么样。')
    const result = await requestWritePrototype(settingsWithChatProvider(), {
      text: '需求',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { fetchFn })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('HTML document') })
  })

  it('surfaces provider HTTP failures with the status code', async () => {
    const { fetchFn } = fakeFetch('irrelevant', 500)
    const result = await requestWritePrototype(settingsWithChatProvider(), {
      text: '需求',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { fetchFn })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 500') })
  })

  it('rejects an outputDir that escapes the workspace', async () => {
    const { fetchFn } = fakeFetch(SAMPLE_HTML)
    const result = await requestWritePrototype(settingsWithChatProvider(), {
      text: '需求',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace,
      outputDir: '../outside'
    }, { fetchFn })
    expect(result.ok).toBe(false)
    expect(existsSync(join(workspace, '..', 'outside'))).toBe(false)
  })
})
