import { describe, expect, it, vi } from 'vitest';
import {
  createComposerInputHistory,
  loadComposerInputHistory,
  navigateComposerInputHistory,
  rememberComposerInput,
} from '../src/modules/composer-history.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => data.get(key) || null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

describe('composer input history', () => {
  it('loads bounded non-empty history from storage', () => {
    const storage = memoryStorage({ hist: JSON.stringify(['a', '', 'b', 3, 'c']) });

    expect(loadComposerInputHistory({ storage, key: 'hist', limit: 3 })).toEqual(['a', 'b', '3']);
  });

  it('dedupes remembered prompts and persists the latest order', () => {
    const storage = memoryStorage();
    const state = rememberComposerInput({ history: ['old', 'same', 'another'], index: 2 }, 'same', {
      storage,
      key: 'hist',
      limit: 3,
    });

    expect(state).toEqual({ history: ['same', 'old', 'another'], index: -1 });
    expect(storage.setItem).toHaveBeenCalledWith('hist', JSON.stringify(['same', 'old', 'another']));
  });

  it('ignores blank prompts without mutating history', () => {
    const storage = memoryStorage();
    const state = rememberComposerInput({ history: ['old'], index: 0 }, '   ', { storage, key: 'hist' });

    expect(state).toEqual({ history: ['old'], index: 0 });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('navigates backward and forward through history', () => {
    let result = navigateComposerInputHistory({ history: ['new', 'old'], index: -1 }, -1);
    expect(result.value).toBe('new');

    result = navigateComposerInputHistory(result.state, -1);
    expect(result.value).toBe('old');

    result = navigateComposerInputHistory(result.state, 1);
    expect(result.value).toBe('new');

    result = navigateComposerInputHistory(result.state, 1);
    expect(result.value).toBe('');
  });

  it('provides a stateful controller for the composer', () => {
    const storage = memoryStorage({ hist: JSON.stringify(['first']) });
    const history = createComposerInputHistory({ storage, key: 'hist' });

    expect(history.navigate(-1)).toBe('first');
    history.remember('second');
    expect(history.getState()).toEqual({ history: ['second', 'first'], index: -1 });
    expect(history.navigate(-1)).toBe('second');
  });
});
