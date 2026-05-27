# Changelog

## Unreleased

### Features

- **Agent Crew UX**: Added `crewDisplayMode` setting (`auto`/`always`/`tools_only`/`off`) with waiting-state header badges and role-click scrolling.
- **Evidence Panel**: Added tool evidence sidebar showing tool-call status, duration, and outputs per assistant message.
- **Artifact Panel**: Extended artifact extraction to support HTML preview, Mermaid diagrams, JSON data, CSV/Markdown tables, and code files with type filtering and deduplication.
- **Task Mode Pills**: Replaced composer skill select with 8 mode pills (`daily`/`analysis`/`project`/`agent`/`research`/`code`/`writing`/`polish`) with per-conversation persistence.
- **Workspace Search**: Added incremental index updates via sha256/mtime file reuse; integrated `@file:`, `@folder:`, `@symbol:`, `@changed:`, and `@recent` query directives.
- **Answer Components**: Added `:::evidence` and `:::tradeoff` custom markdown containers alongside existing `:::summary`, `:::warning`, `:::steps`, `:::decision`, `:::source`, `:::todo`, and `:::next`.
- **Quick Actions**: Added Artifact export to assistant message action bar; rewrite menu includes table, polish, code, TODO, and report transforms.
- Added auditable tool context-output metadata so users can inspect the compacted output sent to the next model round.
- Flattened complex MCP tool schemas into dot-path parameters and restored them before tool execution.
- Added conservative repair for truncated JSON tool arguments before approval.
- Routed DeepSeek context-summary auxiliary calls to `deepseek-v4-flash` and recorded the auxiliary model in summary metadata.
- Added conservative tool-call repair for JSON tool requests emitted in assistant content or reasoning text.
- Added parallel dispatch for read-only tool calls while preserving approval prompts and ordered tool-result context.
- Added a lightweight `search_workspace` tool that searches approved workspace text files and returns line citations.
- Added a GitHub tag release workflow for Windows Setup/Portable builds, SHA256 checksums, artifact upload, and draft releases.
- Documented CI and release automation in the README and release checklist.

### Fixes

- Fixed `resolveAllowedPath` symlink traversal risk by throwing on `realpath` failure instead of falling back to unverified candidate.
- Fixed `streamNativeChat` listener leak: abort now unsubscribes from event stream; added 10-minute fallback cleanup if main process never sends `done`/`error`.
- Fixed `switchConversation` race condition: active stream is now aborted before DOM wipe to prevent writing to detached nodes.
- Fixed `initChat` global listener leak by tracking all registrations in `_chatCleanupFns` and adding `destroyChat()` teardown.
- Fixed `openConversationMenu` stale timeout leak by clearing pending `pointerdown` defer on cleanup.
- Added `.catch()` guards on all `postProcess()` promise chains to prevent unhandled rejections.
- Added `response.body` null check before `getReader()` to handle proxy/network edge cases.
- Extracted duplicated Tavily search logic into shared `electron/search-utils.mjs` module.
- Fixed security scanner regex (`[^>]` matches newlines in JS) causing false positives for inline event handlers.
- Added minimal `console.warn` logging to empty catch blocks in `destroyChat` and `loadConversations`.

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
