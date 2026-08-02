/**
 * opencode-loop-detector — plugin entry point.
 *
 * Detects LLM loops in reasoning/text generation via the `event` hook and
 * `client.session.abort` / `client.session.promptAsync` SDK calls.
 *
 * See DESIGN.md for the full design rationale and PR #21112 mapping.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { create, recovery, DEFAULTS, type LoopOutcome } from "./loop.ts"
import { create as createSpiral, SPIRAL_DEFAULTS, type SpiralOutcome } from "./spiral.ts"
import {
  createEmptyStats,
  record as recordStat,
  format as formatStats,
  loadStats,
  saveStats,
  type Stats,
  type DetectionType,
  type Source,
} from "./stats.ts"
import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface LoopDetectorConfig {
  enabled?: boolean
  min_period?: number
  max_period?: number
  similarity?: number
  check_interval?: number
  min_chars?: number
  min_repeats?: number
  max_nudges?: number
  reminder?: string
  spiral_min_chars?: number
  spiral_check_interval?: number
  spiral_window_size?: number
  spiral_dup_threshold?: number
  spiral_min_sentence_len?: number
  spiral_min_sentences?: number
  stats_path?: string
}

type DetectionOutcome = LoopOutcome | SpiralOutcome

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  reasoningDetector: ReturnType<typeof create>
  textDetector: ReturnType<typeof create>
  reasoningSpiralDetector: ReturnType<typeof createSpiral>
  textSpiralDetector: ReturnType<typeof createSpiral>
  nudgeCount: number
  pendingAction:
    | { type: "nudge"; reminder: string; period: number; source: string; detectionType: "loop" | "spiral"; ratio?: number }
    | { type: "abort"; period: number; attempts: number; source: string; detectionType: "loop" | "spiral"; ratio?: number }
    | null
  aborting: boolean
  idleTimeout: ReturnType<typeof setTimeout> | null
  partTypes: Map<string, "reasoning" | "text">
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".loop-detector")
const LOG_FILE = join(LOG_DIR, "detector.log")
const DEFAULT_STATS_PATH = join(LOG_DIR, "stats.json")

function log(message: string): void {
  const ts = new Date().toISOString()
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${ts}] ${message}\n`)
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 5000

const SPIRAL_REMINDER =
  "<system-reminder>\nYour reasoning is stuck in a repetitive spiral (duplicate sentence ratio ~{ratio}%). " +
  "You are repeating the same plans without executing them. Stop planning and take a concrete action now.\n</system-reminder>"

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const LoopDetector: Plugin = async (input, options) => {
  const client = input.client
  const serverUrl = input.serverUrl
  const opts = (options ?? {}) as LoopDetectorConfig

  const config = {
    min_period: opts.min_period ?? DEFAULTS.min_period,
    max_period: opts.max_period ?? DEFAULTS.max_period,
    similarity: opts.similarity ?? DEFAULTS.similarity,
    check_interval: opts.check_interval ?? DEFAULTS.check_interval,
    min_chars: opts.min_chars ?? DEFAULTS.min_chars,
    min_repeats: opts.min_repeats ?? DEFAULTS.min_repeats,
    max_nudges: opts.max_nudges ?? DEFAULTS.max_nudges,
    enabled: opts.enabled,
    reminder: opts.reminder,
    spiral_min_chars: opts.spiral_min_chars ?? SPIRAL_DEFAULTS.min_chars,
    spiral_check_interval: opts.spiral_check_interval ?? SPIRAL_DEFAULTS.check_interval,
    spiral_window_size: opts.spiral_window_size ?? SPIRAL_DEFAULTS.window_size,
    spiral_dup_threshold: opts.spiral_dup_threshold ?? SPIRAL_DEFAULTS.dup_threshold,
    spiral_min_sentence_len: opts.spiral_min_sentence_len ?? SPIRAL_DEFAULTS.min_sentence_len,
    spiral_min_sentences: opts.spiral_min_sentences ?? SPIRAL_DEFAULTS.min_sentences,
    stats_path: opts.stats_path,
  }

  if (config.enabled === false) {
    log("Plugin disabled (enabled: false)")
    return {}
  }

  log(`Plugin loaded. serverUrl=${serverUrl.href} config=${JSON.stringify(config)}`)

  const statsPath = config.stats_path ?? DEFAULT_STATS_PATH
  let stats: Stats = loadStats(statsPath)
  log(
    `Stats loaded from ${statsPath}: ${stats.totals.detect} detect(s), ${stats.totals.nudge} nudge(s), ${stats.totals.abort} abort(s)`,
  )

  const sessions = new Map<string, SessionState>()

  const sessionInfo = new Map<string, { title?: string; model?: string; agent?: string }>()

  function sessLabel(sessionID: string): string {
    const info = sessionInfo.get(sessionID)
    if (!info) return sessionID
    const parts: string[] = []
    if (info.title) parts.push(`title="${info.title}"`)
    if (info.model) parts.push(`model=${info.model}`)
    if (info.agent) parts.push(`agent=${info.agent}`)
    return parts.length ? `${sessionID} ${parts.join(" ")}` : sessionID
  }

  // LRU guard — prevent unbounded growth in abnormal cases
  const MAX_SESSIONS = 100

  function getOrCreateState(sessionID: string): SessionState {
    let state = sessions.get(sessionID)
    if (state) return state

    if (sessions.size >= MAX_SESSIONS) {
      // Evict oldest entry (Map preserves insertion order)
      const oldest = sessions.keys().next().value
      if (oldest) {
        const old = sessions.get(oldest)
        if (old?.idleTimeout) clearTimeout(old.idleTimeout)
        sessions.delete(oldest)
      }
    }

    const detectorOpts = {
      min_period: config.min_period,
      max_period: config.max_period,
      similarity: config.similarity,
      check_interval: config.check_interval,
      min_chars: config.min_chars,
      min_repeats: config.min_repeats,
    }

    const spiralOpts = {
      min_chars: config.spiral_min_chars,
      check_interval: config.spiral_check_interval,
      window_size: config.spiral_window_size,
      dup_threshold: config.spiral_dup_threshold,
      min_sentence_len: config.spiral_min_sentence_len,
      min_sentences: config.spiral_min_sentences,
    }

    state = {
      reasoningDetector: create({
        source: "reasoning",
        ...detectorOpts,
        on_detected: (o) => log(`[${sessLabel(sessionID)}] reasoning loop detected: period=${o.period}`),
      }),
      textDetector: create({
        source: "text",
        ...detectorOpts,
        on_detected: (o) => log(`[${sessLabel(sessionID)}] text loop detected: period=${o.period}`),
      }),
      reasoningSpiralDetector: createSpiral({
        source: "reasoning",
        ...spiralOpts,
        on_detected: (o) => log(`[${sessLabel(sessionID)}] reasoning spiral detected: ratio=${o.ratio.toFixed(2)}`),
      }),
      textSpiralDetector: createSpiral({
        source: "text",
        ...spiralOpts,
        on_detected: (o) => log(`[${sessLabel(sessionID)}] text spiral detected: ratio=${o.ratio.toFixed(2)}`),
      }),
      nudgeCount: 0,
      pendingAction: null,
      aborting: false,
      idleTimeout: null,
      partTypes: new Map(),
    }
    sessions.set(sessionID, state)
    return state
  }

  // -------------------------------------------------------------------------
  // Abort helper (SDK → HTTP fallback)
  // -------------------------------------------------------------------------

  async function abortSession(sessionID: string): Promise<void> {
    try {
      await client.session.abort({ path: { id: sessionID } })
      log(`[${sessLabel(sessionID)}] abort succeeded via SDK`)
    } catch (err) {
      log(`[${sessLabel(sessionID)}] SDK abort failed: ${String(err)}, trying HTTP fallback`)
      try {
        const resp = await fetch(`${serverUrl.origin}/session/${sessionID}/abort`, {
          method: "POST",
        })
        if (!resp.ok) {
          log(`[${sessLabel(sessionID)}] HTTP abort returned ${resp.status}`)
        } else {
          log(`[${sessLabel(sessionID)}] abort succeeded via HTTP fallback`)
        }
      } catch (err2) {
        log(`[${sessLabel(sessionID)}] HTTP abort also failed: ${String(err2)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // handleDetected
  // -------------------------------------------------------------------------

  async function handleDetected(sessionID: string, outcome: DetectionOutcome): Promise<void> {
    const state = getOrCreateState(sessionID)
    state.aborting = true

    const isSpiral = outcome.type === "spiral"
    const period = isSpiral ? 0 : outcome.period

    // Record detection in cumulative stats
    const detType: DetectionType = isSpiral ? "spiral" : "loop"
    const src: Source = outcome.source
    recordStat(stats, detType, src, "detect")
    saveStats(statsPath, stats)

    const decision = recovery(state.nudgeCount, {
      max_nudges: config.max_nudges,
      reminder: isSpiral ? SPIRAL_REMINDER : config.reminder,
      period,
    })

    if (decision.action === "nudge") {
      // recovery() replaces {period} in the template; spiral uses {ratio} so
      // apply the spiral reminder manually when needed.
      const reminder = isSpiral
        ? SPIRAL_REMINDER.replace("{ratio}", String(Math.round((outcome as SpiralOutcome).ratio * 100)))
        : decision.reminder
      log(
        `[${sessLabel(sessionID)}] nudge decided (attempt=${state.nudgeCount}, ` +
          `${isSpiral ? `ratio=${(outcome as SpiralOutcome).ratio.toFixed(2)}` : `period=${period}`})`,
      )
      state.pendingAction = {
        type: "nudge",
        reminder,
        period,
        source: outcome.source,
        detectionType: isSpiral ? "spiral" : "loop",
        ratio: isSpiral ? (outcome as SpiralOutcome).ratio : undefined,
      }
    } else {
      log(
        `[${sessLabel(sessionID)}] abort decided (attempts=${decision.attempts}, ` +
          `${isSpiral ? `ratio=${(outcome as SpiralOutcome).ratio.toFixed(2)}` : `period=${period}`})`,
      )
      state.pendingAction = {
        type: "abort",
        period,
        attempts: decision.attempts,
        source: outcome.source,
        detectionType: isSpiral ? "spiral" : "loop",
        ratio: isSpiral ? (outcome as SpiralOutcome).ratio : undefined,
      }
    }

    await abortSession(sessionID)

    // Timeout fallback: if session.idle doesn't arrive within IDLE_TIMEOUT_MS,
    // execute the pending action directly.
    state.idleTimeout = setTimeout(() => {
      const s = sessions.get(sessionID)
      if (!s || !s.pendingAction) return
      log(`[${sessLabel(sessionID)}] idle timeout fired, executing pending action`)
      void executePendingAction(sessionID, s)
    }, IDLE_TIMEOUT_MS)
  }

  // -------------------------------------------------------------------------
  // executePendingAction — called from session.idle OR timeout
  // -------------------------------------------------------------------------

  async function executePendingAction(sessionID: string, state: SessionState): Promise<void> {
    const action = state.pendingAction
    if (!action) return

    // Clear pendingAction immediately to prevent re-entry from concurrent
    // session.idle events (race condition guard)
    state.pendingAction = null

    // Clear timeout if still set (called from idle path)
    if (state.idleTimeout) {
      clearTimeout(state.idleTimeout)
      state.idleTimeout = null
    }

    if (action.type === "nudge") {
      // Show toast so the user can see the nudge in the TUI
      // (synthetic messages are hidden from the chat view)
      const isSpiral = action.detectionType === "spiral"
      const title = isSpiral ? "Spiral Detected — Nudge" : "Loop Detected — Nudge"
      const detail = isSpiral
        ? ` (duplicate sentence ratio ~${Math.round((action.ratio ?? 0) * 100)}%)`
        : ` (period ~${action.period} chars)`
      try {
        await client.tui.showToast({
          body: {
            title,
            message: `Repetitive ${action.source} output detected${detail}. Sending reminder to redirect.`,
            variant: "warning",
          },
        })
      } catch (err) {
        log(`[${sessLabel(sessionID)}] showToast (nudge) failed: ${String(err)}`)
      }
      try {
        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: action.reminder, synthetic: true }],
          },
        })
        log(`[${sessLabel(sessionID)}] nudge sent (nudgeCount=${state.nudgeCount + 1})`)
      } catch (err) {
        log(`[${sessLabel(sessionID)}] promptAsync failed: ${String(err)}`)
      }
      state.nudgeCount++
      recordStat(stats, action.detectionType as DetectionType, action.source as Source, "nudge")
      saveStats(statsPath, stats)
      state.reasoningDetector.reset()
      state.textDetector.reset()
      state.reasoningSpiralDetector.reset()
      state.textSpiralDetector.reset()
      state.aborting = false
    } else {
      // abort path — final termination
      const isSpiral = action.detectionType === "spiral"
      const title = isSpiral ? "Spiral Detected" : "Loop Detected"
      const detail = isSpiral
        ? ` (duplicate sentence ratio ~${Math.round((action.ratio ?? 0) * 100)}%)`
        : ` (period ~${action.period} chars)`
      try {
        await client.tui.showToast({
          body: {
            title,
            message: `Repetitive ${action.source} output detected${detail} after ${action.attempts} attempt(s). Session aborted.`,
            variant: "warning",
          },
        })
      } catch (err) {
        log(`[${sessLabel(sessionID)}] showToast failed: ${String(err)}`)
      }
      log(`[${sessLabel(sessionID)}] final abort, cleaning up session state`)
      recordStat(stats, action.detectionType as DetectionType, action.source as Source, "abort")
      saveStats(statsPath, stats)
      sessions.delete(sessionID)
    }
  }

  // -------------------------------------------------------------------------
  // Event handler
  // -------------------------------------------------------------------------

  return {
    event: async ({ event }) => {
      // -- message.part.updated -------------------------------------------
      // Track part type (reasoning vs text) for later delta events.
      // In opencode 1.17.x, deltas are delivered via separate
      // `message.part.delta` events, not via the `delta` field here.
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text" || part.type === "reasoning") {
          const sessionID = part.sessionID
          const state = getOrCreateState(sessionID)
          state.partTypes.set(part.id, part.type)

          // Fallback: if delta is present (older opencode versions), feed it
          const delta = event.properties.delta
          if (delta) {
            if (state.aborting || state.pendingAction) return
            const detector = part.type === "reasoning" ? state.reasoningDetector : state.textDetector
            const outcome = detector.feed(delta)
            if (outcome) {
              await handleDetected(sessionID, outcome)
            }
            // Skip spiral feed if loop already triggered
            if (state.aborting || state.pendingAction) return

            const spiralDetector =
              part.type === "reasoning" ? state.reasoningSpiralDetector : state.textSpiralDetector
            const spiralOutcome = spiralDetector.feed(delta)
            if (spiralOutcome) {
              await handleDetected(sessionID, spiralOutcome)
            }
          }
        }
        return
      }

      // -- message.part.delta ---------------------------------------------
      // opencode 1.17.x streams deltas via this event type.
      // Properties: { sessionID, messageID, partID, field, delta }
      if (event.type === "message.part.delta") {
        const props = event.properties as {
          sessionID: string
          partID: string
          delta: string
        }
        if (!props.delta) return

        const sessionID = props.sessionID
        const state = getOrCreateState(sessionID)

        // Re-entry guard: ignore deltas while aborting or pending
        if (state.aborting || state.pendingAction) return

        // Look up the part type from our tracking map
        const partType = state.partTypes.get(props.partID)
        if (partType !== "reasoning" && partType !== "text") return

        const detector = partType === "reasoning" ? state.reasoningDetector : state.textDetector
        const outcome = detector.feed(props.delta)
        if (outcome) {
          await handleDetected(sessionID, outcome)
        }
        // Skip spiral feed if loop already triggered
        if (state.aborting || state.pendingAction) return

        const spiralDetector =
          partType === "reasoning" ? state.reasoningSpiralDetector : state.textSpiralDetector
        const spiralOutcome = spiralDetector.feed(props.delta)
        if (spiralOutcome) {
          await handleDetected(sessionID, spiralOutcome)
        }
        return
      }

      // -- session.updated -------------------------------------------------
      // Cache session metadata (title, model, agent) for log enrichment.
      if (event.type === "session.updated") {
        const props = event.properties as {
          sessionID: string
          info?: {
            title?: string
            model?: { id: string; providerID: string; variant?: string }
            agent?: string
          }
        }
        if (props.sessionID && props.info) {
          sessionInfo.set(props.sessionID, {
            title: props.info.title,
            model: props.info.model ? `${props.info.model.providerID}/${props.info.model.id}` : undefined,
            agent: props.info.agent,
          })
        }
        return
      }

      // -- session.idle ----------------------------------------------------
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID
        const state = sessions.get(sessionID)
        if (!state) return

        if (state.pendingAction) {
          log(`[${sessLabel(sessionID)}] session.idle received, executing pending action`)
          await executePendingAction(sessionID, state)
        } else {
          // Normal completion — reset detectors and counters
          state.reasoningDetector.reset()
          state.textDetector.reset()
          state.reasoningSpiralDetector.reset()
          state.textSpiralDetector.reset()
          state.nudgeCount = 0
          state.aborting = false
        }
        return
      }
    },

    tool: {
      loop_detector_stats: tool({
        description:
          "Query cumulative statistics of the loop-detector plugin: how many loops/spirals were detected and how many nudges/aborts were issued, broken down by detection type (loop/spiral) and source (reasoning/text). Set reset=true to reset all counters to zero.",
        args: {
          reset: tool.schema
            .boolean()
            .optional()
            .describe("If true, reset all counters to zero after returning current stats. Default: false."),
        },
        async execute(args) {
          if (args.reset) {
            stats = createEmptyStats()
            saveStats(statsPath, stats)
            log("Stats reset via loop_detector_stats tool")
            return { title: "Loop Detector Stats (reset)", output: formatStats(stats) }
          }
          return { title: "Loop Detector Stats", output: formatStats(stats) }
        },
      }),
    },

    dispose: async () => {
      for (const state of sessions.values()) {
        if (state.idleTimeout) clearTimeout(state.idleTimeout)
      }
      sessions.clear()
      sessionInfo.clear()
      log("Plugin disposed")
    },
  }
}

export default LoopDetector
