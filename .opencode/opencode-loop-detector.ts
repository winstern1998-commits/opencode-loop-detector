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
    | {
        type: "nudge"
        reminder: string
        period: number
        source: string
        detectionType: "loop" | "spiral"
        ratio?: number
        // Snapshot taken at detection time — the nudge's own promptAsync would
        // otherwise trigger createUserMessage→setAgentModel and rewrite the
        // session's agent record with the default agent.
        agent?: string
        modelRef?: { providerID: string; modelID: string }
        variant?: string
      }
    | { type: "abort"; period: number; attempts: number; source: string; detectionType: "loop" | "spiral"; ratio?: number }
    | null
  aborting: boolean
  // In-flight session.abort() promise; executePendingAction waits for it so the
  // nudge is not killed by the abort cascade (session.idle can arrive first).
  abortPromise: Promise<void> | null
  // Set when the abort wait timed out while the old abort promise was still in
  // flight: its eventual idle lands in the normal-reset branch and must not
  // wipe nudgeCount.
  pendingStaleIdle: boolean
  idleTimeout: ReturnType<typeof setTimeout> | null
  partTypes: Map<string, "reasoning" | "text">
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), ".loop-detector")
const LOG_FILE = join(LOG_DIR, "detector.log")
const TRIGGER_DIR = join(LOG_DIR, "triggers")
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
// Abort finalization measured ~2.2s; 5s is too tight for long streams / slow
// models. Worst-case nudge delay = IDLE_TIMEOUT_MS (5s) + ABORT_WAIT_MS (10s).
const ABORT_WAIT_MS = 10000
// Upper bound for the agent-recovery session.get lookup (skip path on timeout).
const SESSION_GET_TIMEOUT_MS = 5000
// Upper bound for the nudge promptAsync send. A hung send is treated as
// "dispatched, unconfirmed" and still counts toward the nudge budget (see
// executePendingAction) so it cannot cause an endless nudge storm.
const PROMPT_SEND_TIMEOUT_MS = 5000

/**
 * The server stores the literal variant "default" when no variant is set.
 * Normalize it to undefined so we never pass the literal through.
 */
function normalizeVariant(variant: string | undefined): string | undefined {
  return variant === "default" ? undefined : variant
}

