export type ComposerInputHistoryOptions = {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  key?: string;
  limit?: number;
};

export type ComposerInputHistoryState = {
  history: string[];
  index: number;
};

const DEFAULT_HISTORY_KEY = 'dc_input_history';
const DEFAULT_HISTORY_LIMIT = 50;

export function loadComposerInputHistory(options: ComposerInputHistoryOptions = {}): string[] {
  const storage = resolveStorage(options.storage);
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(resolveKey(options.key)) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String).slice(0, resolveLimit(options.limit)) : [];
  } catch {
    return [];
  }
}

export function rememberComposerInput(
  state: ComposerInputHistoryState,
  content: unknown,
  options: ComposerInputHistoryOptions = {}
): ComposerInputHistoryState {
  const text = String(content || '').trim();
  if (!text) return { history: state.history, index: state.index };

  const limit = resolveLimit(options.limit);
  const history = [text, ...state.history.filter((item) => item !== text)].slice(0, limit);
  persistHistory(history, options);
  return { history, index: -1 };
}

export function navigateComposerInputHistory(
  state: ComposerInputHistoryState,
  direction: number
): { value: string; state: ComposerInputHistoryState } {
  if (state.history.length === 0) return { value: '', state };
  const index = direction < 0 ? Math.min(state.index + 1, state.history.length - 1) : Math.max(state.index - 1, -1);
  return {
    value: index >= 0 ? state.history[index] : '',
    state: { history: state.history, index },
  };
}

export function createComposerInputHistory(options: ComposerInputHistoryOptions = {}) {
  let state: ComposerInputHistoryState = {
    history: loadComposerInputHistory(options),
    index: -1,
  };

  return {
    remember(content: unknown) {
      state = rememberComposerInput(state, content, options);
      return state;
    },
    navigate(direction: number) {
      const result = navigateComposerInputHistory(state, direction);
      state = result.state;
      return result.value;
    },
    reload() {
      state = { history: loadComposerInputHistory(options), index: -1 };
      return state;
    },
    getState() {
      return { history: [...state.history], index: state.index };
    },
  };
}

function persistHistory(history: string[], options: ComposerInputHistoryOptions) {
  const storage = resolveStorage(options.storage);
  if (!storage) return;
  storage.setItem(resolveKey(options.key), JSON.stringify(history));
}

function resolveStorage(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function resolveKey(key?: string) {
  return key || DEFAULT_HISTORY_KEY;
}

function resolveLimit(limit?: number) {
  return Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_HISTORY_LIMIT;
}
