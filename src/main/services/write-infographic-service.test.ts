import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSettingsV1 } from '../../shared/app-settings'
import type { ImageGenClient, ImageGenRequest } from '../../../kun/src/adapters/tool/image-gen-tool-provider.js'
import { buildWriteInfographicPrompt, requestWriteInfographic } from './write-infographic-service'

let workspace: string

function settingsWithImageGen(overrides: Record<string, unknown> = {}): AppSettingsV1 {
  return {
    agents: {
      kun: {
        imageGeneration: {
          enabled: true,
          baseUrl: 'https://images.example.test/v1',
          apiKey: 'sk-image',
          model: 'test-image-model',
          defaultSize: '',
          timeoutMs: 180000,
          ...overrides
        }
      }
    }
  } as unknown as AppSettingsV1
}

function fakeClient(): ImageGenClient & { requests: ImageGenRequest[] } {
  const requests: ImageGenRequest[] = []
  return {
    id: 'fake',
    requests,
    async generate(request) {
      requests.push(request)
      return { data: Buffer.from('fake-png-bytes'), mimeType: 'image/png' }
    },
    async edit() {
      throw new Error('not used')
    }
  }
}

describe('write infographic service', () => {
  beforeEach(() => {
    // realpath: macOS tmpdir lives behind a /var -> /private/var symlink and
    // the service canonicalizes workspace paths the same way.
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'write-infographic-')))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('rejects when the image provider is not configured', async () => {
    const result = await requestWriteInfographic(settingsWithImageGen({ apiKey: '' }), {
      text: 'some text',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('not configured') })
  })

  it('rejects documents outside the write workspace', async () => {
    const result = await requestWriteInfographic(settingsWithImageGen(), {
      text: 'some text',
      filePath: '/tmp/elsewhere/doc.md',
      workspaceRoot: workspace
    }, { client: fakeClient() })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('inside the write workspace') })
  })

  it('saves the infographic into the workspace img folder and returns a markdown-ready path', async () => {
    const client = fakeClient()
    const result = await requestWriteInfographic(settingsWithImageGen(), {
      text: '季度营收增长 25%，主要来自海外市场。',
      filePath: join(workspace, 'notes', 'report.md'),
      workspaceRoot: workspace
    }, { client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toMatch(/^\.\.\/img\/infographic-\d{14}-[0-9a-f]{4}\.png$/)
    expect(result.absolutePath).toBe(join(workspace, 'img', result.fileName))
    expect(existsSync(result.absolutePath)).toBe(true)
    expect(readFileSync(result.absolutePath, 'utf8')).toBe('fake-png-bytes')

    expect(client.requests).toHaveLength(1)
    expect(client.requests[0].model).toBe('test-image-model')
    expect(client.requests[0].size).toBe('768x1024')
    expect(client.requests[0].prompt).toContain('季度营收增长 25%')
    expect(client.requests[0].prompt).toContain('infographic')
  })

  it('links the image without ../ when the document sits at the workspace root', async () => {
    const client = fakeClient()
    const result = await requestWriteInfographic(settingsWithImageGen(), {
      text: 'root-level document',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toMatch(/^img\/infographic-\d{14}-[0-9a-f]{4}\.png$/)
    expect(result.absolutePath).toBe(join(workspace, 'img', result.fileName))
  })

  it('prefers an explicit defaultSize over the portrait default', async () => {
    const client = fakeClient()
    const result = await requestWriteInfographic(settingsWithImageGen({ defaultSize: '1024x1536' }), {
      text: 'fixed-size provider content',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { client })

    expect(result.ok).toBe(true)
    expect(client.requests[0].size).toBe('1024x1536')
  })

  it('surfaces provider failures as error results', async () => {
    const failingClient: ImageGenClient = {
      id: 'failing',
      async generate() {
        throw new Error('HTTP 400: unsupported size')
      },
      async edit() {
        throw new Error('not used')
      }
    }
    const result = await requestWriteInfographic(settingsWithImageGen(), {
      text: 'some text',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { client: failingClient })
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('unsupported size') })
  })

  it('clips overlong selections in the prompt', () => {
    const prompt = buildWriteInfographicPrompt('x'.repeat(10_000))
    expect(prompt.length).toBeLessThan(7_000)
  })

  it('uses a custom prompt prefix when provided', () => {
    const prompt = buildWriteInfographicPrompt('内容', '请生成手绘风格的信息图。')
    expect(prompt).toBe('请生成手绘风格的信息图。\n\n内容')
  })

  it('falls back to the default prefix for blank custom prompts', () => {
    const prompt = buildWriteInfographicPrompt('content', '   ')
    expect(prompt).toContain('infographic')
  })

  it('sends the configured write.selectionAssist.infographicPrompt to the provider', async () => {
    const client = fakeClient()
    const settings = {
      ...settingsWithImageGen(),
      write: {
        selectionAssist: {
          infographicPrompt: '用赛博朋克风格画一张信息图。',
          quickActions: []
        }
      }
    } as unknown as AppSettingsV1
    const result = await requestWriteInfographic(settings, {
      text: '季度营收增长 25%',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace
    }, { client })

    expect(result.ok).toBe(true)
    expect(client.requests[0].prompt).toBe('用赛博朋克风格画一张信息图。\n\n季度营收增长 25%')
  })

  it('writes into a nested imageDir and keeps the relative link clean', async () => {
    const client = fakeClient()
    const result = await requestWriteInfographic(settingsWithImageGen(), {
      text: '需求：支持扫码登录。',
      filePath: join(workspace, '.kunsdd', 'draft', 'dc040c2d', 'requirement.md'),
      workspaceRoot: workspace,
      imageDir: '.kunsdd/img',
      kind: 'design'
    }, { client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toMatch(/^\.\.\/\.\.\/img\/design-\d{14}-[0-9a-f]{4}\.png$/)
    expect(result.absolutePath).toBe(join(workspace, '.kunsdd', 'img', result.fileName))
    expect(existsSync(result.absolutePath)).toBe(true)
  })

  it('uses the landscape default size and design prompt for kind=design', async () => {
    const client = fakeClient()
    const result = await requestWriteInfographic(settingsWithImageGen(), {
      text: '需求内容',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace,
      kind: 'design'
    }, { client })

    expect(result.ok).toBe(true)
    expect(client.requests[0].size).toBe('1024x768')
    expect(client.requests[0].prompt).toContain('UI design mockup')
    expect(client.requests[0].prompt).not.toContain('infographic')
  })

  it('prefers write.selectionAssist.designDraftPrompt for kind=design', async () => {
    const client = fakeClient()
    const settings = {
      ...settingsWithImageGen(),
      write: {
        selectionAssist: {
          infographicPrompt: '信息图提示词不该被用到。',
          designDraftPrompt: '画一张移动端高保真设计稿。',
          quickActions: []
        }
      }
    } as unknown as AppSettingsV1
    const result = await requestWriteInfographic(settings, {
      text: '扫码登录需求',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace,
      kind: 'design'
    }, { client })

    expect(result.ok).toBe(true)
    expect(client.requests[0].prompt).toBe('画一张移动端高保真设计稿。\n\n扫码登录需求')
  })

  it('rejects an imageDir that escapes the workspace', async () => {
    const client = fakeClient()
    const result = await requestWriteInfographic(settingsWithImageGen(), {
      text: 'some text',
      filePath: join(workspace, 'doc.md'),
      workspaceRoot: workspace,
      imageDir: '../outside'
    }, { client })

    expect(result.ok).toBe(false)
    expect(existsSync(join(workspace, '..', 'outside'))).toBe(false)
  })
})
