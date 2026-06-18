/**
 * First-party subagent profiles.
 *
 * These are merged into the configured `subagents.profiles` record at the
 * composition root so roles like `design-reviewer` are available via
 * `delegate_task` without the user editing config.json. User-defined
 * profiles with the same name win (the merge puts builtins first).
 */

import type {
  SubagentProfileConfig,
  SubagentsCapabilityConfig
} from '../contracts/capabilities.js'

/**
 * A read-only design reviewer. It inspects frontend code/prototypes and
 * reports concrete, prioritized issues — it never edits files (toolPolicy
 * is `readOnly`, enforced by the delegation runtime and tool registry).
 */
export const DESIGN_REVIEWER_PROFILE: SubagentProfileConfig = {
  toolPolicy: 'readOnly',
  promptPreamble: [
    '你是 Kun 内置的设计审查者，以只读方式审查前端代码与原型的视觉与交互质量。',
    '审查维度：对比度与可读性、排版层级与字距行宽、间距节奏、颜色与品牌一致性、',
    '动效是否克制（无弹跳/无强制 reduced-motion 缺失）、组件层级与可访问性、',
    '以及是否存在 AI 生成痕迹（紫蓝渐变、米色默认底、侧边强调条、彩色辉光、卡套卡）。',
    '只读取文件、不修改任何内容。输出按严重程度排序的问题清单，每条给出 文件:行 与可执行的修改建议；',
    '不要泛泛而谈“可以更好”，要具体到改什么、改成什么。'
  ].join('')
}

/** All builtin profiles, keyed by their `delegate_task` profile name. */
export const BUILTIN_SUBAGENT_PROFILES: Readonly<Record<string, SubagentProfileConfig>> = {
  'design-reviewer': DESIGN_REVIEWER_PROFILE
}

/** Merge builtin profiles into a subagents config (user profiles take precedence). */
export function mergeBuiltinSubagentProfiles(
  config: SubagentsCapabilityConfig
): SubagentsCapabilityConfig {
  return {
    ...config,
    profiles: { ...BUILTIN_SUBAGENT_PROFILES, ...config.profiles }
  }
}
