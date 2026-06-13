import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowRight, FileText, Loader2, Save, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { SDD_IMAGE_RELATIVE_DIR, SDD_PROTO_RELATIVE_DIR } from '@shared/sdd'
import { parseSddRequirementBlocks } from '@shared/sdd-trace'
import { WRITE_INFOGRAPHIC_MAX_TEXT_CHARS, type WriteInfographicKind } from '@shared/write-infographic'
import { WRITE_PROTOTYPE_MAX_TEXT_CHARS } from '@shared/write-prototype'
import { useSddTrace } from '../../sdd/use-sdd-trace'
import { useSddDraftStore } from '../../sdd/sdd-draft-store'
import { saveActiveSddDraftToDisk, syncActiveSddDraftFromDisk } from '../../sdd/sdd-draft-actions'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { startWriteWorkspaceFileWatch } from '../../write/write-file-watch'
import {
  applyWriteInlineEditReplacement,
  buildWriteInlineEditCompletionRequest,
  buildWriteInlineEditDraft
} from '../../write/inline-edit'
import { toggleWriteInlineFormat, type WriteInlineFormatKind } from '../../write/inline-format'
import type { WriteBlockType } from '../../write/block-type'
import { createWriteRecentEdit } from '../../write/recent-edits'
import { resolveWriteQuickActions, type ResolvedWriteQuickAction } from '../../write/quick-actions'
import {
  formatWriteQuotedSelectionForPrompt,
  quotedSelectionFromEditor
} from '../../write/quoted-selection'
import {
  beginPendingInfographic,
  buildPendingInfographicMarkdown,
  finishPendingInfographic,
  lineEndAfter,
  replacePendingInfographicInText,
  type PendingInfographicKind
} from '../../write/infographic-pending'
import { WriteMarkdownEditor, type WriteMarkdownEditorHandle } from '../write/WriteMarkdownEditor'
import { WriteRichEditor, type WriteRichEditorHandle } from '../../write/tiptap/WriteRichEditor'
import { WriteInlineAgent } from '../write/WriteInlineAgent'
import {
  INLINE_EDIT_RECENT_CONTEXT_CHARS,
  inlineAgentPosition,
  WRITE_EXPORT_NOTICE_MS,
  type WriteNotice
} from '../write/write-workspace-view-utils'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'

const SDD_AUTOSAVE_MS = 650

type Props = {
  leftSidebarCollapsed: boolean
  assistantOpen: boolean
  onToggleLeftSidebar: () => void
  onToggleAssistant: () => void
  /** Quote-and-ask from the selection toolbar: opens the assistant panel with the prompt queued. */
  onAssistantQuote: (prompt: string) => void
  onNext: () => void
  onClose: () => void
  nextDisabled: boolean
}

function SddRequirementProgress({ content }: { content: string }): ReactElement | null {
  const { t } = useTranslation('common')
  const blocks = useMemo(() => parseSddRequirementBlocks(content), [content])
  if (blocks.length === 0) return null

  const counts = { verified: 0, done: 0, building: 0, planned: 0 }
  for (const block of blocks) {
    if (block.status === 'verified') counts.verified += 1
    else if (block.status === 'done') counts.done += 1
    else if (block.status === 'building') counts.building += 1
    else if (block.status === 'planned') counts.planned += 1
  }
  const total = blocks.length
  const implemented = counts.verified + counts.done

  return (
    <div className="sdd-req-progress shrink-0 px-1 pb-1 pt-2">
      <span className="text-[12px] font-semibold text-ds-muted">{t('sddReqProgressLabel')}</span>
      <div className="sdd-req-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={implemented}>
        {(['verified', 'done', 'building', 'planned'] as const).map((key) =>
          counts[key] > 0 ? (
            <span
              key={key}
              className={`sdd-req-progress-seg-${key}`}
              style={{ width: `${(counts[key] / total) * 100}%` }}
            />
          ) : null
        )}
      </div>
      <span className="text-[12px] font-medium text-ds-faint">
        {t('sddReqProgressSummary', { done: implemented, total })}
      </span>
    </div>
  )
}

