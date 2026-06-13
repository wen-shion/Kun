import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalPath, normalizePathSeparators, resolveTargetPathWithinWorkspace } from './workspace-paths'
import {
  normalizeWriteSettings,
  resolveKunRuntimeSettings,
  type AppSettingsV1,
  type WriteSettingsPatchV1
} from '../../shared/app-settings'
import {
  WRITE_PROTOTYPE_DEFAULT_PROMPT,
  WRITE_PROTOTYPE_MAX_TEXT_CHARS,
  WRITE_PROTOTYPE_MAX_TOKENS,
  WRITE_PROTOTYPE_TIMEOUT_MS,
  extractPrototypeHtmlDocument,
  type WritePrototypeRequest,
  type WritePrototypeResult
} from '../../shared/write-prototype'
import {
  buildProviderHeaders,
  buildProviderRequestBody,
  compatibleModelEndpointUrl,
  providerTextFromResponse
} from './write-inline-completion-service'

const PROTOTYPE_OUTPUT_DIR = 'proto'

export function buildWritePrototypeMessages(
  text: string,
  customPrompt = ''
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = customPrompt.trim() || WRITE_PROTOTYPE_DEFAULT_PROMPT
  return [
    { role: 'system', content: system },
    { role: 'user', content: text.trim().slice(0, WRITE_PROTOTYPE_MAX_TEXT_CHARS) }
  ]
}

/**
 * Generate a self-contained interactive HTML prototype for the selected
 * requirement text using the primary chat provider, and save it as a
 * workspace file the document can embed via image syntax.
 */
export async function requestWritePrototype(
  settings: AppSettingsV1,
  request: WritePrototypeRequest,
  options: { fetchFn?: typeof fetch } = {}
): Promise<WritePrototypeResult> {
  const runtime = resolveKunRuntimeSettings(settings)
  const apiKey = runtime.apiKey.trim()
  const model = runtime.model.trim()
  if (!apiKey || !model) {
    return { ok: false, message: 'chat provider is not configured' }
  }

  const text = request.text.trim()
  if (!text) return { ok: false, message: 'selection text is empty' }

  const workspaceRoot = resolve(request.workspaceRoot)
  const filePath = resolve(request.filePath)
  const relativeToRoot = relative(workspaceRoot, filePath)
  if (!relativeToRoot || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    return { ok: false, message: 'document must be inside the workspace' }
  }

  const prototypePrompt = normalizeWriteSettings(
    (settings as { write?: WriteSettingsPatchV1 }).write
  ).selectionAssist.prototypePrompt

  const endpointFormat = runtime.endpointFormat
  const url = compatibleModelEndpointUrl(runtime.baseUrl, endpointFormat)
  const body = buildProviderRequestBody({
    responseFormat: endpointFormat,
    model,
    messages: buildWritePrototypeMessages(text, prototypePrompt),
    prompt: '',
    suffix: '',
    maxTokens: WRITE_PROTOTYPE_MAX_TOKENS
  })

  const fetchFn = options.fetchFn ?? fetch
  let html: string
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: buildProviderHeaders(apiKey, endpointFormat),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WRITE_PROTOTYPE_TIMEOUT_MS)
    })
    const responseText = await response.text()
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}: ${responseText.slice(0, 600)}` }
    }
    let raw: string
    try {
      raw = providerTextFromResponse(responseText, endpointFormat)
    } catch {
      return { ok: false, message: 'prototype provider returned non-JSON data' }
    }
    const extracted = extractPrototypeHtmlDocument(raw)
    if (!extracted) {
      return { ok: false, message: 'model response did not contain a complete HTML document' }
    }
    html = extracted
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const fileName = `prototype-${stamp}-${randomBytes(2).toString('hex')}.html`
  let absolutePath: string
  let markdownPath: string
  try {
    const outputDirSetting = request.outputDir?.trim() || PROTOTYPE_OUTPUT_DIR
    const outputDir = await resolveTargetPathWithinWorkspace(outputDirSetting, workspaceRoot)
    await mkdir(outputDir, { recursive: true })
    absolutePath = join(outputDir, fileName)
    await writeFile(absolutePath, html, 'utf8')
    // outputDir is canonicalized (symlinks resolved), so derive the document
    // directory from the same canonical root to keep the relative link clean.
    const canonicalRoot = await canonicalPath(workspaceRoot)
    const documentDir = join(canonicalRoot, dirname(relativeToRoot))
    markdownPath = normalizePathSeparators(relative(documentDir, absolutePath))
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  return {
    ok: true,
    relativePath: markdownPath,
    absolutePath,
    fileName
  }
}
