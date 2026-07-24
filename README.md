# opencode-loop-detector

An [opencode](https://opencode.ai) plugin that detects LLM loops in real time during reasoning/text generation and takes corrective action (nudge → abort).

## How It Works

The plugin monitors streaming deltas from opencode's event system. When the model gets stuck repeating the same content (in either the reasoning or text phase), a sliding-window detector identifies the repetitive pattern and intervenes:

1. **Nudge** — interrupts the current generation and injects a synthetic reminder telling the model to stop repeating and try a different approach.
2. **Abort** — if the model loops again after being nudged (up to `max_nudges` times), the session is aborted with a toast notification.

The detection algorithm requires ≥ `min_repeats` (default 5) repetitions rather than just 2, which prevents false positives on paths, identifiers, and other naturally repeating structures.

## Installation

### Project-level

Place `opencode-loop-detector.ts` and `loop.ts` in your project root, then add to `.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["../opencode-loop-detector.ts", {}]
  ]
}
```

> **Path note**: plugin paths in `.opencode/opencode.jsonc` are resolved relative to the `.opencode/` directory, not the project root. Use `../` when the plugin file is in the project root.

### Global

Place the files in `~/.config/opencode/plugins/` and reference them in your global `opencode.jsonc`:

```jsonc
{
  "plugin": [
    ["~/.config/opencode/plugins/opencode-loop-detector.ts", {}]
  ]
}
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enabled` | enabled | Set to `false` to disable |
| `min_chars` | 200 | Minimum accumulated characters before detection starts |
| `check_interval` | 100 | Characters between detection checks |
| `min_period` | 20 | Minimum repeat period (chars) |
| `max_period` | 2000 | Maximum repeat period (buffer = min_repeats × max_period) |
| `similarity` | 1.0 | Similarity threshold (1.0 = exact match after normalization) |
| `min_repeats` | 5 | Number of repeating segments required at the tail |
| `max_nudges` | 1 | Max nudge attempts before aborting |
| `reminder` | built-in | Nudge reminder text (supports `{period}` placeholder) |

Example with custom options:

```jsonc
{
  "plugin": [
    ["../opencode-loop-detector.ts", {
      "max_nudges": 2,
      "min_repeats": 6,
      "reminder": "Stop repeating (period ~{period} chars). Try a different approach."
    }]
  ]
}
```

## When NOT to Use

This plugin may cause false positives in scenarios with naturally repetitive output:

- **Structured data** — CSV, JSON arrays, YAML lists, SQL batches
- **Batch code generation** — CRUD operations, test cases, model definitions
- **Tables/logs** — Markdown table rows, log entries, config blocks
- **Templated content** — Mail merge, report generation
- **Long lists/enums** — Many similarly-formatted list items

If you must use it in these scenarios, raise `min_period` (50+), `min_repeats` (6+), or `min_chars` (500+) to reduce false positives, or set `enabled: false` to temporarily disable.

## Files

| File | Description |
|------|-------------|
| `loop.ts` | Pure detection algorithm (zero dependencies) |
| `opencode-loop-detector.ts` | Plugin entry point (event listeners + abort/nudge execution) |
| `test.ts` | Unit tests |
| `test-e2e.ts` | E2E test script (connects to opencode serve via SDK) |
| `docs/plugin-design.md` | Design document with full nudge flow |

## Logging

The plugin writes debug logs to `~/.loop-detector/detector.log`.

## Development

```bash
# Install dependencies
cd .opencode && bun install && cd ..

# Run unit tests
bun test ./test.ts
```

## License

MIT