function statusKey(saveStatus: string, operationStatus: string): string {
  if (operationStatus === 'upgrading') return 'sddStatusUpgrading'
  if (operationStatus === 'error' || saveStatus === 'error') return 'sddStatusError'
  if (saveStatus === 'saving') return 'sddStatusSaving'
  if (saveStatus === 'dirty') return 'sddStatusDirty'
  return 'sddStatusSaved'
}

export function SddAssistantToggleButton({
  assistantOpen,
  onToggleAssistant,
  label
}: {
  assistantOpen: boolean
  onToggleAssistant: () => void
  label: string
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggleAssistant}
      className={`ds-sidebar-toggle-button ${
        assistantOpen ? 'border-ds-border-strong bg-white/70 text-ds-ink dark:bg-white/10' : ''
      }`}
      title={label}
      aria-label={label}
      aria-pressed={assistantOpen}
    >
      <Sparkles className="h-4 w-4" strokeWidth={1.85} />
    </button>
  )
}

export function SddDraftEditorView({
  leftSidebarCollapsed,
  assistantOpen,
  onToggleLeftSidebar,
  onToggleAssistant,
  onAssistantQuote,
  onNext,
  onClose,
  nextDisabled
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const saveTimerRef = useRef<number | null>(null)
  const {
    activeDraft,
    content,
    saveStatus,
    operationStatus,
    error,
    setContent,
    setOperationStatus
  } = useSddDraftStore(
    useShallow((s) => ({
      activeDraft: s.activeDraft,
      content: s.content,
      saveStatus: s.saveStatus,
      operationStatus: s.operationStatus,
      error: s.error,
      setContent: s.setContent,
      setOperationStatus: s.setOperationStatus
    }))
  )
  const {
    inlineCompletion,
    inlineCompletionApiReady,
    selectionAssist,
    imageGenReady,
    prototypeReady,
    selection,
    recentEdits,
    loadWriteSettings,
    setSelection,
    recordRecentEdits
  } = useWriteWorkspaceStore(
    useShallow((s) => ({
      inlineCompletion: s.inlineCompletion,
      inlineCompletionApiReady: s.inlineCompletionApiReady,
      selectionAssist: s.selectionAssist,
      imageGenReady: s.imageGenReady,
      prototypeReady: s.prototypeReady,
      selection: s.selection,
      recentEdits: s.recentEdits,
      loadWriteSettings: s.loadWriteSettings,
      setSelection: s.setSelection,
      recordRecentEdits: s.recordRecentEdits
    }))
  )
  const editorPaneRef = useRef<HTMLDivElement | null>(null)
  const richHandleRef = useRef<WriteRichEditorHandle | null>(null)
  const markdownHandleRef = useRef<WriteMarkdownEditorHandle | null>(null)
  const inlineAgentTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const [inlineAgentValue, setInlineAgentValue] = useState('')
  const [inlineEditInFlight, setInlineEditInFlight] = useState(false)
  const [pointerSelecting, setPointerSelecting] = useState(false)
  const [notice, setNotice] = useState<WriteNotice | null>(null)

  useEffect(() => {
    void loadWriteSettings()
  }, [loadWriteSettings])

  // The selection slice is shared with the write workspace view (they are
  // never mounted together); clear it on both ends so neither view shows a
  // toolbar anchored to the other's stale selection.
  useEffect(() => {
    const clear = (): void =>
      useWriteWorkspaceStore.getState().setSelection({ text: '', ranges: [], charCount: 0 })
    clear()
    return clear
  }, [])

  // Hide the toolbar while a pointer drag is selecting text inside the editor;
  // it reappears on pointer release once the selection has settled.
  useEffect(() => {
    const handleDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && editorPaneRef.current?.contains(target)) {
        setPointerSelecting(true)
      }
    }
    const handleUp = (): void => setPointerSelecting(false)
    window.addEventListener('pointerdown', handleDown)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    return () => {
      window.removeEventListener('pointerdown', handleDown)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
    }
  }, [])

  // Reset the AI-edit draft whenever the selection changes; the menu input is
  // always present and must not carry stale text over.
  useEffect(() => {
    setInlineAgentValue('')
  }, [selection.charCount, selection.text])

  useEffect(() => {
    if (!notice) return
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, WRITE_EXPORT_NOTICE_MS)
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = null
      }
    }
  }, [notice])

  // Trace loop: pull live build/plan progress back into requirement statuses.
  useSddTrace({
    workspaceRoot: activeDraft?.workspaceRoot ?? '',
    draftRelativePath: activeDraft?.relativePath ?? null
  })

  useEffect(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (!activeDraft || saveStatus !== 'dirty') return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void saveActiveSddDraftToDisk()
    }, SDD_AUTOSAVE_MS)
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [activeDraft, content, saveStatus])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    void saveActiveSddDraftToDisk()
  }, [])

  const activeDraftId = activeDraft?.id
  const activeDraftWorkspaceRoot = activeDraft?.workspaceRoot
  const activeDraftRelativePath = activeDraft?.relativePath
  const activeDraftAbsolutePath = activeDraft?.absolutePath

  useEffect(() => {
    if (!activeDraftId || !activeDraftWorkspaceRoot || !activeDraftRelativePath) return
    if (
      typeof window.kunGui?.watchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.unwatchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.onWorkspaceFileChanged !== 'function'
    ) {
      return
    }

    return startWriteWorkspaceFileWatch({
      api: window.kunGui,
      workspaceRoot: activeDraftWorkspaceRoot,
      path: activeDraftAbsolutePath ?? activeDraftRelativePath,
      kind: 'text',
      onTextSnapshot: (snapshot) => {
        void syncActiveSddDraftFromDisk(snapshot)
      },
      onImageChanged: () => undefined,
      onError: (message) => {
        useSddDraftStore.getState().setSaveStatus('error', message)
      }
    })
  }, [activeDraftAbsolutePath, activeDraftId, activeDraftRelativePath, activeDraftWorkspaceRoot])

  if (!activeDraft) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[14px] text-ds-muted">
        {t('sddNoActiveDraft')}
      </div>
    )
  }

  const upgrading = operationStatus === 'upgrading'
  const readOnly = upgrading
  const statusLabel = t(statusKey(saveStatus, operationStatus))

  const draftId = activeDraft.id
  const draftWorkspaceRoot = activeDraft.workspaceRoot
  const editorFilePath = activeDraft.absolutePath ?? activeDraft.relativePath
  // The image IPC resolves relative paths against the main-process cwd, so it
  // must always receive an absolute document path.
  const docAbsolutePath =
    activeDraft.absolutePath ?? `${activeDraft.workspaceRoot}/${activeDraft.relativePath}`
  const selectionAction =
    selection.charCount > 0 && !pointerSelecting ? inlineAgentPosition(selection) : null
  // Edit-mode quick actions rewrite the document, so drop them while the doc
  // is read-only (plan generation); chat-mode actions still apply.
  const inlineQuickActions = resolveWriteQuickActions(selectionAssist.quickActions, t).filter(
    (quickAction) => quickAction.mode !== 'edit' || !readOnly
  )

  const submitToAssistant = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const quoted = quotedSelectionFromEditor(selection, editorFilePath, draftWorkspaceRoot)
    const fullPrompt = quoted
      ? `${formatWriteQuotedSelectionForPrompt(quoted)}\n\n${trimmed}`
      : trimmed
    setSelection({ text: '', ranges: [], charCount: 0 })
    setInlineAgentValue('')
    onAssistantQuote(fullPrompt)
  }

  const runQuickAction = (quickAction: ResolvedWriteQuickAction): void => {
    if (quickAction.mode === 'edit') {
      void submitInlineEdit(quickAction.prompt)
      return
    }
    submitToAssistant(quickAction.prompt)
  }

  const applyInlineFormat = (kind: WriteInlineFormatKind): void => {
    if (readOnly) return
    const richHandle = richHandleRef.current
    if (richHandle) {
      richHandle.toggleInlineFormat(kind)
      return
    }
    if (selection.ranges.length !== 1) return
    const range = selection.ranges[0]
    const replacement = toggleWriteInlineFormat(range.text, kind)
    if (replacement === null) return
    markdownHandleRef.current?.applyRangeReplacement(
      { from: range.from, to: range.to },
      range.text,
      replacement
    )
  }

  const applyBlockType = (type: WriteBlockType): void => {
    if (readOnly) return
    const richHandle = richHandleRef.current
    if (richHandle) {
      // TipTap toggle* commands already turn the active type back to paragraph.
      richHandle.setBlockType(type)
      return
    }
    // Source mode has no toggle built in: re-selecting the active type clears it.
    const effective = selection.blockType === type && type !== 'paragraph' ? 'paragraph' : type
    markdownHandleRef.current?.setBlockType(effective)
  }

  const submitInlineEdit = async (prompt: string): Promise<void> => {
    const trimmed = prompt.trim()
    if (!trimmed || readOnly || inlineEditInFlight) return
    if (selection.ranges.length !== 1) {
      setOperationStatus('error', t(
        selection.ranges.length > 1 ? 'writeInlineEditMultiSelection' : 'writeInlineEditNoSelection'
      ))
      return
    }
    if (typeof window.kunGui?.requestWriteInlineCompletion !== 'function') {
      setOperationStatus('error', t('writeInlineEditUnavailable'))
      return
    }

    // In rich mode the inline edit operates on the markdown projection: the
    // selection ranges are projection offsets and the replacement is applied
    // through the editor so undo history and node structure stay intact.
    const richHandle = richHandleRef.current
    const richProjectionText = richHandle?.getProjectionText() ?? null
    const editContent = richProjectionText ?? content

    const draft = buildWriteInlineEditDraft(editContent, selection.ranges[0], trimmed, {
      workspaceRoot: draftWorkspaceRoot,
      currentFilePath: editorFilePath,
      model: inlineCompletion.model,
      language: 'markdown',
      recentEdits
    })

    setInlineEditInFlight(true)
    try {
      const result = await window.kunGui.requestWriteInlineCompletion(
        buildWriteInlineEditCompletionRequest(draft.request)
      )
      if (!result.ok) {
        setOperationStatus('error', t('writeInlineEditFailed', { message: result.message }))
        return
      }
      const replacement = result.action?.kind === 'edit'
        ? result.action.replacement
        : result.completion

      if (richHandle) {
        const applied = richHandle.applyProjectedReplacement(
          { from: draft.scope.from, to: draft.scope.to },
          draft.scope.text,
          replacement,
          trimmed
        )
        if (!applied) {
          setOperationStatus('error', t('writeInlineEditChanged'))
          return
        }
        setSelection({ text: '', ranges: [], charCount: 0 })
        setInlineAgentValue('')
        setOperationStatus('idle')
        setNotice({ tone: 'success', message: t('writeInlineEditApplied') })
        return
      }

      const latest = useSddDraftStore.getState()
      if (
        latest.activeDraft?.id !== draftId ||
        latest.content.slice(draft.scope.from, draft.scope.to) !== draft.scope.text
      ) {
        setOperationStatus('error', t('writeInlineEditChanged'))
        return
      }

      const nextContent = applyWriteInlineEditReplacement(latest.content, draft.scope, replacement)
      const inlineEditRecord = createWriteRecentEdit({
        source: 'inline-edit',
        filePath: editorFilePath,
        from: draft.scope.from,
        to: draft.scope.to,
        deletedText: draft.scope.text,
        insertedText: replacement,
        beforeContext: latest.content.slice(
          Math.max(0, draft.scope.from - INLINE_EDIT_RECENT_CONTEXT_CHARS),
          draft.scope.from
        ),
        afterContext: nextContent.slice(
          draft.scope.from + replacement.length,
          Math.min(nextContent.length, draft.scope.from + replacement.length + INLINE_EDIT_RECENT_CONTEXT_CHARS)
        ),
        instruction: trimmed,
        scopeKind: draft.scope.kind
      })

      setContent(nextContent)
      if (inlineEditRecord) recordRecentEdits([inlineEditRecord])
      setSelection({ text: '', ranges: [], charCount: 0 })
      setInlineAgentValue('')
      setOperationStatus('idle')
      setNotice({ tone: 'success', message: t('writeInlineEditApplied') })
    } catch (err) {
      setOperationStatus('error', t('writeInlineEditFailed', {
        message: err instanceof Error ? err.message : String(err)
      }))
    } finally {
      setInlineEditInFlight(false)
    }
  }

  /** Insert the animated pending token below the selection and clear it.
   * Returns the resolution job, or null when the selection went stale. */
  const insertPendingPlaceholder = (
    kind: PendingInfographicKind,
    altText: string,
    actionLabel: string,
    maxChars: number
  ): { id: string; src: string; pendingMarkdown: string; altText: string; text: string } | null => {
    const range = selection.ranges[0]
    const richHandle = richHandleRef.current
    const text = selection.text.trim().slice(0, maxChars)
    const pending = beginPendingInfographic(kind)
    const pendingMarkdown = buildPendingInfographicMarkdown(altText, pending.src)
    const insertion = `\n\n${pendingMarkdown}\n`
    if (richHandle) {
      // Rich mode: insert at a projection offset so undo history and node
      // structure stay intact.
      const projection = richHandle.getProjectionText() ?? ''
      const insertAt = lineEndAfter(projection, range.to)
      const applied = richHandle.applyProjectedReplacement(
        { from: insertAt, to: insertAt },
        '',
        insertion,
        actionLabel
      )
      if (!applied) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return null
      }
    } else {
      const latest = useSddDraftStore.getState()
      if (
        latest.activeDraft?.id !== draftId ||
        latest.content.slice(range.from, range.to) !== range.text
      ) {
        finishPendingInfographic(pending.id)
        setOperationStatus('error', t('writeInlineEditChanged'))
        return null
      }
      const insertAt = lineEndAfter(latest.content, range.to)
      setContent(latest.content.slice(0, insertAt) + insertion + latest.content.slice(insertAt))
    }
    setSelection({ text: '', ranges: [], charCount: 0 })
    setOperationStatus('idle')
    return { id: pending.id, src: pending.src, pendingMarkdown, altText, text }
  }

  // Inserts an animated placeholder right away and resolves it in the
  // background, so generation never blocks the editor.
  const generateImage = (kind: WriteInfographicKind): void => {
    if (readOnly) return
    if (selection.ranges.length !== 1 || !selection.text.trim()) {
      setOperationStatus('error', t('writeInlineEditNoSelection'))
      return
    }
    if (typeof window.kunGui?.generateWriteInfographic !== 'function') {
      setOperationStatus('error', t('writeInfographicUnavailable'))
      return
    }
    const job = insertPendingPlaceholder(
      kind,
      t(kind === 'design' ? 'writeDesignDraftAlt' : 'writeInfographicAlt'),
      t(kind === 'design' ? 'writeDesignDraftGenerate' : 'writeInfographicGenerate'),
      WRITE_INFOGRAPHIC_MAX_TEXT_CHARS
    )
    if (!job) return
    void completeImageGeneration({ kind, ...job })
  }

  const generatePrototype = (): void => {
    if (readOnly) return
    if (selection.ranges.length !== 1 || !selection.text.trim()) {
      setOperationStatus('error', t('writeInlineEditNoSelection'))
      return
    }
    if (typeof window.kunGui?.generateWritePrototype !== 'function') {
      setOperationStatus('error', t('writePrototypeUnavailable'))
      return
    }
    const job = insertPendingPlaceholder(
      'prototype',
      t('writePrototypeAlt'),
      t('writePrototypeGenerate'),
      WRITE_PROTOTYPE_MAX_TEXT_CHARS
    )
    if (!job) return
    void completePrototypeGeneration(job)
  }

  const completePrototypeGeneration = async (job: {
    id: string
    src: string
    pendingMarkdown: string
    altText: string
    text: string
  }): Promise<void> => {
    let replacementMarkdown: string | null = null
    let failureMessage: string | null = null
    try {
      const result = await window.kunGui.generateWritePrototype({
        text: job.text,
        filePath: docAbsolutePath,
        workspaceRoot: draftWorkspaceRoot,
        outputDir: SDD_PROTO_RELATIVE_DIR
      })
      if (result.ok) {
        replacementMarkdown = `![${job.altText}](${result.relativePath})`
      } else {
        failureMessage = result.message
      }
    } catch (err) {
      failureMessage = err instanceof Error ? err.message : String(err)
    } finally {
      finishPendingInfographic(job.id)
    }

    const applied = await resolvePendingImage(job, replacementMarkdown)
    if (failureMessage) {
      setOperationStatus('error', t('writePrototypeFailed', { message: failureMessage }))
    } else if (applied) {
      setNotice({ tone: 'success', message: t('writePrototypeReady') })
    }
  }

  const completeImageGeneration = async (job: {
    kind: WriteInfographicKind
    id: string
    src: string
    pendingMarkdown: string
    altText: string
    text: string
  }): Promise<void> => {
    let replacementMarkdown: string | null = null
    let failureMessage: string | null = null
    try {
      const result = await window.kunGui.generateWriteInfographic({
        text: job.text,
        filePath: docAbsolutePath,
        workspaceRoot: draftWorkspaceRoot,
        imageDir: SDD_IMAGE_RELATIVE_DIR,
        kind: job.kind
      })
      if (result.ok) {
        replacementMarkdown = `![${job.altText}](${result.relativePath})`
      } else {
        failureMessage = result.message
      }
    } catch (err) {
      failureMessage = err instanceof Error ? err.message : String(err)
    } finally {
      finishPendingInfographic(job.id)
    }

    const applied = await resolvePendingImage(job, replacementMarkdown)
    if (failureMessage) {
      setOperationStatus('error', t(
        job.kind === 'design' ? 'writeDesignDraftFailed' : 'writeInfographicFailed',
        { message: failureMessage }
      ))
    } else if (applied) {
      setNotice({
        tone: 'success',
        message: t(job.kind === 'design' ? 'writeDesignDraftReady' : 'writeInfographicReady')
      })
    }
  }

  /** Swap the placeholder for the generated image — or remove it when
   * `replacementMarkdown` is null. Returns false when the placeholder is
   * gone (the user deleted it, which cancels the insertion). */
  const resolvePendingImage = async (
    job: { src: string; pendingMarkdown: string },
    replacementMarkdown: string | null
  ): Promise<boolean> => {
    const latest = useSddDraftStore.getState()
    if (latest.activeDraft?.id === draftId) {
      // Node-level swap keeps the rich editor's undo history clean; the text
      // fallback covers the source editor (no rich handle mounted).
      const handle = richHandleRef.current
      if (handle?.replaceImageBySrc(job.src, replacementMarkdown ?? '')) return true
      const next = replacePendingInfographicInText(
        latest.content,
        job.pendingMarkdown,
        replacementMarkdown
      )
      if (next === null) return false
      setContent(next)
      return true
    }
    // The draft was closed mid-generation; dismissing flushed it to disk with
    // the placeholder inside, so patch it on disk.
    if (
      typeof window.kunGui?.readWorkspaceFile !== 'function' ||
      typeof window.kunGui?.writeWorkspaceFile !== 'function'
    ) {
      return false
    }
    try {
      const file = await window.kunGui.readWorkspaceFile({
        path: docAbsolutePath,
        workspaceRoot: draftWorkspaceRoot
      })
      if (!file.ok || file.truncated) return false
      const next = replacePendingInfographicInText(
        file.content,
        job.pendingMarkdown,
        replacementMarkdown
      )
      if (next === null) return false
      const written = await window.kunGui.writeWorkspaceFile({
        path: docAbsolutePath,
        workspaceRoot: draftWorkspaceRoot,
        content: next
      })
      return written.ok
    } catch {
      return false
    }
  }

  return (
    <section className="sdd-draft-shell ds-no-drag flex min-h-0 min-w-0 flex-1 flex-col px-3 sm:px-4 md:px-6 lg:px-8">
      <div className="ds-stage-inset -mx-3 shrink-0 sm:-mx-4 md:-mx-6 lg:-mx-8">
        <header className="sdd-draft-topbar ds-topbar-surface relative z-10 mt-3 flex min-h-[56px] w-full items-stretch overflow-visible rounded-[18px]">
          <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 sm:px-4 md:pl-5 md:pr-2">
            <div
              className={`flex min-w-0 items-center gap-2.5 ${
                leftSidebarCollapsed ? 'ds-window-controls-safe-inset' : ''
              }`}
            >
              {leftSidebarCollapsed ? (
                <SidebarTitlebarToggleButton
                  onClick={onToggleLeftSidebar}
                  title={t('sidebarExpand')}
                  ariaLabel={t('sidebarExpand')}
                />
              ) : null}
              <span className="sdd-draft-file-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <FileText className="h-4 w-4" strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1 leading-none">
                <div className="truncate text-[15px] font-semibold text-ds-ink">
                  {t('sddDraftTitle')}
                </div>
                <div className="mt-1.5 truncate text-[12px] text-ds-faint">
                  {activeDraft.relativePath}
                </div>
              </div>
            </div>

            <div className="flex min-w-0 items-center justify-end gap-1.5">
              <span
                aria-live="polite"
                className={`sdd-status-pill inline-flex min-w-[72px] items-center justify-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold ${
                  readOnly
                    ? 'is-upgrading bg-sky-500/12 text-sky-700 dark:text-sky-300'
                    : saveStatus === 'error'
                      ? 'bg-red-500/12 text-red-600 dark:text-red-300'
                      : saveStatus === 'dirty'
                        ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300'
                        : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                }`}
              >
                {readOnly || saveStatus === 'saving' ? (
                  <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                ) : (
                  <Save className="h-3 w-3" strokeWidth={1.8} />
                )}
                {statusLabel}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
                  void saveActiveSddDraftToDisk()
                }}
                disabled={readOnly || saveStatus === 'saved'}
                className="ds-sidebar-toggle-button disabled:cursor-not-allowed disabled:opacity-45"
                title={t('writeSaveFile')}
                aria-label={t('writeSaveFile')}
              >
                <Save className="h-4 w-4" strokeWidth={1.85} />
              </button>
              <SddAssistantToggleButton
                assistantOpen={assistantOpen}
                onToggleAssistant={onToggleAssistant}
                label={t('sddAssistant')}
              />
              <button
                type="button"
                onClick={onNext}
                disabled={nextDisabled || readOnly}
                className="sdd-next-button inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {readOnly ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
                )}
                {t('sddNextStep')}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={readOnly}
                className="ds-sidebar-toggle-button disabled:cursor-not-allowed disabled:opacity-45"
                title={t('close')}
                aria-label={t('close')}
              >
                <X className="h-4 w-4" strokeWidth={1.9} />
              </button>
            </div>
          </div>
        </header>
      </div>

      <SddRequirementProgress content={content} />

      <div ref={editorPaneRef} className="min-h-0 min-w-0 flex-1 overflow-hidden pb-3 pt-2">
        <div
          className={`sdd-editor-card relative h-full min-h-0 overflow-hidden rounded-[18px] border border-ds-border bg-ds-card/88 shadow-[0_20px_56px_rgba(20,47,95,0.06)] ${
            upgrading ? 'is-upgrading' : ''
          }`}
        >
          {upgrading ? <div className="sdd-editor-progress" /> : null}
          <WriteRichEditor
            value={content}
            workspaceRoot={activeDraft.workspaceRoot}
            filePath={editorFilePath}
            imageDirectory={SDD_IMAGE_RELATIVE_DIR}
            readOnly={readOnly}
            requirementBadges
            handleRef={richHandleRef}
            completionModel={inlineCompletion.model}
            completionEnabled={inlineCompletion.enabled && inlineCompletionApiReady}
            completionDebounceMs={inlineCompletion.debounceMs}
            completionMinAcceptScore={inlineCompletion.minAcceptScore}
            completionLongEnabled={inlineCompletion.longCompletionEnabled}
            completionLongDebounceMs={inlineCompletion.longDebounceMs}
            completionLongMinAcceptScore={inlineCompletion.longMinAcceptScore}
            recentEdits={recentEdits}
            onChange={setContent}
            onDocumentEdit={recordRecentEdits}
            onSelectionChange={setSelection}
            onSaveShortcut={() => {
              if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
              void saveActiveSddDraftToDisk()
            }}
            onImagePasteSaved={() => {
              setOperationStatus('idle')
            }}
            onImagePasteError={(message) => setOperationStatus('error', message)}
            fallback={
              <WriteMarkdownEditor
                value={content}
                workspaceRoot={activeDraft.workspaceRoot}
                filePath={editorFilePath}
                imageDirectory={SDD_IMAGE_RELATIVE_DIR}
                appearance="live"
                livePreviewEnabled
                readOnly={readOnly}
                handleRef={markdownHandleRef}
                completionModel={inlineCompletion.model}
                completionEnabled={inlineCompletion.enabled && inlineCompletionApiReady}
                completionDebounceMs={inlineCompletion.debounceMs}
                completionMinAcceptScore={inlineCompletion.minAcceptScore}
                completionLongEnabled={inlineCompletion.longCompletionEnabled}
                completionLongDebounceMs={inlineCompletion.longDebounceMs}
                completionLongMinAcceptScore={inlineCompletion.longMinAcceptScore}
                recentEdits={recentEdits}
                onChange={setContent}
                onDocumentEdit={recordRecentEdits}
                onSelectionChange={setSelection}
                onSaveShortcut={() => {
                  if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
                  void saveActiveSddDraftToDisk()
                }}
                onImagePasteSaved={() => {
                  setOperationStatus('idle')
                }}
                onImagePasteError={(message) => setOperationStatus('error', message)}
              />
            }
          />
        </div>
      </div>

      {selectionAction ? (
        <WriteInlineAgent
          action={selectionAction}
          value={inlineAgentValue}
          inFlight={inlineEditInFlight}
          textareaRef={inlineAgentTextareaRef}
          onValueChange={setInlineAgentValue}
          onSubmitPrompt={submitToAssistant}
          onApplyEdit={(value) => void submitInlineEdit(value)}
          formattingEnabled={!readOnly}
          onApplyFormat={applyInlineFormat}
          blockType={selection.blockType}
          onSetBlockType={applyBlockType}
          quickActions={inlineQuickActions}
          onQuickAction={runQuickAction}
          infographicEnabled={imageGenReady && !readOnly}
          onGenerateInfographic={() => generateImage('infographic')}
          designDraftEnabled={imageGenReady && !readOnly}
          onGenerateDesignDraft={() => generateImage('design')}
          prototypeEnabled={prototypeReady && !readOnly}
          onGeneratePrototype={generatePrototype}
        />
      ) : null}

      {error ? (
        <div className="sdd-error-toast pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full border border-red-200/70 bg-red-50/92 px-4 py-2 text-[13px] text-red-700 shadow-[0_14px_32px_rgba(20,47,95,0.12)] dark:border-red-900/60 dark:bg-red-950/84 dark:text-red-200">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          className="pointer-events-none fixed left-1/2 z-40 -translate-x-1/2 rounded-full border border-emerald-200/80 bg-emerald-50/92 px-4 py-2 text-[13px] text-emerald-700 shadow-[0_14px_32px_rgba(20,47,95,0.12)] dark:border-emerald-900/60 dark:bg-emerald-950/84 dark:text-emerald-200"
          style={{ bottom: error ? 68 : 20 }}
        >
          {notice.message}
        </div>
      ) : null}
    </section>
  )
}
