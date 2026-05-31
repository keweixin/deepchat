# Contributing

DeepChat is a local-first Electron Agent client. Keep changes small, auditable, and easy to verify.

## Development

```powershell
npm ci
npm run dev
```

Before opening a pull request:

```powershell
npm run lint
npm run lint:biome
npm run typecheck
npm run typecheck:strict
npm test
npm run build
```

`npm run verify` runs the standard quality gate. `npm run verify:quality` also runs coverage.

## Agent And Tool Changes

- All file writes, code execution, and external MCP actions must remain visible to the user.
- Writing tools must require confirmation and produce rollback evidence.
- Keep system prompts and tool schema ordering stable when possible, because DeepSeek prefix cache depends on stable prefixes.
- Do not add a runtime dependency unless it materially reduces risk or complexity.

## Security

Never commit API keys, local secrets, workspace credentials, or exported conversations containing private data.
