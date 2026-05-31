# ADR 0001: Agent Runtime Boundaries

## Status

Accepted

## Context

DeepChat is a local-first desktop agent. It can read files, run code, edit approved workspace files, call MCP servers, inspect Git history, and query model providers. The product priority is transparency and recoverability over hidden autonomy.

## Decision

DeepChat keeps a visible approval boundary for write, execute, MCP, and external side-effect tools. Read-only tools may be auto-approved only under an explicit user-selected policy. Context construction remains cache-first: stable system and tool schema prefix first, dynamic turn metadata later. Agent traces, tool evidence, job metadata, memory diagnostics, and context compaction decisions are persisted for inspection.

## Consequences

- Agent behavior remains auditable.
- Cache hit optimization constrains request ordering.
- Tool UX must explain risk, approval state, output compaction, and recovery evidence.
- Full autonomous project mutation is out of scope until sandboxing, rollback, and long-running job controls are stronger.
