/**
 * Content labelling for dsh-life — pure functions, no IO.
 *
 * PLAN.md §6.8 is explicit that labelling is an architectural fact, not a
 * judgement the model makes once: a post that "happens to" miss its label is a
 * violation, and relying on prompt text to remember it hands compliance to
 * probability. So this module has:
 *
 *   - `labelContent()`  — always appends a visible label that carries the
 *                         content id required by 标识办法 §5, and returns the
 *                         metadata a file channel would embed;
 *   - `assertLabeled()` — the hard gate the publish chain must pass before a
 *                         record may become `confirmed`;
 *   - **no strip/remove function at all**, exported or otherwise.
 *
 * The explicit label wording is configurable through `template`, but it must
 * contain `{contentId}`: 标识办法 §5 makes the content number mandatory, so a
 * template that drops it is rejected rather than silently accepted.
 */

/** Prefix the visible label always starts with; used by tests and the UI. */
export const EXPLICIT_LABEL_PREFIX = '—— AI 生成'

/** Template used when the caller does not supply one. `{contentId}` is required. */
export const DEFAULT_LABEL_TEMPLATE = `${EXPLICIT_LABEL_PREFIX} · 内容编号 {contentId}`

/** Text channels do not have file metadata, so we say so instead of pretending. */
export const IMPLICIT_NOT_APPLICABLE = 'not-applicable'

/**
 * Whether `text` already carries the explicit label for `contentId`.
 *
 * Kept as a visible predicate so both `labelContent` (idempotent re-labelling
 * on retry) and `assertLabeled` share one definition. Requiring the exact id
 * means text that merely mentions "AI" cannot pass as a label.
 */
export function hasExplicitLabel (text, contentId) {
  if (typeof text !== 'string' || typeof contentId !== 'string' || !contentId.trim()) return false
  const id = contentId.trim()
  return text.includes('AI 生成') && text.includes(`内容编号 ${id}`)
}

/**
 * Produce the labelled text and its implicit-identifier metadata.
 *
 * @param {object} input
 * @param {string} input.text - model-authored body, without the label
 * @param {string} input.contentId - stable content number (shared with outbox)
 * @param {string} [input.identityName] - provider display name (metadata only)
 * @param {string} [input.providerCode] - service provider code (metadata)
 * @param {'text'|'file'} [input.mediaType] - text means implicit is not applicable
 * @param {string} [input.template] - visible label template; must contain `{contentId}`
 * @returns {{text: string, metadata: object}}
 */
export function labelContent ({
  text,
  identityName,
  contentId,
  providerCode,
  mediaType = 'text',
  template = DEFAULT_LABEL_TEMPLATE,
} = {}) {
  if (typeof text !== 'string') throw new Error('life/compliance-text-required')
  const id = typeof contentId === 'string' ? contentId.trim() : ''
  if (!id) throw new Error('life/compliance-content-id-required')

  const labelTemplate = typeof template === 'string' ? template.trim() : ''
  if (!labelTemplate) throw new Error('life/compliance-label-template-empty')
  if (!labelTemplate.includes('{contentId}')) {
    // A configurable wording is fine; a wording without the mandatory content
    // number is not, because §5 makes that number a required element.
    throw new Error('life/compliance-label-template-requires-content-id')
  }

  const explicit = labelTemplate.replaceAll('{contentId}', id)
  const body = text.replace(/\s+$/, '')
  // Idempotent: queueing or re-checking the same draft must not stack labels.
  const labelled = hasExplicitLabel(body, id) ? body : `${body}\n\n${explicit}`

  const provider = typeof providerCode === 'string' && providerCode.trim() ? providerCode.trim() : 'dsh-life'
  const providerName = typeof identityName === 'string' && identityName.trim() ? identityName.trim() : null
  const isText = mediaType === 'text'

  const metadata = {
    // 生成合成属性
    synthetic: true,
    // 服务提供者名称或编码
    providerCode: provider,
    providerName,
    // 内容编号 — the same value as the outbox contentId, not a second id.
    contentId: id,
    explicitLabel: explicit,
    // For a text channel there is no file metadata to write; saying
    // "written" would be a lie. A file channel would embed these fields.
    implicit: isText ? IMPLICIT_NOT_APPLICABLE : 'written',
    mediaType,
  }

  return { text: labelled, metadata }
}

/**
 * Hard gate before `confirmed`: no explicit label or no content id means the
 * record may not be treated as publishable, no matter what the transport says.
 */
export function assertLabeled ({ text, metadata } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('life/compliance-missing-text')
  }
  const contentId = metadata && typeof metadata.contentId === 'string'
    ? metadata.contentId.trim()
    : ''
  if (!contentId) throw new Error('life/compliance-missing-content-id')
  if (!hasExplicitLabel(text, contentId)) {
    throw new Error('life/compliance-missing-explicit-label')
  }
  return { contentId, text, metadata }
}
