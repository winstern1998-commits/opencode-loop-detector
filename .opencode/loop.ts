/**
 * Loop detection algorithm — ported from opencode PR #21112 (`session/loop.ts`).
 *
 * Pure functions, zero external dependencies. Detects repetitive patterns in
 * LLM streaming text (reasoning or text phase) by scanning a sliding window
 * buffer for repeated blocks of a given period.
 */

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type LoopOutcome = {
  type: "loop"
  period: number
  source: "reasoning" | "text"
}

export const DEFAULTS = {
  min_period: 20,
  max_period: 2000,
  similarity: 1.0,
  check_interval: 100,
  min_chars: 200,
  max_nudges: 2,
  min_repeats: 4,
} as const

const REMINDER =
  "<system-reminder>\nYour output is repeating in a loop with period ~{period} characters. " +
  "Stop repeating and take a different, concrete action.\n</system-reminder>"

const ALPHANUMERIC = /[\p{L}\p{N}]/u

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fold all whitespace to a single space + trim (handles newline/indent drift). */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Character-level similarity via position-by-position comparison. */
function similarity(first: string, second: string, threshold: number): number {
  const length = Math.max(first.length, second.length)
  if (length === 0) return 1.0
  if (Math.abs(first.length - second.length) > (1 - threshold) * length) return 0
  let matches = 0
  const shorter = Math.min(first.length, second.length)
  for (let i = 0; i < shorter; i++) {
    if (first[i] === second[i]) matches++
  }
  return matches / length
}

// ---------------------------------------------------------------------------
// create() — stateful detector factory
// ---------------------------------------------------------------------------

export function create(options: {
  source: "reasoning" | "text"
  min_period?: number
  max_period?: number
  similarity?: number
  check_interval?: number
  min_chars?: number
  min_repeats?: number
  on_detected?: (outcome: LoopOutcome) => void
}): {
  feed(delta: string): LoopOutcome | undefined
  reset(): void
} {
  const minPeriod = options.min_period ?? DEFAULTS.min_period
  const maxPeriod = options.max_period ?? DEFAULTS.max_period
  const threshold = options.similarity ?? DEFAULTS.similarity
  const interval = options.check_interval ?? DEFAULTS.check_interval
  const minChars = options.min_chars ?? DEFAULTS.min_chars
  const minRepeats = options.min_repeats ?? DEFAULTS.min_repeats
  const capacity = minRepeats * maxPeriod
  const source = options.source

  let buffer = ""
  let total = 0
  let last = 0

  function detect(): LoopOutcome | undefined {
    const length = buffer.length
    if (length < minRepeats * minPeriod) return undefined

    const upper = Math.min(Math.floor(length / minRepeats), maxPeriod)
    const lower = minPeriod

    for (let period = upper; period >= lower; period--) {
      // Two-point quick pre-check (O(1) rejection of ~99.95% non-repeating periods)
      const tail = length - 1
      const mid = length - 1 - Math.floor(period / 2)
      if (buffer[tail] !== buffer[tail - period]) continue
      if (buffer[mid] !== buffer[mid - period]) continue

      // Normalized last segment
      const lastSeg = normalize(buffer.slice(length - period))

      // Alphanumeric filter — reject structural patterns like "---" or "| --- |"
      if (!ALPHANUMERIC.test(lastSeg)) continue

      // Verify the previous minRepeats-1 segments all match the last segment.
      // similarity >= 1.0 requires exact match; otherwise position-wise similarity.
      let ok = true
      for (let i = 1; i < minRepeats; i++) {
        const seg = normalize(buffer.slice(length - (i + 1) * period, length - i * period))
        if (threshold >= 1.0) {
          if (seg !== lastSeg) { ok = false; break }
        } else {
          if (similarity(seg, lastSeg, threshold) < threshold) { ok = false; break }
        }
      }
      if (!ok) continue

      const outcome: LoopOutcome = { type: "loop", period, source }
      options.on_detected?.(outcome)
      return outcome
    }
    return undefined
  }

  return {
    feed(delta: string): LoopOutcome | undefined {
      buffer += delta
      total += delta.length
      if (buffer.length > capacity) buffer = buffer.slice(buffer.length - capacity)
      if (total < minChars) return undefined
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
// recovery() — nudge vs abort decision
// ---------------------------------------------------------------------------

export function recovery(
  attempt: number,
  options?: { max_nudges?: number; reminder?: string; period?: number },
): { action: "nudge"; reminder: string } | { action: "abort"; period: number; attempts: number } {
  const nudges = options?.max_nudges ?? DEFAULTS.max_nudges
  const period = options?.period ?? 0

  if (attempt < nudges) {
    const template = options?.reminder ?? REMINDER
    return { action: "nudge", reminder: template.replace("{period}", String(period)) }
  }
  return { action: "abort", period, attempts: attempt + 1 }
}

// ---------------------------------------------------------------------------
// isLoopOutcome() — type guard
// ---------------------------------------------------------------------------

export function isLoopOutcome(value: unknown): value is LoopOutcome {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "loop"
}
