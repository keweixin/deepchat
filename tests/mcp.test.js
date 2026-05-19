import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseSkillMeta } = require('../electron/external-skills');
const { isMcpToolName, makeOpenAiToolName } = require('../electron/mcp-manager');

describe('external skills and MCP helpers', () => {
  it('parses frontmatter from SKILL.md files', () => {
    const meta = parseSkillMeta(`---
name: demo-skill
description: Demo skill description
---

# Demo`);

    expect(meta).toEqual({
      name: 'demo-skill',
      description: 'Demo skill description',
    });
  });

  it('creates OpenAI-safe names for MCP tools', () => {
    const name = makeOpenAiToolName({ id: 'local-files', name: 'Local Files' }, 'read/file.with spaces');

    expect(name).toMatch(/^mcp__local-files__/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(isMcpToolName(name)).toBe(true);
  });
});
