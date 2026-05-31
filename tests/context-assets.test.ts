import { describe, expect, it } from 'vitest';
import {
  buildContextAssetPromptBlock,
  createTextContextAsset,
  selectContextAssetsForTurn,
} from '../src/modules/context-assets.js';

describe('context assets', () => {
  it('creates text assets without forcing textarea insertion', () => {
    const asset = createTextContextAsset({ name: 'notes.md', text: '# Notes', size: 7, id: 'ctx-1' });
    expect(asset).toMatchObject({
      id: 'ctx-1',
      kind: 'text',
      name: 'notes.md',
      includeInNextTurn: true,
    });
  });

  it('renders selected assets as bounded prompt blocks', () => {
    const asset = createTextContextAsset({ name: 'notes.md', text: 'A'.repeat(5000), size: 5000, id: 'ctx-2' });
    const block = buildContextAssetPromptBlock([asset], { maxCharsPerAsset: 1000 });

    expect(block).toContain('<uploaded_attachments>');
    expect(block).toContain('notes.md');
    expect(block).toContain('ctx-2');
    expect(block).toContain('truncated 4000 chars');
    expect(block.length).toBeLessThan(1500);
  });

  it('keeps unselected assets out of the turn', () => {
    const asset = createTextContextAsset({
      name: 'draft.md',
      text: 'skip',
      size: 4,
      includeInNextTurn: false,
    });
    expect(selectContextAssetsForTurn([asset])).toEqual([]);
    expect(buildContextAssetPromptBlock([asset])).toBe('');
  });
});
