import { isExplicitWriteResourceUrl } from './write-markdown-resource'

export const WRITE_PROTOTYPE_MAX_TEXT_CHARS = 6_000
/** DeepSeek defaults to 4096 output tokens, which truncates interactive
 * pages mid-markup; 8192 is the provider ceiling and fits a full document. */
export const WRITE_PROTOTYPE_MAX_TOKENS = 8_192
export const WRITE_PROTOTYPE_TIMEOUT_MS = 240_000

/**
 * Default system prompt for interactive prototype generation. Users can
 * override it via write.selectionAssist.prototypePrompt; the selected
 * requirement text is sent as the user message either way.
 */
export const WRITE_PROTOTYPE_DEFAULT_PROMPT = [
  'You build single-file interactive HTML prototypes for product requirements.',
  'Return ONE complete standalone HTML document and nothing else: no explanations, no markdown fences.',
  'All CSS and JavaScript must be inline in the document; never reference local files.',
  'Make the prototype clickable and stateful where the requirement implies interaction (tabs, forms, lists, dialogs).',
  'Use a clean modern flat design with a light background, and keep every piece of interface text in the same language as the requirement.',
  'The page must render correctly inside a 480px-tall embedded frame and scale to wider viewports.'
].join(' ')

export type WritePrototypeRequest = {
  /** Selected requirement text the prototype should implement. */
  text: string
  /** Absolute path of the markdown document that will embed the prototype. */
  filePath: string
  /** Workspace root the prototype file is written under. */
  workspaceRoot: string
  /** Workspace-relative output directory (default 'proto'); SDD passes '.kunsdd/proto'. */
  outputDir?: string
}

export type WritePrototypeResult =
  | {
      ok: true
      /** Path relative to the document directory, ready for a markdown image link. */
      relativePath: string
      absolutePath: string
      fileName: string
    }
  | {
      ok: false
      message: string
    }

/**
 * Extract the HTML document from a raw model response: strips markdown
 * fences and any think-style preamble by slicing from the first
 * `<!doctype`/`<html` to the last `</html>`. Returns null when no complete
 * document is present (truncated or non-HTML output).
 */
export function extractPrototypeHtmlDocument(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const lower = text.toLowerCase()
  const doctypeAt = lower.indexOf('<!doctype')
  const htmlAt = lower.indexOf('<html')
  const start = doctypeAt >= 0 && (htmlAt < 0 || doctypeAt < htmlAt) ? doctypeAt : htmlAt
  if (start < 0) return null
  const end = lower.lastIndexOf('</html>')
  if (end < 0 || end < start) return null
  return text.slice(start, end + '</html>'.length)
}

/** Whether an image src points at a local HTML document to embed inline. */
export function isHtmlEmbedSrc(src: string | undefined): boolean {
  if (!src) return false
  const value = src.trim()
  if (!value || isExplicitWriteResourceUrl(value) || value.startsWith('#')) return false
  if (/[?#]/.test(value)) return false
  return /\.html?$/i.test(value)
}
