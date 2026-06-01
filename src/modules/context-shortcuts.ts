import { hasNativeBridge } from './bridge.ts';

export const CONTEXT_SHORTCUTS = Object.freeze([
  {
    id: 'file',
    title: '引用文件',
    description: '插入 @file，让 Agent 精确读取一个工作区文件',
    insertText: '@file:"src/path/to/file"',
    placeholder: 'src/path/to/file',
    needs: 'workspace',
  },
  {
    id: 'folder',
    title: '引用目录',
    description: '插入 @folder，让 Agent 先列目录再摘要',
    insertText: '@folder:"src/modules"',
    placeholder: 'src/modules',
    needs: 'workspace',
  },
  {
    id: 'symbol',
    title: '查找符号',
    description: '插入 @symbol，让 Agent 搜索函数、类或变量',
    insertText: '@symbol:FunctionName',
    placeholder: 'FunctionName',
    needs: 'workspace',
  },
  {
    id: 'changed',
    title: '最近变更',
    description: '插入 @changed，要求 Agent 检查工作区最近改动',
    insertText: '@changed 最近改了什么',
    placeholder: '',
    needs: 'workspace',
  },
  {
    id: 'web',
    title: '强制联网',
    description: '插入 @web，要求 Agent 优先使用联网搜索',
    insertText: '@web 最新资料',
    placeholder: '',
    needs: 'tavily',
  },
  {
    id: 'run',
    title: '运行验证',
    description: '插入 @run，要求 Agent 通过代码运行验证',
    insertText: '@run 验证这段逻辑',
    placeholder: '',
    needs: 'desktop',
  },
  {
    id: 'mcp',
    title: '调用 MCP',
    description: '插入 @mcp，要求 Agent 使用外部 MCP 工具',
    insertText: '@mcp 查询外部系统',
    placeholder: '',
    needs: 'mcp',
  },
]);

export function buildContextShortcutEntries(settings: Record<string, any> = {}) {
  return CONTEXT_SHORTCUTS.map((shortcut) => {
    const unavailableReason = getContextShortcutUnavailableReason(shortcut, settings);
    return {
      ...shortcut,
      available: !unavailableReason,
      state: unavailableReason || '可插入',
      selectStartOffset: shortcut.placeholder ? shortcut.insertText.indexOf(shortcut.placeholder) : -1,
      selectEndOffset: shortcut.placeholder
        ? shortcut.insertText.indexOf(shortcut.placeholder) + shortcut.placeholder.length
        : -1,
    };
  });
}

export function getContextShortcutUnavailableReason(shortcutOrId: any, settings: Record<string, any> = {}) {
  const shortcut =
    typeof shortcutOrId === 'string' ? CONTEXT_SHORTCUTS.find((item) => item.id === shortcutOrId) : shortcutOrId;
  if (!shortcut) return '未知上下文';
  if (shortcut.needs === 'workspace') {
    if (!hasNativeBridge()) return '需桌面版';
    if (!Array.isArray(settings.workspaceRoots) || settings.workspaceRoots.length === 0) return '需工作区';
  }
  if (shortcut.needs === 'tavily' && !hasSearchCapability(settings)) {
    return hasNativeBridge() ? '需 Tavily Key 或搜索兜底' : '需 Tavily Key';
  }
  if (shortcut.needs === 'desktop' && !hasNativeBridge()) return '需桌面版';
  if (shortcut.needs === 'desktop' && settings.runCodeEnabled === false) return '代码运行已关闭';
  if (shortcut.needs === 'mcp' && !hasNativeBridge()) return '需桌面版';
  if (shortcut.needs === 'mcp' && !hasEnabledMcpServer(settings)) return '需 MCP';
  return '';
}

function hasSearchCapability(settings: Record<string, any> = {}) {
  if (settings.tavilyApiKey) return true;
  if (!hasNativeBridge()) return false;
  if (settings.docsetSearchEnabled === true && Array.isArray(settings.docsetRoots) && settings.docsetRoots.length > 0) {
    return true;
  }
  return String(settings.localSearchFallbackMode || '') === 'missing_key';
}

export function formatContextMentionTitle(mentions: Array<{ type: string; path: string }> = []) {
  return (Array.isArray(mentions) ? mentions : [])
    .map((item) => {
      if (item.type === 'folder') return `目录：${item.path}`;
      if (item.type === 'symbol') return `符号：${item.path}`;
      return `文件：${item.path}`;
    })
    .join('\n');
}

function hasEnabledMcpServer(settings: Record<string, any> = {}) {
  return (settings.mcpServers || []).some((server: any) => server?.enabled !== false && server?.command);
}
