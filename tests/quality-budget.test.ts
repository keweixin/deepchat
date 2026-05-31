import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore ESM utility script intentionally has no generated declaration file.
import { checkBudgets } from '../scripts/check-quality-budget.mjs';

describe('quality budget checker', () => {
  let tmpDir = '';

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('passes a simple fixture', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-quality-'));
    const file = path.join(tmpDir, 'simple.ts');
    await fs.writeFile(file, 'export function ok(value: boolean) {\n  return value ? 1 : 0;\n}\n', 'utf8');

    const result = checkBudgets([
      {
        file,
        maxLines: 20,
        maxFunctionLines: 10,
        maxFunctionComplexity: 4,
        maxNesting: 2,
        maxImports: 1,
        maxExports: 2,
      },
    ]);

    expect(result.issues).toEqual([]);
  });

  it('fails a complex deeply nested fixture with actionable metrics', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-quality-'));
    const file = path.join(tmpDir, 'complex.ts');
    await fs.writeFile(
      file,
      `export function risky(a: boolean, b: boolean, c: boolean) {
  if (a) {
    if (b) {
      if (c) {
        return a && b || c ? 1 : 0;
      }
    }
  }
  return 0;
}
`,
      'utf8'
    );

    const result = checkBudgets([
      {
        file,
        maxLines: 20,
        maxFunctionLines: 20,
        maxFunctionComplexity: 3,
        maxNesting: 2,
        maxImports: 1,
        maxExports: 2,
      },
    ]);

    expect(result.issues.some((issue) => issue.metric === 'complexity' && issue.label.includes('risky'))).toBe(true);
    expect(result.issues.some((issue) => issue.metric === 'nesting' && issue.label.includes('risky'))).toBe(true);
  });
});
