# Changelog

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
