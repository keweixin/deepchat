# DeepChat Reasonix-Inspired Optimization Plan

> Scope: learn from DeepSeek-Reasonix without turning DeepChat into a terminal coding agent clone. DeepChat remains an Electron desktop assistant with user-approved tools, MCP, browser fallback, trace UI, token usage, and cache telemetry.

## Source Notes

- Reasonix organizes the agent loop around cache-first prompts, tool-call repair, and cost control.
- DeepSeek context caching is automatic, but a later request only gets a cache hit when the reused prefix fully matches a persisted cache unit.
- DeepSeek exposes cache telemetry through `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens`.
- Reasonix treats prefix stability as an invariant: system prompt, tool schema, few-shot blocks, and skill indexes are deterministic; volatile intent, tool outputs, and large bodies are appended later or compacted.

## Current DeepChat Baseline

Already implemented in this branch:

- `agent_auto` intent routing with tool prerequisites.
- Cache-stable Electron prefix builder with `prefixFingerprint`, `systemHash`, `toolsHash`, `prefixBytes`, and `prefixTokens`.
- Real provider usage parsing for DeepSeek/OpenAI-style usage, including cache hit/miss and estimated cost.
- Context budget builders for Electron and browser fallback.
- Tool-result compaction by tool type.
- Agent trace / actor UI / theatre rendering for tool progress.
- Tool approval, timeout, sensitive-file denylist, redaction, and run-code light sandboxing.

## Reasonix Patterns To Preserve

1. Stable prefix first:
   System prompt, fixed agent rules, and sorted tool schemas must be deterministic. Dynamic intent, missing prerequisites, current user text, search results, file contents, and tool observations belong after the stable prefix.

2. Append-only turn log:
   Prefer appending user, assistant, tool, and summary messages. Rewrites should be explicit and reflected in cache diagnostics because they usually cause a cold prefix segment.

3. Compact after a turn:
   The model may see full tool output during the turn that produced it. Future turns should see a compact summary with enough metadata to re-read or re-run the tool.

4. Repair before failing:
   Malformed tool JSON, missing tool calls in reasoning text, truncated arguments, and repeated identical calls should produce visible repair/error turns rather than silent `{}` arguments or repeated approval storms.

5. Cost is part of UX:
   Token badges should explain input, output, thinking, cache hit/miss, source, estimated cost, and why a cache miss likely happened.

## Implementation Roadmap

### P0: Cache Stability Invariants

- Completed: replace locale-sensitive prefix sorting with codepoint-stable ordering for Electron tool schema and Skill prefix blocks.
- Completed: make browser fallback external Skill prompt order deterministic across import order.
- Next: add a shared canonical prefix helper for Electron and browser so both surfaces compute the same `systemHash`, `toolsHash`, and `prefixFingerprint` for equivalent settings.
- Next: add a `prefixChangeReasons` timeline in the message UI, sourced from `cacheStabilityReasons`, so users can see whether a miss came from system prompt, tool schema, workspace/MCP, or log rewrite.

Verification:

- Unit tests for stable tool ordering, Skill ordering, and cross-surface prefix hash parity.
- Snapshot tests proving `agent_auto` intent changes do not change the prefix fingerprint when the tool set is unchanged.

### P1: Reasonix-Style Compaction

- Add turn-end compaction metadata to every tool run: original token estimate, compacted token estimate, compaction ratio, and reason.
- Keep the current tool-type compaction, but add a hard cap measured by token estimate, not only characters.
- Preserve re-read metadata: file path, line range, search query, source URL, MCP server/tool, run-code language, exit code, and stderr status.
- Add a visible "re-read source" suggestion when compaction removed most of a tool result.

Verification:

- Tests for each tool type: search, read_file, read_symbol, search_workspace, run_code, MCP, and generic output.
- Regression test that compacted output remains under the configured token cap.

### P1: Tool-Call Repair UX

- Extend existing malformed argument handling into a structured `toolRepair` record with raw arguments, parse error, repair attempt, and final status.
- Add model-visible repair feedback for invalid JSON instead of silently dropping or approving an empty arg object.
- Add a bounded scavenger for tool calls leaked in `reasoning_content` or normal content, gated by known tool names.
- Keep repeat-tool storm suppression, but show the suppression event in the trace and agent timeline.

Verification:

- Tests for malformed JSON, truncated JSON, repeated identical tool calls, reasoning-content scavenging, and non-existing tool names.

### P1: Context Memory And Summary Economics

- Keep auto summary hash caching, but add an economics gate: summarize only when expected future savings beats summary-call cost or when budget pressure is high.
- Record summary usage under `tokens.byPurpose.summary`.
- Add `contextSummaryMeta.reason`: `budget_trim`, `high_ratio`, `manual`, or `restore`.
- Keep preserved constraints and user "do not" instructions verbatim in summaries.

Verification:

- Tests for summary reuse by hash, high-pressure summarization, low-pressure skip, and preservation of negative constraints.

### P2: Skills And Prefix Size

- Follow Reasonix's pattern: only Skill name, description, source path, enabled state, and content hash should live in the stable prefix by default.
- Add an explicit "inline Skill body" toggle for users who want the old behavior.
- Add a future `run_skill`/`load_skill` tool so large Skill bodies can be injected after intent selection rather than permanently bloating the prefix.

Verification:

- Tests that Skill body changes update the content hash but do not bloat the stable prefix when inline mode is off.
- Tests that explicit inline mode preserves old behavior.

### P2: Cost-Aware Model Defaults

- Keep DeepChat provider-compatible by default, but add DeepSeek-specific cost guidance when the active provider is DeepSeek.
- Add optional "flash first" behavior for summary/repair helper calls even when the main answer uses a stronger model.
- Never silently escalate to a higher-cost model; show the reason and usage impact.

Verification:

- Tests for helper-call model selection, estimated cost aggregation, and visible escalation warnings.

## Current Increment

This increment implements the first P0 invariant:

- Electron prefix tool ordering no longer uses `localeCompare`.
- Electron Skill prefix ordering no longer uses `localeCompare`.
- Browser fallback external Skill ordering is deterministic and no longer depends on import order.
- Tests cover stable tool ordering and stable Skill ordering.
