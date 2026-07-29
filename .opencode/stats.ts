/**
 * Stats module — records cumulative loop/spiral detection, nudge, and abort
 * counts, broken down by detection type (loop/spiral) and source
 * (reasoning/text).
 *
 * Persisted to a JSON file (default `~/.loop-detector/stats.json`) so counts
 * survive plugin / opencode restarts. Pure counter logic + thin fs helpers,
 * same zero-dependency philosophy as loop.ts / spiral.ts.
 *
 * Public surface:
 *   - createEmptyStats()         → fresh Stats object
 *   - record(stats, type, src, action) → mutate + return stats
 *   - format(stats)              → human-readable string (for tool output)
 *   - loadStats(path)            → read Stats from disk (empty on missing/corrupt)
 *   - saveStats(path, stats)     → write Stats to disk (best-effort, auto-mkdir)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectionType = "loop" | "spiral"
export type Source = "reasoning" | "text"
export type Action = "detect" | "nudge" | "abort"

export interface Stats {
  /** Counts keyed by detectionType → source → action. */
  counts: {
    [T in DetectionType]: {
      [S in Source]: {
        detect: number
        nudge: number
        abort: number
      }
    }
  }
  /** Aggregate totals across all types & sources. */
  totals: { detect: number; nudge: number; abort: number }
  /** ISO timestamp of the first recorded event, or null if none. */
  firstSeen: string | null
  /** ISO timestamp of the most recent recorded event, or null if none. */
  lastSeen: string | null
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function createEmptyStats(): Stats {
  return {
    counts: {
      loop: {
        reasoning: { detect: 0, nudge: 0, abort: 0 },
        text: { detect: 0, nudge: 0, abort: 0 },
      },
      spiral: {
        reasoning: { detect: 0, nudge: 0, abort: 0 },
        text: { detect: 0, nudge: 0, abort: 0 },
      },
    },
    totals: { detect: 0, nudge: 0, abort: 0 },
    firstSeen: null,
    lastSeen: null,
  }
}

// ---------------------------------------------------------------------------
// record() — increment a counter
// ---------------------------------------------------------------------------

/**
 * Mutates `stats` in place: increments the counter for (type, source, action)
 * and updates totals + timestamps. Returns the same `stats` reference for
 * chaining convenience.
 */
export function record(
  stats: Stats,
  type: DetectionType,
  source: Source,
  action: Action,
): Stats {
  stats.counts[type][source][action]++
  stats.totals[action]++
  const now = new Date().toISOString()
  if (stats.firstSeen === null) stats.firstSeen = now
  stats.lastSeen = now
  return stats
}

// ---------------------------------------------------------------------------
// format() — human-readable rendering (tool output)
// ---------------------------------------------------------------------------

export function format(stats: Stats): string {
  const lines: string[] = []
  lines.push("Loop Detector Statistics")
  lines.push("=".repeat(25))
  lines.push(
    `Total: ${stats.totals.detect} detection(s), ${stats.totals.nudge} nudge(s), ${stats.totals.abort} abort(s)`,
  )
  lines.push("")
  lines.push("By type & source:")
  const types: DetectionType[] = ["loop", "spiral"]
  const sources: Source[] = ["reasoning", "text"]
  for (const t of types) {
    for (const s of sources) {
      const c = stats.counts[t][s]
      const label = `${t} / ${s}`.padEnd(18)
      lines.push(
        `  ${label} ${c.detect} detect(s), ${c.nudge} nudge(s), ${c.abort} abort(s)`,
      )
    }
  }
  lines.push("")
  lines.push(`First seen: ${stats.firstSeen ?? "—"}`)
  lines.push(`Last seen:  ${stats.lastSeen ?? "—"}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// loadStats() / saveStats() — persistence
// ---------------------------------------------------------------------------

/**
 * Reads Stats from `filePath`. Returns an empty Stats object if the file is
 * missing, unreadable, or contains malformed JSON (best-effort, never throws).
 */
export function loadStats(filePath: string): Stats {
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw)
    return normalize(parsed)
  } catch {
    return createEmptyStats()
  }
}

/**
 * Writes `stats` to `filePath` as pretty-printed JSON. Creates parent
 * directories as needed. Best-effort: swallows errors so a failing stats
 * write never breaks detection.
 */
export function saveStats(filePath: string, stats: Stats): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(stats, null, 2) + "\n", "utf-8")
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// normalize() — validate / coerce a parsed object into a well-formed Stats
// ---------------------------------------------------------------------------

function normalize(value: unknown): Stats {
  if (typeof value !== "object" || value === null) return createEmptyStats()
  const v = value as Partial<Stats>
  const stats = createEmptyStats()
  const types: DetectionType[] = ["loop", "spiral"]
  const sources: Source[] = ["reasoning", "text"]
  const actions: Action[] = ["detect", "nudge", "abort"]
  let detect = 0
  let nudge = 0
  let abort = 0
  for (const t of types) {
    const tv = v?.counts?.[t]
    if (typeof tv !== "object" || tv === null) continue
    for (const s of sources) {
      const sv = tv[s]
      if (typeof sv !== "object" || sv === null) continue
      for (const a of actions) {
        const n = typeof sv[a] === "number" && sv[a] >= 0 ? Math.floor(sv[a] as number) : 0
        stats.counts[t][s][a] = n
        if (a === "detect") detect += n
        else if (a === "nudge") nudge += n
        else abort += n
      }
    }
  }
  // Recompute totals from the per-cell counts so they can't drift.
  stats.totals = { detect, nudge, abort }
  if (typeof v.firstSeen === "string") stats.firstSeen = v.firstSeen
  if (typeof v.lastSeen === "string") stats.lastSeen = v.lastSeen
  return stats
}
