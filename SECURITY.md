# Security Policy

## Supported Versions

Security fixes target the current `main`/release branch and the active development branch.

## Reporting A Vulnerability

Do not open public issues for secrets exposure, sandbox escapes, or credential leaks. Send a private report through GitHub Security Advisories when available, or contact the maintainer directly.

Include:

- DeepChat version or commit SHA.
- Operating system and Electron runtime context.
- Minimal reproduction steps.
- Whether tools, MCP, workspace roots, or code execution were enabled.
- Redacted logs or screenshots.

## Tool Safety Principles

- `run_code` must not inherit the full user environment.
- File tools must reject sensitive paths such as `.env`, SSH keys, npm tokens, cloud credentials, and private certificates.
- Writing tools must require user confirmation, validate paths inside an approved workspace, and create backups before writing.
- External MCP calls must be visible and auditable.
