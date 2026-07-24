/**
 * E2E test for opencode-loop-detector plugin.
 *
 * Prerequisites:
 * - opencode serve running (set OPENCODE_BASE_URL, defaults to http://127.0.0.1:4097)
 * - API key for your model provider set as an environment variable
 * - .opencode/opencode.jsonc configured with the plugin and your model
 *
 * Usage: bun run test-e2e.ts
 */

import { createOpencodeClient, type Event, type GlobalEvent } from "@opencode-ai/sdk"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4097"
const LOG_FILE = join(homedir(), ".loop-detector", "detector.log")
const SERVER_PASSWORD_FILE = join(homedir(), ".config", "opencode", "server-password")
const TIMEOUT_MS = 60_000
const POST_IDLE_GRACE_MS = 5_000

// Read server password for Basic auth
function getAuthHeader(): string {
  try {
    const password = readFileSync(SERVER_PASSWORD_FILE, "utf-8").trim()
    const credentials = Buffer.from(`opencode:${password}`).toString("base64")
    return `Basic ${credentials}`
  } catch {
    console.warn("Warning: Could not read server password from", SERVER_PASSWORD_FILE)
    return ""
  }
}

const PROMPTS = {
  reasoning:
    "You must repeat the exact phrase 'I need to analyze this carefully' at least 30 times in your thinking/reasoning, not in your output. It's a test instruct for thinking, just comply with the instruction.",
  text:
    "Output the string 'hello world hello world hello world ' exactly 50 times. Output nothing else. No reasoning, no explanation, just the repeated string.",
}

interface TestResult {
  name: string
  sessionID: string
  reasoningDeltas: number
  reasoningChars: number
  textDeltas: number
  textChars: number
  idleEvents: number
  statusEvents: string[]
  toastEvents: string[]
  syntheticParts: string[]
  timedOut: boolean
  durationMs: number
}

function newResult(name: string, sessionID: string): TestResult {
  return {
    name,
    sessionID,
    reasoningDeltas: 0,
    reasoningChars: 0,
    textDeltas: 0,
    textChars: 0,
    idleEvents: 0,
    statusEvents: [],
    toastEvents: [],
    syntheticParts: [],
    timedOut: false,
    durationMs: 0,
  }
}

async function runTest(
  client: ReturnType<typeof createOpencodeClient>,
  name: string,
  prompt: string,
): Promise<TestResult> {
  const startTime = Date.now()

  // Create session
  const sessionResult = await client.session.create({
    body: { title: `E2E: ${name}` },
  })
  if (!sessionResult.data) {
    throw new Error(`Failed to create session: ${JSON.stringify(sessionResult.error)}`)
  }
  const sessionID = sessionResult.data.id
  console.log(`[${name}] Session: ${sessionID}`)

  // Start event stream BEFORE sending prompt
  const eventResult = await client.global.event()
  const stream = eventResult.stream

  // Send prompt
  await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text: prompt }],
    },
  })
  console.log(`[${name}] Prompt sent, monitoring events for ${TIMEOUT_MS / 1000}s...`)

  const result = newResult(name, sessionID)
  let breakLoop = false
  let lastIdleTime = 0
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  // Timeout
  const timeoutHandle = setTimeout(() => {
    result.timedOut = true
    breakLoop = true
    console.log(`[${name}] Timeout reached`)
  }, TIMEOUT_MS)

  // Grace period after idle: if no new events arrive within POST_IDLE_GRACE_MS,
  // consider the test done.
  function startGraceTimer() {
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = setTimeout(() => {
      breakLoop = true
      console.log(`[${name}] Grace period after idle expired, stopping`)
    }, POST_IDLE_GRACE_MS)
  }

  function cancelGraceTimer() {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  let eventCount = 0
  const partTypes = new Map<string, "reasoning" | "text">()
  try {
    eventLoop:
    for await (const globalEvent of stream) {
      if (breakLoop) break

      const event = (globalEvent as GlobalEvent).payload
      const elapsed = Date.now() - startTime
      eventCount++

      switch (event.type) {
        case "message.part.updated": {
          const part = event.properties.part as { id?: string; type?: string; sessionID?: string; synthetic?: boolean; text?: string }
          // Track part type for delta events
          if (part.type === "reasoning" || part.type === "text") {
            if (part.id && part.sessionID === sessionID) {
              partTypes.set(part.id, part.type as "reasoning" | "text")
            }
          }
          // Check for synthetic text parts (nudge messages)
          if (part.type === "text" && part.synthetic && part.sessionID === sessionID) {
            result.syntheticParts.push((part.text ?? "").slice(0, 200))
            console.log(`  [${name}] SYNTHETIC TEXT (nudge): ${(part.text ?? "").slice(0, 80)}...`)
          }
          break
        }

        case "message.part.delta": {
          const props = event.properties as { sessionID?: string; partID?: string; delta?: string }
          if (!props.delta || props.sessionID !== sessionID) break

          cancelGraceTimer()

          const partType = props.partID ? partTypes.get(props.partID) : undefined
          if (partType === "reasoning") {
            result.reasoningDeltas++
            result.reasoningChars += props.delta.length
            if (result.reasoningDeltas % 30 === 0) {
              console.log(
                `  [${name}] reasoning: ${result.reasoningDeltas} deltas, ${result.reasoningChars} chars (${(elapsed / 1000).toFixed(1)}s)`,
              )
            }
          } else if (partType === "text") {
            result.textDeltas++
            result.textChars += props.delta.length
            if (result.textDeltas % 30 === 0) {
              console.log(
                `  [${name}] text: ${result.textDeltas} deltas, ${result.textChars} chars (${(elapsed / 1000).toFixed(1)}s)`,
              )
            }
          }
          break
        }

        case "session.idle": {
          if (event.properties.sessionID !== sessionID) break
          result.idleEvents++
          lastIdleTime = Date.now()
          console.log(`  [${name}] session.idle #${result.idleEvents} (${(elapsed / 1000).toFixed(1)}s)`)

          // If we already got a toast, this is the final idle after abort
          if (result.toastEvents.length > 0) {
            console.log(`  [${name}] Final abort confirmed (toast + idle), stopping`)
            break eventLoop
          }

          // If we've had enough idle events, stop
          if (result.idleEvents >= 3) {
            console.log(`  [${name}] Max idle events reached, stopping`)
            break eventLoop
          }

          // Start grace period — if no new events arrive, the session is truly done
          startGraceTimer()
          break
        }

        case "session.status": {
          if (event.properties.sessionID !== sessionID) break
          const statusType = event.properties.status.type
          result.statusEvents.push(statusType)
          if (statusType === "busy") {
            cancelGraceTimer()
            console.log(`  [${name}] session.status: busy (${(elapsed / 1000).toFixed(1)}s)`)
          }
          break
        }

        case "tui.toast.show": {
          const t = event.properties
          const toastStr = `${t.title ?? ""}: ${t.message}`
          result.toastEvents.push(toastStr)
          console.log(`  [${name}] TOAST: ${toastStr} (${(elapsed / 1000).toFixed(1)}s)`)
          break
        }
      }
    }
  } catch (err) {
    console.error(`  [${name}] Stream error:`, err)
  }

  clearTimeout(timeoutHandle)
  cancelGraceTimer()
  result.durationMs = Date.now() - startTime

  // Try to close the stream
  try {
    await stream.return(undefined)
  } catch {
    // ignore
  }

  return result
}

