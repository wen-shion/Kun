import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalPath, normalizePathSeparators, resolveTargetPathWithinWorkspace } from './workspace-paths'
import {
  normalizeWriteSettings,
  resolveKunImageGenerationSettings,
  type AppSettingsV1,
  type KunImageGenerationSettingsV1,
  type WriteSettingsPatchV1
} from '../../shared/app-settings'
import {
  WRITE_DESIGN_DRAFT_DEFAULT_PROMPT,
  WRITE_INFOGRAPHIC_DEFAULT_PROMPT,
  WRITE_INFOGRAPHIC_MAX_TEXT_CHARS,
  type WriteInfographicKind,
  type WriteInfographicRequest,
  type WriteInfographicResult
} from '../../shared/write-infographic'
import {
  mapImageSize,
  createImageGenClient,
  type ImageGenClient
} from '../../../kun/src/adapters/tool/image-gen-tool-provider.js'

// Matches WORKSPACE_IMAGE_DIR in workspace-files.ts so infographics land in
// the same workspace-level folder as pasted images.
const INFOGRAPHIC_IMAGE_DIR = 'img'
const IMAGE_SIZE_TIER = '1K'
// Portrait reads best for infographics (768x1024); design mockups read best
// in landscape (1024x768). An explicit defaultSize setting overrides both.
const KIND_ASPECT_RATIO: Record<WriteInfographicKind, string> = {
  infographic: '3:4',
  design: '4:3'
}
const KIND_FILE_PREFIX: Record<WriteInfographicKind, string> = {
  infographic: 'infographic',
  design: 'design'
}
const KIND_DEFAULT_PROMPT: Record<WriteInfographicKind, string> = {
  infographic: WRITE_INFOGRAPHIC_DEFAULT_PROMPT,
  design: WRITE_DESIGN_DRAFT_DEFAULT_PROMPT
}

export function isWriteInfographicConfigured(
  imageGeneration: Pick<KunImageGenerationSettingsV1, 'enabled' | 'baseUrl' | 'apiKey' | 'model'>
): boolean {
  return (
    imageGeneration.enabled &&
    Boolean(imageGeneration.baseUrl.trim()) &&
    Boolean(imageGeneration.apiKey.trim()) &&
    Boolean(imageGeneration.model.trim())
  )
}

export function buildWriteInfographicPrompt(
  text: string,
  customPrompt = '',
  kind: WriteInfographicKind = 'infographic'
): string {
  const clipped = text.trim().slice(0, WRITE_INFOGRAPHIC_MAX_TEXT_CHARS)
  const prefix = customPrompt.trim() || KIND_DEFAULT_PROMPT[kind]
  return `${prefix}\n\n${clipped}`
}

export async function requestWriteInfographic(
  settings: AppSettingsV1,
  request: WriteInfographicRequest,
  options: { client?: ImageGenClient } = {}
): Promise<WriteInfographicResult> {
  const imageGeneration = resolveKunImageGenerationSettings(settings)
  if (!isWriteInfographicConfigured(imageGeneration)) {
    return { ok: false, message: 'image generation provider is not configured' }
  }

  const text = request.text.trim()
  if (!text) return { ok: false, message: 'selection text is empty' }

  const workspaceRoot = resolve(request.workspaceRoot)
  const filePath = resolve(request.filePath)
  const relativeToRoot = relative(workspaceRoot, filePath)
  if (!relativeToRoot || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    return { ok: false, message: 'document must be inside the write workspace' }
  }

  const kind: WriteInfographicKind = request.kind ?? 'infographic'
  const client = options.client ?? createImageGenClient(imageGeneration)
  // An explicit defaultSize wins: users set it when their provider only
  // accepts fixed sizes (e.g. gpt-image's 1024x1536). Otherwise use an
  // aspect ratio that suits the image kind.
  const size = imageGeneration.defaultSize.trim() ||
    mapImageSize(KIND_ASPECT_RATIO[kind], IMAGE_SIZE_TIER, undefined)

  const selectionAssist = normalizeWriteSettings(
    (settings as { write?: WriteSettingsPatchV1 }).write
  ).selectionAssist
  const customPrompt = kind === 'design'
    ? selectionAssist.designDraftPrompt
    : selectionAssist.infographicPrompt

  let image: { data: Buffer; mimeType: string }
  try {
    image = await client.generate({
      prompt: buildWriteInfographicPrompt(text, customPrompt, kind),
      model: imageGeneration.model.trim(),
      ...(size && size !== 'auto' ? { size } : {}),
      timeoutMs: imageGeneration.timeoutMs,
      signal: AbortSignal.timeout(imageGeneration.timeoutMs)
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  const ext = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png'
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const fileName = `${KIND_FILE_PREFIX[kind]}-${stamp}-${randomBytes(2).toString('hex')}.${ext}`
  let absolutePath: string
  let markdownPath: string
  try {
    const imageDirSetting = request.imageDir?.trim() || INFOGRAPHIC_IMAGE_DIR
    const imageDir = await resolveTargetPathWithinWorkspace(imageDirSetting, workspaceRoot)
    await mkdir(imageDir, { recursive: true })
    absolutePath = join(imageDir, fileName)
    await writeFile(absolutePath, image.data)
    // imageDir is canonicalized (symlinks resolved), so derive the document
    // directory from the same canonical root to keep the relative link clean.
    // dirname(imageDir) only equals the root for single-segment dirs, so
    // canonicalize the root itself (covers nested dirs like '.kunsdd/img').
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