const SPIRAL_REMINDER =
  "[Loop Detector] Repetitive reasoning detected (duplicate sentence ratio ~{ratio}%). " +
  "You are repeating the same plans without executing them. Stop planning and take a concrete action now."

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

  const sessionInfo = new Map<
    string,
    {
      title?: string
      model?: string
      agent?: string
      modelRef?: { providerID: string; modelID: string }
      variant?: string
    }
  >()

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
      abortPromise: null,
      pendingStaleIdle: false,
      idleTimeout: null,
      partTypes: new Map(),
    }
    sessions.set(sessionID, state)
    return state
  }

  // -------------------------------------------------------------------------
  // Interrupt/abort helper (SDK → HTTP fallback)
  //
  // Called with purpose="interrupt" to pause generation after a detection
  // (used by both nudge and abort paths), and with purpose="abort" only
  // when the plugin intends to terminate the session.
  // -------------------------------------------------------------------------

  async function abortSession(sessionID: string, purpose: "interrupt" | "abort" = "interrupt"): Promise<void> {
    const verb = purpose === "abort" ? "abort" : "interrupt generation"
    try {
      await client.session.abort({ path: { id: sessionID } })
      log(`[${sessLabel(sessionID)}] ${verb} succeeded via SDK`)
    } catch (err) {
      log(`[${sessLabel(sessionID)}] SDK ${verb} failed: ${String(err)}, trying HTTP fallback`)
      try {
        const resp = await fetch(`${serverUrl.origin}/session/${sessionID}/abort`, {
          method: "POST",
        })
        if (!resp.ok) {
          log(`[${sessLabel(sessionID)}] HTTP ${verb} returned ${resp.status}`)
        } else {
          log(`[${sessLabel(sessionID)}] ${verb} succeeded via HTTP fallback`)
        }
      } catch (err2) {
        log(`[${sessLabel(sessionID)}] HTTP ${verb} also failed: ${String(err2)}`)
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

    // Save trigger content snapshot to file
    try {
      const isSpiral = outcome.type === "spiral"
      const detType = isSpiral ? "spiral" : "loop"
      const detector =
        isSpiral
          ? (outcome.source === "reasoning" ? state.reasoningSpiralDetector : state.textSpiralDetector)
          : (outcome.source === "reasoning" ? state.reasoningDetector : state.textDetector)
      const content = detector.snapshot()

      const info = sessionInfo.get(sessionID)
      const ts = new Date().toISOString().replace(/[:.]/g, "-")
      const shortId = sessionID.replace(/^ses_/, "").slice(0, 12)
      const filename = `${ts}_${shortId}_${detType}_${outcome.source}.txt`
      mkdirSync(TRIGGER_DIR, { recursive: true })
      const header = [
        `=== Loop Detector Trigger ===`,
        `Time: ${new Date().toISOString()}`,
        `Session: ${sessionID}`,
        info?.title ? `Title: ${info.title}` : null,
        info?.model ? `Model: ${info.model}` : null,
        info?.agent ? `Agent: ${info.agent}` : null,
        `Type: ${detType}`,
        `Source: ${outcome.source}`,
        isSpiral ? `Ratio: ${(outcome as SpiralOutcome).ratio.toFixed(2)}` : `Period: ${(outcome as LoopOutcome).period}`,
        `Content length: ${content.length} chars`,
        ``,
        `--- Trigger Content ---`,
        ``,
      ].filter((x) => x !== null).join("\n")
      appendFileSync(join(TRIGGER_DIR, filename), header + content + "\n")
      log(`[${sessLabel(sessionID)}] trigger snapshot saved to ${filename}`)
    } catch (err) {
      log(`[${sessLabel(sessionID)}] trigger snapshot save failed: ${String(err)}`)
    }

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
      // Snapshot agent/model/variant before sending: a promptAsync without an
      // explicit agent makes createUserMessage fall back to the default agent
      // and permanently rewrite the session's agent record via setAgentModel.
      const info = sessionInfo.get(sessionID)
      if (!info?.agent) {
        log(`[${sessLabel(sessionID)}] nudge: no agent snapshot; will resolve via session.get or skip`)
      }
      state.pendingAction = {
        type: "nudge",
        reminder,
        period,
        source: outcome.source,
        detectionType: isSpiral ? "spiral" : "loop",
        ratio: isSpiral ? (outcome as SpiralOutcome).ratio : undefined,
        agent: info?.agent,
        modelRef: info?.modelRef,
        variant: info?.variant,
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

    // Interrupt current generation so the pending action can take over.
    // With a nudge decision this is only an interrupt (no session abort);
    // only an abort decision counts as a plugin-initiated abort.
    // Keep the promise on state: session.idle can arrive before the server-side
    // abort has settled, and executePendingAction must wait for it. Do NOT await
    // it here — the idle timeout must be armed unconditionally, otherwise a hung
    // abort call would leave the session muted forever.
    state.abortPromise = abortSession(sessionID, decision.action === "abort" ? "abort" : "interrupt")

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

    // session.idle can arrive before the server-side abort has fully settled;
    // starting a new generation in that window gets killed by the abort cascade
    // (0-token assistant message, MessageAbortedError). Wait for the in-flight
    // abort — bounded by ABORT_WAIT_MS — before executing the action.
    let abortWaitTimedOut = false
    const pendingAbort = state.abortPromise
    state.abortPromise = null
    if (pendingAbort) {
      let timer: ReturnType<typeof setTimeout> | null = null
      abortWaitTimedOut = await Promise.race([
        // Swallow rejection: abortSession catches internally, but never let an
        // unhandled rejection escape into the fire-and-forget event hook.
        pendingAbort.then(() => false, () => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), ABORT_WAIT_MS)
        }),
      ])
      if (timer) clearTimeout(timer)
      if (abortWaitTimedOut) {
        log(`[${sessLabel(sessionID)}] abort wait timed out after ${ABORT_WAIT_MS}ms, executing pending action`)
        // We proceed without the abort having settled. When it eventually does,
        // the server may publish a delayed idle that lands in the
        // normal-completion branch (pendingAction is already null, aborting will
        // be false) and would wipe nudgeCount. Flag it so that idle is consumed
        // without resetting. Premise: the timeout means the abort HTTP call is
        // still in flight — if it never settles there will be no stale idle.
        pendingAbort.then(
          () => {
            state.pendingStaleIdle = true
          },
          () => {},
        )
      }
    }

    if (action.type === "nudge") {
      const isSpiral = action.detectionType === "spiral"
      const title = isSpiral ? "Spiral Detected — Nudge" : "Loop Detected — Nudge"
      const detail = isSpiral
        ? ` (duplicate sentence ratio ~${Math.round((action.ratio ?? 0) * 100)}%)`
        : ` (period ~${action.period} chars)`

      // Resolve the agent/model for the nudge. A promptAsync without an explicit
      // agent makes createUserMessage fall back to the default agent and
      // permanently rewrite the session's agent record via setAgentModel — the
      // exact bug the snapshot exists to prevent. If the snapshot is missing,
      // look the session up; if that fails too, skip the nudge instead of
      // silently rewriting the session agent.
      let agent = action.agent
      let modelRef = action.modelRef
      let variant = action.variant
      let skipReason: string | null = null
      if (!agent) {
        try {
          // Bound the lookup: a hanging session.get must not stall the nudge
          // forever. On timeout the race rejects and lands in the skip path.
          let timer: ReturnType<typeof setTimeout> | null = null
          const res = await Promise.race([
            client.session.get({ path: { id: sessionID } }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`session.get timed out after ${SESSION_GET_TIMEOUT_MS}ms`)),
                SESSION_GET_TIMEOUT_MS,
              )
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          // The pinned SDK types lag behind the server's Session shape
          // (agent/model are returned at runtime), hence the cast.
          const info = res.data as unknown as
            | { agent?: string; model?: { id: string; providerID: string; variant?: string } }
            | undefined
          if (info?.agent) {
            agent = info.agent
            if (!modelRef && info.model) {
              modelRef = { providerID: info.model.providerID, modelID: info.model.id }
            }
            const recoveredVariant = normalizeVariant(info.model?.variant)
            if (!variant && recoveredVariant) variant = recoveredVariant
            log(`[${sessLabel(sessionID)}] nudge: recovered agent=${agent} from session.get`)
          } else {
            skipReason = "session record has no agent"
          }
        } catch (err) {
          skipReason = `session.get failed: ${String(err)}`
        }
      }

      let sent = false
      let sendTimedOut = false
      if (skipReason) {
        log(`[${sessLabel(sessionID)}] nudge skipped (${skipReason}); refusing to send without an agent`)
      } else {
        try {
          // The message is intentionally not synthetic, so both the model and
          // the user see it. metadata.source marks it as plugin-injected for
          // other consumers (E2E detection, user-activity checks).
          // `variant` is not in the pinned SDK types yet, hence the typed local.
          const body: {
            parts: Array<{ type: "text"; text: string; metadata: { [key: string]: unknown } }>
            agent?: string
            model?: { providerID: string; modelID: string }
            variant?: string
          } = {
            parts: [{ type: "text", text: action.reminder, metadata: { source: "loop-detector" } }],
          }
          // skipReason guarantees an agent is available on this branch
          body.agent = agent!
          if (modelRef) body.model = modelRef
          if (variant) body.variant = variant
          // Bound the send: a hung promptAsync must not keep aborting=true and
          // block state migration. A race timeout is treated as "dispatched,
          // unconfirmed" and still counts toward the nudge budget (same
          // trade-off as the abort-wait timeout: no endless nudge storm).
          const guardedSend = client.session.promptAsync({ path: { id: sessionID }, body }).then(
            () => {},
            (err) => {
              throw err
            },
          )
          // Swallow a late rejection if the timeout branch wins the race
          guardedSend.catch(() => {})
          let sendTimer: ReturnType<typeof setTimeout> | null = null
          try {
            await Promise.race([
              guardedSend,
              new Promise<void>((resolve) => {
                sendTimer = setTimeout(() => {
                  sendTimedOut = true
                  resolve()
                }, PROMPT_SEND_TIMEOUT_MS)
              }),
            ])
          } finally {
            if (sendTimer) clearTimeout(sendTimer)
          }
          sent = true
        } catch (err) {
          // Send failed: do not consume the nudge budget.
          log(`[${sessLabel(sessionID)}] promptAsync failed: ${String(err)}`)
        }
      }

      if (sent) {
        // Count resolved and timed-out sends (the message was dispatched and may
        // be in the session history); a rejection does not consume the budget.
        state.nudgeCount++
        recordStat(stats, action.detectionType as DetectionType, action.source as Source, "nudge")
        saveStats(statsPath, stats)
        log(
          `[${sessLabel(sessionID)}] nudge sent (nudgeCount=${state.nudgeCount}, agent=${agent}` +
            `${abortWaitTimedOut ? ", abort wait timed out" : ""}` +
            `${sendTimedOut ? ", promptAsync timed out (counted)" : ""})`,
        )
      }

      // State machine ready before any (not awaited) UI work: a hanging toast
      // must not keep the session muted.
      state.reasoningDetector.reset()
      state.textDetector.reset()
      state.reasoningSpiralDetector.reset()
      state.textSpiralDetector.reset()
      state.aborting = false

      if (skipReason) {
        void client.tui
          .showToast({
            body: {
              title: isSpiral ? "Spiral Detected — Nudge Skipped" : "Loop Detected — Nudge Skipped",
              message: `Repetitive ${action.source} output detected${detail}. Reminder skipped: session agent unknown; sending it would rewrite the session agent.`,
              variant: "error",
            },
          })
          .catch((err) => log(`[${sessLabel(sessionID)}] showToast (nudge skipped) failed: ${String(err)}`))
      } else if (sent) {
        // Toast only after the send, so its wording reflects the actual outcome.
        // On the timeout branch the session may still be aborting and the
        // reminder can be discarded — say so instead of claiming success.
        void client.tui
          .showToast({
            body: {
              title,
              message: abortWaitTimedOut
                ? `Repetitive ${action.source} output detected${detail}. Reminder sent while the session is still aborting; it may not take effect.`
                : `Repetitive ${action.source} output detected${detail}. Reminder sent to redirect.`,
              variant: abortWaitTimedOut ? "error" : "warning",
            },
          })
          .catch((err) => log(`[${sessLabel(sessionID)}] showToast (nudge) failed: ${String(err)}`))
      }
    } else {
      // abort path — final termination
      const isSpiral = action.detectionType === "spiral"
      const title = isSpiral ? "Spiral Detected" : "Loop Detected"
      const detail = isSpiral
        ? ` (duplicate sentence ratio ~${Math.round((action.ratio ?? 0) * 100)}%)`
        : ` (period ~${action.period} chars)`
      log(`[${sessLabel(sessionID)}] final abort, cleaning up session state`)
      recordStat(stats, action.detectionType as DetectionType, action.source as Source, "abort")
      saveStats(statsPath, stats)
      // Cleanup before the (not awaited) toast: a hanging toast must not keep
      // the terminated session state alive.
      sessions.delete(sessionID)
      void client.tui
        .showToast({
          body: {
            title,
            message: `Repetitive ${action.source} output detected${detail} after ${action.attempts} attempt(s). Session aborted.`,
            variant: "warning",
          },
        })
        .catch((err) => log(`[${sessLabel(sessionID)}] showToast (abort) failed: ${String(err)}`))
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
          sessionID?: string
          info?: {
            id?: string
            title?: string
            model?: { id: string; providerID: string; variant?: string }
            agent?: string
          }
        }
        // Use info.id as the authoritative session ID (top-level sessionID may be
        // absent or unreliable in some opencode event delivery paths).
        const sid = props.info?.id ?? props.sessionID
        if (sid && props.info) {
          const prev = sessionInfo.get(sid)
          const modelRef = props.info.model
            ? { providerID: props.info.model.providerID, modelID: props.info.model.id }
            : undefined
          const newModel = modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : undefined
          // Debug: log when model changes for an existing session (helps diagnose
          // cross-session contamination)
          if (prev?.model && prev.model !== newModel) {
            log(`[${sessLabel(sid)}] session model changed: ${prev.model} -> ${newModel}`)
          }
          sessionInfo.set(sid, {
            title: props.info.title,
            model: newModel,
            agent: props.info.agent,
            modelRef,
            variant: normalizeVariant(props.info.model?.variant),
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
        } else if (!state.aborting) {
          if (state.pendingStaleIdle) {
            // A timed-out abort can settle after we already proceeded; the
            // server's delayed idle lands here and must not wipe nudgeCount.
            // Consume the flag and skip this reset (the next normal idle resets).
            state.pendingStaleIdle = false
            log(`[${sessLabel(sessionID)}] stale session.idle ignored after abort wait timeout`)
          } else {
            // Normal completion — reset detectors and counters
            state.reasoningDetector.reset()
            state.textDetector.reset()
            state.reasoningSpiralDetector.reset()
            state.textSpiralDetector.reset()
            state.nudgeCount = 0
            state.aborting = false
          }
        } else {
          // Stale idle: a second idle can land while executePendingAction is
          // waiting for the abort (pendingAction already cleared, aborting still
          // true — e.g. runner cancel racing natural completion). Resetting here
          // would wipe nudgeCount and break the nudge → abort escalation.
          log(`[${sessLabel(sessionID)}] stale session.idle ignored while action in flight`)
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
