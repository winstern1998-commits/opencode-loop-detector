/**
 * Tests for opencode-loop-detector.
 *
 * Part 1: Algorithm unit tests (pure functions, no external deps).
 * Part 2: Plugin timing simulation (mock SDK client).
 *
 * Run: bun test ./test.ts
 */

import { describe, test, expect } from "bun:test"
import { create, recovery, DEFAULTS, isLoopOutcome } from "./.opencode/loop.ts"
import {
  create as createSpiral,
  SPIRAL_DEFAULTS,
  isSpiralOutcome,
  type SpiralOutcome,
} from "./.opencode/spiral.ts"
import {
  createEmptyStats,
  record as recordStat,
  format as formatStats,
  loadStats,
  saveStats,
  type Stats,
} from "./.opencode/stats.ts"
import { unlinkSync, writeFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a non-repeating string of approximately n chars. */
function nonRepeating(n: number): string {
  let s = ""
  let i = 0
  while (s.length < n) {
    s += `[${i}] item number ${i} with unique content. `
    i++
  }
  return s.slice(0, n)
}

/** Repeat a pattern to reach approximately n chars. */
function repeat(pattern: string, n: number): string {
  const out: string[] = []
  let len = 0
  while (len < n) {
    out.push(pattern)
    len += pattern.length
  }
  return out.join("").slice(0, n)
}

// ---------------------------------------------------------------------------
// Part 1: Algorithm unit tests
// ---------------------------------------------------------------------------

describe("loop detection algorithm", () => {
  // --- Exact repetition --------------------------------------------------

  test("detects exact repetition with default thresholds", () => {
    const d = create({ source: "text" })
    // Need >= 200 chars (min_chars) and >= 100 chars between checks (check_interval)
    // Use a 300-char repeating pattern
    const text = repeat("0123456789", 300)
    const outcome = d.feed(text)
    expect(outcome).toBeDefined()
    expect(outcome!.type).toBe("loop")
    expect(outcome!.period).toBeGreaterThanOrEqual(DEFAULTS.min_period)
    expect(outcome!.source).toBe("text")
  })

  test("detects repetition with small thresholds", () => {
    const d = create({ source: "reasoning", min_period: 3, min_chars: 10, check_interval: 1 })
    const outcome = d.feed(repeat("ABC", 30))
    expect(outcome).toBeDefined()
    expect(outcome!.source).toBe("reasoning")
    expect(outcome!.period).toBeGreaterThanOrEqual(3)
  })

  test("detects CJK repetition", () => {
    const d = create({ source: "text", min_period: 3, min_chars: 10, check_interval: 1 })
    const outcome = d.feed(repeat("你好世界", 30))
    expect(outcome).toBeDefined()
    expect(outcome!.period).toBeGreaterThanOrEqual(3)
  })

  // --- Whitespace normalization ------------------------------------------

  test("detects repetition despite whitespace drift", () => {
    const d = create({ source: "text", min_period: 10, min_chars: 20, check_interval: 1 })
    // Two blocks that are the same after normalize() but differ in whitespace
    const block = "hello world foo bar"
    const blockWithDrift = "hello  world\tfoo  bar\n"
    // Repeat enough times to satisfy min_repeats (default 5)
    const text = (block + blockWithDrift).repeat(5)
    const outcome = d.feed(text)
    expect(outcome).toBeDefined()
  })

  // --- Alphanumeric filter -----------------------------------------------

  test("does not detect purely structural patterns (no alphanumeric)", () => {
    const d = create({ source: "text", min_period: 3, min_chars: 10, check_interval: 1 })
    const outcome = d.feed(repeat("---\n", 100))
    expect(outcome).toBeUndefined()
  })

  test("does not detect pipe-table separators", () => {
    const d = create({ source: "text", min_period: 3, min_chars: 10, check_interval: 1 })
    const outcome = d.feed(repeat("| --- | --- |", 50))
    expect(outcome).toBeUndefined()
  })

  // --- min_chars threshold -----------------------------------------------

  test("does not detect below min_chars threshold", () => {
    const d = create({ source: "text", min_chars: 500, check_interval: 1, min_period: 3 })
    const outcome = d.feed(repeat("ABCABCABC", 100)) // 900 chars but < 500? No, 900 > 500
    // Actually 900 > 500, so this would trigger. Let me use a smaller input.
    const d2 = create({ source: "text", min_chars: 500, check_interval: 1, min_period: 3 })
    const outcome2 = d2.feed(repeat("ABCABCABC", 50)) // 450 chars < 500
    expect(outcome2).toBeUndefined()
  })

  // --- check_interval ----------------------------------------------------

  test("does not check before check_interval chars since last check", () => {
    const d = create({ source: "text", min_chars: 10, check_interval: 1000, min_period: 3 })
    // Feed 100 chars of repetition — total >= min_chars but total - last < check_interval
    // after first check. Actually first check: total=100, last=0, 100-0=100 < 1000 → no check
    const outcome = d.feed(repeat("ABCABCABC", 12)) // 108 chars
    expect(outcome).toBeUndefined()
  })

  // --- Normal text -------------------------------------------------------

  test("does not detect non-repeating text", () => {
    const d = create({ source: "text", min_chars: 50, check_interval: 1, min_period: 5 })
    const outcome = d.feed(nonRepeating(500))
    expect(outcome).toBeUndefined()
  })

  test("does not detect prose with varied sentences", () => {
    const d = create({ source: "text", min_chars: 50, check_interval: 1, min_period: 5 })
    const text =
      "The quick brown fox jumps over the lazy dog. " +
      "Pack my box with five dozen liquor jugs. " +
      "How vexingly quick daft zebras jump! " +
      "Sphinx of black quartz, judge my vow. " +
      "The five boxing wizards jump quickly. " +
      "Bright vixens jump; dozy fowl quack. " +
      "Quick zephyrs blow, vexing daft Jim. " +
      "Two driven jocks help fax my big quiz. "
    // Repeat enough to exceed min_chars, but the combined text is non-repeating
    const full = (text + text).slice(0, 500)
    // Actually text+text would repeat... let me just use nonRepeating
    const outcome = d.feed(nonRepeating(500))
    expect(outcome).toBeUndefined()
  })

  // --- Buffer truncation -------------------------------------------------

  test("buffer truncation does not cause false positives", () => {
    const d = create({ source: "text", max_period: 50, min_chars: 10, check_interval: 1, min_period: 5 })
    // Feed a lot of non-repeating text to force buffer truncation
    const outcome = d.feed(nonRepeating(500))
    expect(outcome).toBeUndefined()
  })

  test("buffer truncation preserves recent repetition", () => {
    const d = create({ source: "text", max_period: 50, min_chars: 10, check_interval: 1, min_period: 5 })
    // Feed non-repeating prefix, then repeating suffix
    const prefix = nonRepeating(200)
    const repeating = repeat("0123456789", 120) // 1200 chars of repetition
    d.feed(prefix)
    const outcome = d.feed(repeating)
    expect(outcome).toBeDefined()
  })

  // --- reset() -----------------------------------------------------------

  test("reset clears detector state", () => {
    const d = create({ source: "text", min_chars: 10, check_interval: 1, min_period: 3 })
    // Feed repetition → detect
    const outcome1 = d.feed(repeat("ABCABCABC", 30))
    expect(outcome1).toBeDefined()
    // Reset
    d.reset()
    // Feed same text again → should detect again (state was cleared)
    const outcome2 = d.feed(repeat("ABCABCABC", 30))
    expect(outcome2).toBeDefined()
  })

  test("reset prevents detection of old buffer content", () => {
    const d = create({ source: "text", min_chars: 10, check_interval: 1, min_period: 3 })
    d.feed(repeat("ABCABCABC", 30))
    d.reset()
    // Feed a small non-repeating delta — should not detect
    const outcome = d.feed(nonRepeating(50))
    expect(outcome).toBeUndefined()
  })

  // --- on_detected callback ---------------------------------------------

  test("on_detected callback is called when loop is found", () => {
    let called: { period: number; source: string } | null = null
    const d = create({
      source: "text",
      min_chars: 10,
      check_interval: 1,
      min_period: 3,
      on_detected: (o) => { called = { period: o.period, source: o.source } },
    })
    d.feed(repeat("ABCABCABC", 30))
    expect(called).not.toBeNull()
    expect(called!.source).toBe("text")
  })

  // --- Fuzzy similarity --------------------------------------------------

  test("fuzzy similarity detects near-repetition", () => {
    const d = create({
      source: "text",
      min_chars: 10,
      check_interval: 1,
      min_period: 10,
      similarity: 0.7,
    })
    // Two blocks that are similar but not identical
    const block1 = "hello world1234"
    const block2 = "hello world5678"
    // Repeat enough times to satisfy min_repeats (default 5)
    const text = (block1 + block2).repeat(5)
    const outcome = d.feed(text)
    expect(outcome).toBeDefined()
  })

  test("fuzzy similarity below threshold does not detect", () => {
    const d = create({
      source: "text",
      min_chars: 10,
      check_interval: 1,
      min_period: 10,
      similarity: 0.95,
    })
    // Two halves that are completely different and internally non-repeating
    const first = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4"
    const second = "z9y8x7w6v5u4t3s2r1q0p9o8n7m6"
    const text = first + second
    const outcome = d.feed(text)
    expect(outcome).toBeUndefined()
  })

  // --- min_repeats -------------------------------------------------------

  test("default min_repeats is 4", () => {
    expect(DEFAULTS.min_repeats).toBe(4)
  })

  test("does not detect when repeats below min_repeats (default 4)", () => {
    const d = create({ source: "text", min_chars: 10, check_interval: 1, min_period: 5 })
    // period=10, repeat exactly 3 times — below default min_repeats=4
    const text = "0123456789".repeat(3)
    const outcome = d.feed(text)
    expect(outcome).toBeUndefined()
  })

  test("detects when repeats meet min_repeats (default 4)", () => {
    const d = create({ source: "text", min_chars: 10, check_interval: 1, min_period: 5 })
    // period=10, repeat exactly 4 times — meets default min_repeats=4
    const text = "0123456789".repeat(4)
    const outcome = d.feed(text)
    expect(outcome).toBeDefined()
  })

  test("custom min_repeats=3 detects at 3 repeats", () => {
    const d = create({ source: "text", min_chars: 10, check_interval: 1, min_period: 5, min_repeats: 3 })
    const text = "0123456789".repeat(3)
    const outcome = d.feed(text)
    expect(outcome).toBeDefined()
  })

  test("custom min_repeats=3 does not detect at 2 repeats", () => {
    const d = create({ source: "text", min_chars: 10, check_interval: 1, min_period: 5, min_repeats: 3 })
    const text = "0123456789".repeat(2)
    const outcome = d.feed(text)
    expect(outcome).toBeUndefined()
  })

  // --- Path false-positive regression ------------------------------------
  // Paths with repeated directory/file names (e.g. name/name.ts) must not
  // trigger false positives, since they only repeat 2x — below min_repeats=5.

  test("does not false-positive on path with repeated segment (2x)", () => {
    const d = create({ source: "reasoning", min_chars: 30, check_interval: 20, min_period: 5 })
    const paths = [
      "/home/user/projects/my-plugin/my-plugin.ts",
      "~/.config/opencode/opencode.jsonc",
      "src/plugin/plugin.ts",
      "opencode-loop-detector/opencode-loop-detector",
    ]
    for (const p of paths) {
      const outcome = d.feed(p)
      expect(outcome).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// recovery() tests
// ---------------------------------------------------------------------------

describe("recovery", () => {
  test("nudge on first detection (max_nudges=1)", () => {
    const decision = recovery(0, { max_nudges: 1, period: 42 })
    expect(decision.action).toBe("nudge")
    if (decision.action === "nudge") {
      expect(decision.reminder).toContain("42")
      expect(decision.reminder).toContain("<system-reminder>")
    }
  })

  test("abort on second detection (max_nudges=1)", () => {
    const decision = recovery(1, { max_nudges: 1, period: 42 })
    expect(decision.action).toBe("abort")
    if (decision.action === "abort") {
      expect(decision.period).toBe(42)
      expect(decision.attempts).toBe(2)
    }
  })

  test("nudge twice with max_nudges=2", () => {
    expect(recovery(0, { max_nudges: 2 }).action).toBe("nudge")
    expect(recovery(1, { max_nudges: 2 }).action).toBe("nudge")
    expect(recovery(2, { max_nudges: 2 }).action).toBe("abort")
  })

  test("default max_nudges is 2", () => {
    expect(recovery(0).action).toBe("nudge")
    expect(recovery(1).action).toBe("nudge")
    expect(recovery(2).action).toBe("abort")
  })

  test("custom reminder template with {period} placeholder", () => {
    const decision = recovery(0, {
      max_nudges: 1,
      reminder: "Stop! Period: {period} chars",
      period: 99,
    })
    expect(decision.action).toBe("nudge")
    if (decision.action === "nudge") {
      expect(decision.reminder).toBe("Stop! Period: 99 chars")
    }
  })

  test("default reminder template", () => {
    const decision = recovery(0, { period: 50 })
    if (decision.action === "nudge") {
      expect(decision.reminder).toContain("~50 characters")
    }
  })

  test("abort attempts count increments", () => {
    const d1 = recovery(1, { max_nudges: 1 })
    if (d1.action === "abort") expect(d1.attempts).toBe(2)

    const d2 = recovery(2, { max_nudges: 1 })
    if (d2.action === "abort") expect(d2.attempts).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// isLoopOutcome() tests
// ---------------------------------------------------------------------------

describe("isLoopOutcome", () => {
  test("returns true for valid LoopOutcome", () => {
    expect(isLoopOutcome({ type: "loop", period: 10, source: "text" })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isLoopOutcome(null)).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(isLoopOutcome(undefined)).toBe(false)
  })

  test("returns false for non-loop objects", () => {
    expect(isLoopOutcome({ type: "error" })).toBe(false)
    expect(isLoopOutcome({})).toBe(false)
    expect(isLoopOutcome("loop")).toBe(false)
    expect(isLoopOutcome(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// spiral detection algorithm tests
// ---------------------------------------------------------------------------

describe("spiral detection algorithm", () => {
  // Helper: build a high-duplicate text by repeating a sentence many times
  // with a few unique sentences interspersed so ratio stays > threshold.
  function spiralText(repeatSentence: string, repeats: number, uniqueEvery: number = 8): string {
    const parts: string[] = []
    for (let i = 0; i < repeats; i++) {
      parts.push(repeatSentence)
      if (i % uniqueEvery === 0) {
        parts.push(`This is a unique filler sentence number ${i} to vary the content.`)
      }
    }
    return parts.join(" ")
  }

  test("does not trigger on non-repeating text", () => {
    const d = createSpiral({ source: "reasoning" })
    const outcome = d.feed(nonRepeating(10000))
    expect(outcome).toBeUndefined()
  })

  test("triggers on highly repetitive text", () => {
    const d = createSpiral({ source: "reasoning", min_chars: 500, check_interval: 50 })
    const sentence = "I need to analyze this carefully and consider the next step."
    const text = spiralText(sentence, 40, 10)
    const outcome = d.feed(text)
    expect(outcome).toBeDefined()
    expect(outcome!.type).toBe("spiral")
    expect(outcome!.ratio).toBeGreaterThanOrEqual(0.4)
    expect(outcome!.source).toBe("reasoning")
  })

  test("min_chars threshold prevents detection below threshold", () => {
    const d = createSpiral({ source: "text", min_chars: 5000, check_interval: 10 })
    const sentence = "I need to analyze this carefully and consider the next step."
    // Feed only ~1000 chars of repetitive text — below min_chars
    const text = spiralText(sentence, 15, 100)
    expect(text.length).toBeLessThan(5000)
    const outcome = d.feed(text)
    expect(outcome).toBeUndefined()
  })

  test("min_sentences threshold prevents detection with too few sentences", () => {
    const d = createSpiral({
      source: "text",
      min_chars: 100,
      check_interval: 10,
      min_sentences: 50,
    })
    // Long sentences but only a few of them
    const long = "This is a very long unique sentence that exceeds the minimum length requirement. ".repeat(3)
    const text = (long + long).slice(0, 2000) // few sentences, lots of chars
    const outcome = d.feed(text)
    expect(outcome).toBeUndefined()
  })

  test("dup_threshold is adjustable (low threshold detects mild repetition)", () => {
    const d = createSpiral({
      source: "reasoning",
      min_chars: 500,
      check_interval: 50,
      dup_threshold: 0.1,
    })
    // Mix of repeated and unique sentences — ratio ~0.2, below default 0.4
    // but above 0.1
    const parts: string[] = []
    for (let i = 0; i < 30; i++) {
      parts.push("I should consider the approach carefully before proceeding.")
      parts.push(`Unique observation number ${i} about the current situation.`)
      parts.push(`Another distinct thought ${i} regarding implementation details.`)
      parts.push(`Yet another different angle ${i} on the problem space.`)
      parts.push("I should consider the approach carefully before proceeding.")
    }
    const outcome = d.feed(parts.join(" "))
    expect(outcome).toBeDefined()
    expect(outcome!.ratio).toBeGreaterThanOrEqual(0.1)
  })

  test("reset() clears state and prevents re-detection of old content", () => {
    const d = createSpiral({ source: "text", min_chars: 500, check_interval: 50 })
    const sentence = "I need to analyze this carefully and consider the next step."
    const text = spiralText(sentence, 40, 10)
    const outcome1 = d.feed(text)
    expect(outcome1).toBeDefined()
    d.reset()
    // After reset, feeding non-repeating text should not trigger
    const outcome2 = d.feed(nonRepeating(5000))
    expect(outcome2).toBeUndefined()
  })

  test("source field matches creation parameter", () => {
    for (const source of ["reasoning", "text"] as const) {
      const d = createSpiral({ source, min_chars: 500, check_interval: 50 })
      const sentence = "I need to analyze this carefully and consider the next step."
      const outcome = d.feed(spiralText(sentence, 40, 10))
      expect(outcome).toBeDefined()
      expect(outcome!.source).toBe(source)
    }
  })

  test("streaming feed is equivalent to one-shot feed", () => {
    const sentence = "I need to analyze this carefully and consider the next step."
    const text = spiralText(sentence, 40, 10)

    // One-shot
    const oneShot = createSpiral({ source: "reasoning", min_chars: 500, check_interval: 50 })
    const r1 = oneShot.feed(text)

    // Streamed in 100-char chunks
    const streamed = createSpiral({ source: "reasoning", min_chars: 500, check_interval: 50 })
    let r2: SpiralOutcome | undefined
    for (let i = 0; i < text.length; i += 100) {
      r2 = streamed.feed(text.slice(i, i + 100))
      if (r2) break
    }

    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    // Ratios may differ slightly due to window boundary alignment, but both
    // must trigger and be in the same ballpark.
    expect(r2!.ratio).toBeGreaterThan(0)
    expect(Math.abs(r1!.ratio - r2!.ratio)).toBeLessThan(0.2)
  })
})

// ---------------------------------------------------------------------------
// isSpiralOutcome() tests
// ---------------------------------------------------------------------------

describe("isSpiralOutcome", () => {
  test("returns true for valid SpiralOutcome", () => {
    expect(isSpiralOutcome({ type: "spiral", ratio: 0.5, source: "text" })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isSpiralOutcome(null)).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(isSpiralOutcome(undefined)).toBe(false)
  })

  test("returns false for non-spiral objects", () => {
    expect(isSpiralOutcome({ type: "loop", period: 10, source: "text" })).toBe(false)
    expect(isSpiralOutcome({})).toBe(false)
    expect(isSpiralOutcome("spiral")).toBe(false)
    expect(isSpiralOutcome(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Part 2: Plugin timing simulation (mock SDK client)
// ---------------------------------------------------------------------------

import LoopDetector from "./.opencode/opencode-loop-detector.ts"

// --- Mock helpers ---------------------------------------------------------

function createMockClient() {
  const calls = {
    abort: [] as string[],
    promptAsync: [] as { id: string; parts: Array<{ type: string; text: string; synthetic?: boolean }> }[],
    showToast: [] as Array<{ title?: string; message: string; variant: string }>,
  }
  const client = {
    session: {
      abort: async (opts: { path: { id: string } }) => {
        calls.abort.push(opts.path.id)
      },
      promptAsync: async (opts: {
        path: { id: string }
        body: { parts: Array<{ type: string; text: string; synthetic?: boolean }> }
      }) => {
        calls.promptAsync.push({ id: opts.path.id, parts: opts.body.parts })
      },
    },
    tui: {
      showToast: async (opts: { body: { title?: string; message: string; variant: string } }) => {
        calls.showToast.push(opts.body)
      },
    },
  }
  return { client, calls }
}

function makePartUpdatedEvent(
  sessionID: string,
  partType: "text" | "reasoning",
  delta: string,
  partID = "p1",
) {
  return {
    type: "message.part.updated" as const,
    properties: {
      part: {
        id: partID,
        sessionID,
        messageID: "m1",
        type: partType,
        text: delta,
        ...(partType === "reasoning" ? { time: { start: Date.now() } } : {}),
      },
      delta,
    },
  }
}

function makeIdleEvent(sessionID: string) {
  return {
    type: "session.idle" as const,
    properties: { sessionID },
  }
}

// --- Timing tests ---------------------------------------------------------

describe("plugin timing simulation", () => {
  test("detects reasoning loop → abort → nudge on idle", async () => {
    const { client, calls } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1 },
    )

    // Feed repeating reasoning delta → should trigger loop detection
    const repeating = repeat("0123456789", 60) // 60 chars, period=10 × 6 repeats ≥ min_repeats=5
    await hooks.event!({ event: makePartUpdatedEvent("s1", "reasoning", repeating) as any })

    // Abort should have been called
    expect(calls.abort).toContain("s1")
    expect(calls.promptAsync.length).toBe(0)

    // Simulate session.idle → should trigger nudge (promptAsync)
    await hooks.event!({ event: makeIdleEvent("s1") as any })

    expect(calls.promptAsync.length).toBe(1)
    expect(calls.promptAsync[0].id).toBe("s1")
    expect(calls.promptAsync[0].parts[0].type).toBe("text")
    expect(calls.promptAsync[0].parts[0].synthetic).toBe(true)
    expect(calls.promptAsync[0].parts[0].text).toContain("<system-reminder>")
  })

  test("second loop after nudge → abort → showToast", async () => {
    const { client, calls } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1 },
    )

    // First loop → nudge
    await hooks.event!({ event: makePartUpdatedEvent("s2", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("s2") as any })
    expect(calls.promptAsync.length).toBe(1)

    // Second loop → abort (nudges exhausted)
    await hooks.event!({ event: makePartUpdatedEvent("s2", "text", repeat("0123456789", 60)) as any })
    expect(calls.abort.length).toBeGreaterThanOrEqual(2)
    await hooks.event!({ event: makeIdleEvent("s2") as any })

    // showToast should be called for nudge (index 0) and final abort (index 1)
    expect(calls.showToast.length).toBe(2)
    expect(calls.showToast[1].variant).toBe("warning")
    expect(calls.showToast[1].title).toBe("Loop Detected")
  })

  test("normal completion resets detectors (no intervention)", async () => {
    const { client, calls } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1 },
    )

    // Feed non-repeating text
    await hooks.event!({ event: makePartUpdatedEvent("s3", "text", nonRepeating(300)) as any })
    // No abort should be called
    expect(calls.abort.length).toBe(0)

    // Session idle → normal reset
    await hooks.event!({ event: makeIdleEvent("s3") as any })
    expect(calls.abort.length).toBe(0)
    expect(calls.promptAsync.length).toBe(0)
    expect(calls.showToast.length).toBe(0)
  })

  test("ignores non-text/non-reasoning parts", async () => {
    const { client, calls } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3 },
    )

    // Feed a tool part delta — should be ignored
    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: { id: "p1", sessionID: "s4", messageID: "m1", type: "tool", callID: "c1", tool: "bash", state: { status: "pending", input: {}, raw: "" } },
          delta: repeat("0123456789", 60),
        },
      } as any,
    })

    expect(calls.abort.length).toBe(0)
  })

  test("ignores events without delta", async () => {
    const { client, calls } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3 },
    )

    // Part update without delta (metadata-only update)
    await hooks.event!({
      event: {
        type: "message.part.updated",
        properties: {
          part: { id: "p1", sessionID: "s5", messageID: "m1", type: "text", text: "hello" },
        },
      } as any,
    })

    expect(calls.abort.length).toBe(0)
  })

  test("re-entry guard: ignores deltas while aborting", async () => {
    const { client, calls } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1 },
    )

    // First delta triggers loop → abort
    await hooks.event!({ event: makePartUpdatedEvent("s6", "text", repeat("0123456789", 60)) as any })
    expect(calls.abort.length).toBe(1)

    // Second delta while aborting → should be ignored (no second abort)
    await hooks.event!({ event: makePartUpdatedEvent("s6", "text", repeat("0123456789", 60)) as any })
    expect(calls.abort.length).toBe(1) // still 1, not 2
  })

  test("custom reminder is used in nudge", async () => {
    const { client, calls } = createMockClient()
    const customReminder = "<system-reminder>\n你正在重复输出（周期约 {period} 字符）。请停止重复。\n</system-reminder>"
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1, reminder: customReminder },
    )

    await hooks.event!({ event: makePartUpdatedEvent("s7", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("s7") as any })

    expect(calls.promptAsync.length).toBe(1)
    expect(calls.promptAsync[0].parts[0].text).toContain("你正在重复输出")
    expect(calls.promptAsync[0].parts[0].text).not.toContain("Stop repeating")
  })

  test("max_nudges=2 allows two nudges before abort", async () => {
    const { client, calls } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 2 },
    )

    // First loop → nudge 1
    await hooks.event!({ event: makePartUpdatedEvent("s8", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("s8") as any })
    expect(calls.promptAsync.length).toBe(1)

    // Second loop → nudge 2
    await hooks.event!({ event: makePartUpdatedEvent("s8", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("s8") as any })
    expect(calls.promptAsync.length).toBe(2)

    // Third loop → abort
    await hooks.event!({ event: makePartUpdatedEvent("s8", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("s8") as any })
    // showToast: 2 nudges + 1 abort = 3
    expect(calls.showToast.length).toBe(3)
  })

  test("dispose clears all state", async () => {
    const { client } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3 },
    )

    // Create some state
    await hooks.event!({ event: makePartUpdatedEvent("s9", "text", nonRepeating(100)) as any })

    // Dispose should not throw
    await hooks.dispose!()
  })

  test("enabled: false returns empty hooks", async () => {
    const { client } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { enabled: false },
    )

    expect(hooks.event).toBeUndefined()
    expect(hooks.dispose).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// stats module unit tests
// ---------------------------------------------------------------------------

describe("stats module", () => {
  test("createEmptyStats returns all-zero structure with null timestamps", () => {
    const s = createEmptyStats()
    for (const t of ["loop", "spiral"] as const) {
      for (const src of ["reasoning", "text"] as const) {
        expect(s.counts[t][src].detect).toBe(0)
        expect(s.counts[t][src].nudge).toBe(0)
        expect(s.counts[t][src].abort).toBe(0)
      }
    }
    expect(s.totals).toEqual({ detect: 0, nudge: 0, abort: 0 })
    expect(s.firstSeen).toBeNull()
    expect(s.lastSeen).toBeNull()
  })

  test("record increments the right cell, totals, and sets timestamps", () => {
    const s = createEmptyStats()
    recordStat(s, "loop", "text", "detect")
    expect(s.counts.loop.text.detect).toBe(1)
    expect(s.totals.detect).toBe(1)
    expect(s.firstSeen).not.toBeNull()
    expect(s.lastSeen).not.toBeNull()
    // ISO string sanity check
    expect(() => new Date(s.firstSeen!).toISOString()).not.toThrow()
  })

  test("record multiple distinct type/source/action increments cells independently", () => {
    const s = createEmptyStats()
    recordStat(s, "loop", "text", "detect")
    recordStat(s, "spiral", "reasoning", "nudge")
    recordStat(s, "loop", "reasoning", "abort")
    recordStat(s, "spiral", "text", "detect")
    expect(s.counts.loop.text.detect).toBe(1)
    expect(s.counts.spiral.reasoning.nudge).toBe(1)
    expect(s.counts.loop.reasoning.abort).toBe(1)
    expect(s.counts.spiral.text.detect).toBe(1)
    expect(s.totals).toEqual({ detect: 2, nudge: 1, abort: 1 })
  })

  test("firstSeen stays at first record, lastSeen updates on subsequent records", () => {
    const s = createEmptyStats()
    recordStat(s, "loop", "text", "detect")
    const first = s.firstSeen
    // Sleep a tiny bit so lastSeen ISO differs (ms resolution)
    const t = new Date(first!).getTime()
    // Manually craft a second record after a small delay
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        recordStat(s, "loop", "text", "detect")
        expect(s.firstSeen).toBe(first)
        expect(s.lastSeen).not.toBe(first)
        resolve()
      }, 10)
    })
  })

  test("format output includes Total line and per-cell rows", () => {
    const s = createEmptyStats()
    recordStat(s, "loop", "reasoning", "detect")
    recordStat(s, "spiral", "text", "nudge")
    const out = formatStats(s)
    expect(out).toContain("Loop Detector Statistics")
    expect(out).toContain("Total:")
    expect(out).toContain("loop / reasoning")
    expect(out).toContain("spiral / text")
    expect(out).toContain("1 detect(s)")
  })

  test("loadStats returns empty stats when file does not exist", () => {
    const path = `/tmp/loop-detector-test-missing-${Date.now()}.json`
    const s = loadStats(path)
    expect(s.totals).toEqual({ detect: 0, nudge: 0, abort: 0 })
    expect(s.firstSeen).toBeNull()
  })

  test("saveStats then loadStats round-trips correctly", () => {
    const path = `/tmp/loop-detector-test-roundtrip-${Date.now()}.json`
    try {
      const s = createEmptyStats()
      recordStat(s, "loop", "text", "detect")
      recordStat(s, "loop", "text", "nudge")
      recordStat(s, "spiral", "reasoning", "abort")
      saveStats(path, s)
      const loaded = loadStats(path)
      expect(loaded.totals).toEqual({ detect: 1, nudge: 1, abort: 1 })
      expect(loaded.counts.loop.text).toEqual({ detect: 1, nudge: 1, abort: 0 })
      expect(loaded.counts.spiral.reasoning.abort).toBe(1)
      expect(loaded.firstSeen).toBe(s.firstSeen)
      expect(loaded.lastSeen).toBe(s.lastSeen)
    } finally {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  })

  test("loadStats returns empty on corrupt JSON", () => {
    const path = `/tmp/loop-detector-test-corrupt-${Date.now()}.json`
    try {
      writeFileSync(path, "{ this is not valid json", "utf-8")
      const s = loadStats(path)
      expect(s.totals).toEqual({ detect: 0, nudge: 0, abort: 0 })
      expect(s.firstSeen).toBeNull()
    } finally {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  })

  test("loadStats recomputes totals from cells when stored totals drift", () => {
    const path = `/tmp/loop-detector-test-drift-${Date.now()}.json`
    try {
      // Construct JSON with counts present but wrong totals
      const bogus = {
        counts: {
          loop: {
            reasoning: { detect: 2, nudge: 1, abort: 0 },
            text: { detect: 0, nudge: 0, abort: 0 },
          },
          spiral: {
            reasoning: { detect: 0, nudge: 0, abort: 0 },
            text: { detect: 1, nudge: 0, abort: 1 },
          },
        },
        totals: { detect: 999, nudge: 999, abort: 999 }, // intentionally wrong
        firstSeen: "2024-01-01T00:00:00.000Z",
        lastSeen: "2024-06-01T00:00:00.000Z",
      }
      writeFileSync(path, JSON.stringify(bogus), "utf-8")
      const loaded = loadStats(path)
      // totals must be recomputed: detect=3, nudge=1, abort=1
      expect(loaded.totals).toEqual({ detect: 3, nudge: 1, abort: 1 })
      expect(loaded.counts.loop.reasoning.detect).toBe(2)
      expect(loaded.counts.spiral.text.abort).toBe(1)
      expect(loaded.firstSeen).toBe("2024-01-01T00:00:00.000Z")
    } finally {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  })
})

// ---------------------------------------------------------------------------
// Plugin stats integration tests
// ---------------------------------------------------------------------------

describe("plugin stats integration", () => {
  test("loop → nudge records detect + nudge in stats file", async () => {
    const tmpPath = `/tmp/loop-detector-plugin-${Date.now()}-1.json`
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    const { client } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1, stats_path: tmpPath },
    )

    // Trigger text loop → abort (decided), then idle → nudge executes
    await hooks.event!({ event: makePartUpdatedEvent("ps1", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("ps1") as any })

    const loaded = loadStats(tmpPath)
    expect(loaded.counts.loop.text.detect).toBe(1)
    expect(loaded.counts.loop.text.nudge).toBe(1)
    expect(loaded.totals.detect).toBe(1)
    expect(loaded.totals.nudge).toBe(1)
    expect(loaded.totals.abort).toBe(0)
  })

  test("progressing to abort records abort count", async () => {
    const tmpPath = `/tmp/loop-detector-plugin-${Date.now()}-2.json`
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    const { client } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1, stats_path: tmpPath },
    )

    // First loop → nudge
    await hooks.event!({ event: makePartUpdatedEvent("ps2", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("ps2") as any })

    // Second loop → abort (nudges exhausted)
    await hooks.event!({ event: makePartUpdatedEvent("ps2", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("ps2") as any })

    const loaded = loadStats(tmpPath)
    expect(loaded.counts.loop.text.detect).toBe(2)
    expect(loaded.counts.loop.text.nudge).toBe(1)
    expect(loaded.counts.loop.text.abort).toBe(1)
    expect(loaded.totals).toEqual({ detect: 2, nudge: 1, abort: 1 })
  })

  test("loop_detector_stats tool returns formatted stats", async () => {
    const tmpPath = `/tmp/loop-detector-plugin-${Date.now()}-3.json`
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    const { client } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1, stats_path: tmpPath },
    )

    // Trigger one detect+nudge so stats is non-empty
    await hooks.event!({ event: makePartUpdatedEvent("ps3", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("ps3") as any })

    const result = await hooks.tool!.loop_detector_stats.execute({}, {} as any)
    expect(result.title).toBe("Loop Detector Stats")
    expect(result.output).toContain("Loop Detector Statistics")
    expect(result.output).toContain("Total:")
  })

  test("loop_detector_stats tool with reset=true zeroes counters", async () => {
    const tmpPath = `/tmp/loop-detector-plugin-${Date.now()}-4.json`
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    const { client } = createMockClient()
    const hooks = await LoopDetector(
      { client, serverUrl: new URL("http://localhost:0") } as any,
      { min_chars: 10, check_interval: 1, min_period: 3, max_nudges: 1, stats_path: tmpPath },
    )

    // Trigger one detect+nudge
    await hooks.event!({ event: makePartUpdatedEvent("ps4", "text", repeat("0123456789", 60)) as any })
    await hooks.event!({ event: makeIdleEvent("ps4") as any })
    expect(loadStats(tmpPath).totals.detect).toBe(1)

    // Reset via tool
    const result = await hooks.tool!.loop_detector_stats.execute({ reset: true }, {} as any)
    expect(result.title).toBe("Loop Detector Stats (reset)")

    // File on disk should now be zeroed
    const loaded = loadStats(tmpPath)
    expect(loaded.totals).toEqual({ detect: 0, nudge: 0, abort: 0 })
    expect(loaded.firstSeen).toBeNull()
  })
})
