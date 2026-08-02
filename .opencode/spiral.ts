/**
 * Spiral detection algorithm — detects reasoning/text spirals by measuring
 * sentence-level duplicate ratio in a sliding window.
 *
 * Complements loop.ts (exact char repetition) by catching semantic spirals
 * where the model repeats the same plans with slightly different wording
 * but never executes them.
 *
 * Pure functions, zero external dependencies. Same create/reset/feed pattern
 * as loop.ts.
 */

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type SpiralOutcome = {
  type: "spiral"
  ratio: number // 0-1, duplicate sentence ratio in window
  source: "reasoning" | "text"
}

export const SPIRAL_DEFAULTS = {
  min_chars: 2000, // startup threshold: total chars before detection begins
  check_interval: 100, // check every this many new chars
  window_size: 8000, // sliding window: only look at the most recent this many chars
  dup_threshold: 0.5, // duplicate ratio above this triggers
  min_sentence_len: 15, // ignore sentences shorter than this (after normalize)
  min_sentences: 20, // minimum sentence count in window (statistical noise guard)
} as const

// Sentence boundary: split on whitespace/newline after . ! ? 。
const SENTENCE_END = /(?<=[.!?。])\s+|\n+/u

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fold all whitespace to a single space + trim (same as loop.ts). */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Split text into normalized sentences, filtering out short ones. */
function splitSentences(text: string, minLen: number): string[] {
  const parts = text.split(SENTENCE_END)
  const sentences: string[] = []
  for (const p of parts) {
    const s = normalize(p)
    if (s.length >= minLen) sentences.push(s)
  }
  return sentences
}

// ---------------------------------------------------------------------------
// create() — stateful detector factory
// ---------------------------------------------------------------------------

export function create(options: {
  source: "reasoning" | "text"
  min_chars?: number
  check_interval?: number
  window_size?: number
  dup_threshold?: number
  min_sentence_len?: number
  min_sentences?: number
  on_detected?: (outcome: SpiralOutcome) => void
}): {
  feed(delta: string): SpiralOutcome | undefined
  reset(): void
} {
  const minChars = options.min_chars ?? SPIRAL_DEFAULTS.min_chars
  const interval = options.check_interval ?? SPIRAL_DEFAULTS.check_interval
  const windowSize = options.window_size ?? SPIRAL_DEFAULTS.window_size
  const dupThreshold = options.dup_threshold ?? SPIRAL_DEFAULTS.dup_threshold
  const minSentenceLen = options.min_sentence_len ?? SPIRAL_DEFAULTS.min_sentence_len
  const minSentences = options.min_sentences ?? SPIRAL_DEFAULTS.min_sentences
  const source = options.source

  let buffer = ""
  let total = 0
  let last = 0

  function detect(): SpiralOutcome | undefined {
    const sentences = splitSentences(buffer, minSentenceLen)
    if (sentences.length < minSentences) return undefined

    const seen = new Set<string>()
    let dupCount = 0
    for (const s of sentences) {
      if (seen.has(s)) {
        dupCount++
      } else {
        seen.add(s)
      }
    }
    const ratio = dupCount / sentences.length
    if (ratio >= dupThreshold) {
      const outcome: SpiralOutcome = { type: "spiral", ratio, source }
      options.on_detected?.(outcome)
      return outcome
    }
    return undefined
  }

  return {
    feed(delta: string): SpiralOutcome | undefined {
      buffer += delta
      total += delta.length
      // Sliding window: keep only the most recent windowSize chars
      if (buffer.length > windowSize) {
        buffer = buffer.slice(buffer.length - windowSize)
      }
      // Startup threshold
      if (total < minChars) return undefined
      // Check interval
      if (total - last < interval) return undefined
      last = total
      return detect()
    },
    reset() {
      buffer = ""
      total = 0
      last = 0
    },
  }
}

// ---------------------------------------------------------------------------
// isSpiralOutcome() — type guard
// ---------------------------------------------------------------------------

export function isSpiralOutcome(value: unknown): value is SpiralOutcome {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "spiral"
}