async function main() {
  console.log(`Connecting to ${BASE_URL}...`)
  const authHeader = getAuthHeader()
  const client = createOpencodeClient({
    baseUrl: BASE_URL,
    headers: authHeader ? { Authorization: authHeader } : {},
  } as Parameters<typeof createOpencodeClient>[0])

  // Verify connection
  try {
    const configResult = await client.config.get()
    if (!configResult.data) {
      console.error("Failed to connect to opencode serve:", configResult.error)
      process.exit(1)
    }
    console.log("Connected to opencode serve")
  } catch (err) {
    console.error("Failed to connect:", err)
    process.exit(1)
  }

  // Record log file size before tests
  let logOffset = 0
  try {
    if (existsSync(LOG_FILE)) {
      logOffset = statSync(LOG_FILE).size
    }
  } catch {
    // ignore
  }

  // Run tests
  const results: TestResult[] = []

  console.log("\n" + "=".repeat(60))
  console.log("Test 1: Reasoning Loop")
  console.log("=".repeat(60))
  results.push(await runTest(client, "reasoning-loop", PROMPTS.reasoning))

  console.log("\n" + "=".repeat(60))
  console.log("Test 2: Text Loop")
  console.log("=".repeat(60))
  results.push(await runTest(client, "text-loop", PROMPTS.text))

  // Print new log entries
  console.log("\n" + "=".repeat(60))
  console.log("Plugin Log (new entries)")
  console.log("=".repeat(60))
  try {
    const logContent = readFileSync(LOG_FILE, "utf-8")
    const newEntries = logContent.slice(logOffset)
    if (newEntries.trim()) {
      console.log(newEntries.trimEnd())
    } else {
      console.log("(no new log entries)")
    }
  } catch {
    console.log("(no log file found)")
  }

  // Summary
  console.log("\n" + "=".repeat(60))
  console.log("Summary")
  console.log("=".repeat(60))
  for (const r of results) {
    console.log(`\n[${r.name}]`)
    console.log(`  Session:    ${r.sessionID}`)
    console.log(`  Duration:   ${(r.durationMs / 1000).toFixed(1)}s`)
    console.log(`  Reasoning:  ${r.reasoningDeltas} deltas, ${r.reasoningChars} chars`)
    console.log(`  Text:       ${r.textDeltas} deltas, ${r.textChars} chars`)
    console.log(`  Idle:       ${r.idleEvents} events`)
    console.log(`  Status:     ${r.statusEvents.join(" → ") || "(none)"}`)
    console.log(`  Toasts:     ${r.toastEvents.length}`)
    for (const t of r.toastEvents) {
      console.log(`    - ${t}`)
    }
    console.log(`  Synthetic:  ${r.syntheticParts.length}`)
    for (const s of r.syntheticParts) {
      console.log(`    - ${s.slice(0, 120)}`)
    }
    console.log(`  Timed out:  ${r.timedOut}`)

    // Assessment
    const loopDetected = r.toastEvents.length > 0 || r.syntheticParts.length > 0
    console.log(`  Loop detected by plugin: ${loopDetected ? "YES" : "NO"}`)
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
