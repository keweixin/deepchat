# Changelog

## Unreleased

## 1.5.0 - 2026-05-27

### Performance

- **Virtual Message List**: Wired into `chat.js` — auto-enables at 30+ messages, renders only visible messages with placeholder height preservation. Destroys during streaming and re-enables on conversation switch.
- **Streaming Render**: Removed `renderMarkdown` fallback during streaming; `scheduleRender` now exclusively uses lightweight `renderStreamingMarkdown` (inline-only: bold, italic, code, links). Full `renderMarkdown` + `postProcess` runs only after stream completion.
- **Theatre DOM Stability**: `_buildFingerprint` now uses structure-only hashing (`crew.map(m => m.id)`), eliminating full DOM rebuilds on every status tick. Status/action/summary updates use `textContent` assignments. Added `ResizeObserver` for SVG flow path redrawing on stage resize.

### Fixes

- Fixed `renderCrewOrTheatre` recursive self-call bug (now correctly delegates to `renderAgentCrew`).
- Fixed `calculateVisibleRange` edge cases in `virtual-message-list.js` (zero-height viewport, single-item visibility, scrolled-past-all-items).
- Fixed placeholder selector in `createVirtualList` to only target `.message` elements, preventing accidental placeholder-to-placeholder replacement.

## 1.4.0 - 2026-05-27

### Architecture — Agent Trace & Actor System

- **TraceRecorder**: Immutable event recorder for agent runs with 10 event types (runStart, stage, toolRequest, approval, toolResult, toolRepair, modelDelta, contextCompaction, runEnd, error).
- **Agent Actor System**: Derives real-time actor states (idle/thinking/waiting_approval/running_tool/observing/blocked/done/error) from trace events with 6 built-in roles (planner, reader, researcher, coder, reviewer, writer).
- **Agent Theatre**: CSS/SVG animated visualization mode for agent crew with incremental DOM updates and status animations (pulse, spin, blink, check, shake).
- **Trace Inspector**: Modal inspector for trace events with timeline view, actor status grid, and tool detail cards. Bound to `Ctrl+Shift+T`.
- **Trace Store**: IndexedDB persistence for traces with retention policies and privacy mode support.
- **Legacy Migration**: `migrateLegacyAgentRun()` adapter preserves old `agentRun` data and opens it in the trace inspector on `Ctrl+Click`.

### Performance & UX

- **Streaming Renderer**: Inline-only markdown rendering during streams (bold, italic, code, links) with full markdown render on completion. Threshold: 400+ chars.
- **Virtual Message List** _(Experimental)_: Buffer-based virtualization implementation exists but was not yet wired into `chat.js` `renderMessages()` in this release.
- **Inspector Panel** _(Experimental)_: Right-side panel foundation with model info, trace, tool detail, and artifact modes.
- **Provider Registry**: Capability matrix per model/provider with compatibility reports and preset configs for DeepSeek, OpenAI, Anthropic, and others.
- **Tool Cards**: Unified tool card component with risk scope inference (read/write/execute/network), approval state, and evidence summary.

### Workspace & MCP

- **Workspace Index Report**: Coverage statistics, index status display, and per-file detail view.
- **Artifact Versions**: Version management for extracted artifacts with diff view and export.
- **MCP Drawer**: Server status, tool scopes, call logs, and usage statistics for MCP integrations.

### Security & Hardening

- **Security Utils**: Risk scoring (0-100), execution policy, and approval requirements for tools like `run_code`, `write`, `delete`.
- **Privacy Mode**: Settings toggle to disable trace recording and sensitive data persistence.
- **Source Scanner**: Updated allowlist for new UI render modules using safe innerHTML patterns.

### Engineering

- Added `npm run verify` = `format:check && lint && test && build` for CI-ready quality gates.
- **692 tests passing** across 44 test files (6 skipped due to IndexedDB environment limitations).
- No new large dependencies; pure CSS/SVG animations; no Canvas/WebGL.

### Fixes

- Fixed dynamic import warning in `chat.js` by replacing redundant `import('./agent-trace.js')` with static import reuse.

## 1.3.1 - 2026-05-19

- Replaced cramped inline conversation actions with a focused right-side `...` menu for rename, tags, folder, pin, archive, and delete.
- Reduced reading navigator scroll jank by separating outline rebuilds from scroll-only active/progress updates.
- Added a regression test to ensure scroll events do not rebuild the navigator outline.

## 1.3.0 - 2026-05-19

- Unified tool-run persistence and search grounding evidence for web/file/code/MCP-style tool calls.
- Replaced destructive browser prompts with accessible in-app confirmation and input dialogs.
- Preserved partial assistant output on failures/stops and added clearer continue/retry recovery affordances.
- Hardened attachment handling with safe DOM construction, image count limits, and text file size limits.
- Expanded adaptive output classes for troubleshooting, report, and source-heavy answers.
- Added tests for tool-run state, dialog behavior, and adaptive answer classification.

## 1.2.0 - 2026-05-19

- Added conversation management filters for active, favorites, archived, and all conversations.
- Added conversation tags, folder labels, archive toggles, and batch archive/delete actions.
- Added input history navigation with `Ctrl+↑` and `Ctrl+↓`.
- Added export paths for favorite answers, tool evidence JSON, and media/resource indexes.
- Added model capability status chips for streaming, tools, vision, and thinking support.
- Added source hygiene checks to `npm run verify` and documented the visual design system.
- Standardized Windows release artifact names for versioned setup and timestamped portable builds.

## 1.1.0 - 2026-05-19

- Implemented real image attachments for vision-capable models.
- Routed runnable code blocks through the confirmed desktop `run_code` tool.
- Persisted tool run evidence with source previews and search grounding warnings.
- Added per-turn composer overrides for thinking, web search, and prompt enhancement.
- Added table CSV export, Mermaid SVG/PNG download, source warnings, favorites, prompt templates, and HTML/PDF export.
- Improved MCP status visibility and settings grouping.
- Added release checklist and repository hygiene defaults.
