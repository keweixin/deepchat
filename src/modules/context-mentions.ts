import { findLatestUserIndex } from './shared-utils.js';

const CONTEXT_MENTION_LIMIT = 8;
const CONTEXT_MENTION_PATH_LIMIT = 300;

export interface ContextMention {
  type: string;
  path: string;
  label: string;
}

export function extractContextMentions(content = ''): ContextMention[] {
  const text = stripVolatileContextBlocks(content).replace(/```[\s\S]*?```/g, ' ');
  const pattern = /(?:^|[\s([，,;；])@(file|folder|symbol)\s*:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s,，;；)\]]+))/gi;
  const mentions: ContextMention[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && mentions.length < CONTEXT_MENTION_LIMIT) {
    const type = String(match[1] || '').toLowerCase();
    const rawPath = match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    const pathValue = normalizeContextMentionPath(rawPath);
    if (!pathValue) continue;
    const key = `${type}:${pathValue.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({
      type,
      path: pathValue,
      label: type === 'folder' ? `目录 ${pathValue}` : type === 'symbol' ? `符号 ${pathValue}` : `文件 ${pathValue}`,
    });
  }
  return mentions;
}

export function appendContextHintsToUserContent(
  content = '',
  mentions: ContextMention[] = [],
  settings: Record<string, unknown> = {}
): string {
  const selected = (Array.isArray(mentions) ? mentions : []).slice(0, CONTEXT_MENTION_LIMIT);
  if (selected.length === 0 || String(content || '').includes('<selected_context>')) return String(content || '');
  const workspaceCount = Array.isArray(settings.workspaceRoots) ? (settings.workspaceRoots as unknown[]).length : 0;
  const lines = [
    '<selected_context>',
    '用户在当前消息中用 @file/@folder/@symbol 显式选择了本地上下文。',
    '不要声称已经读取这些路径；需要文件内容时必须调用 list_files/search_workspace/read_symbol/read_file，并等待用户确认。搜索结果含 file:start-end 时，可用 read_file 精确读取该行范围。',
    workspaceCount > 0 ? `已配置工作区数量：${workspaceCount}` : '缺少工作区配置：请提示用户先在设置中添加工作区。',
    ...selected.map((item) => {
      const value = JSON.stringify(item.path);
      if (item.type === 'folder') return `- folder: ${item.path}；建议先调用 list_files({ "directory": ${value} })`;
      if (item.type === 'symbol')
        return `- symbol: ${item.path}；建议先调用 read_symbol({ "symbol": ${value} }) 读取定义块；若未命中，再调用 search_workspace({ "symbol": ${value}, "max_results": 8 }) 查看引用。`;
      return `- file: ${item.path}；建议调用 read_file({ "path": ${value} })`;
    }),
    '</selected_context>',
  ];
  return `${String(content || '').trim()}\n\n${lines.join('\n')}`.trim();
}

export function applyContextMentionsToMessages(
  messages: Array<Record<string, unknown>> = [],
  settings: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const latestUserIndex = findLatestUserIndex(messages);
  if (latestUserIndex < 0) return messages;
  const latest = messages[latestUserIndex];
  const mentions = extractContextMentions(String((latest as Record<string, unknown>)?.content || ''));
  if (mentions.length === 0) return messages;
  return messages.map((message, index) => {
    if (index !== latestUserIndex) return message;
    return {
      ...message,
      content: appendContextHintsToUserContent(String(message.content || ''), mentions, settings),
    };
  });
}

export function normalizeContextMentionPath(value: string): string {
  return String(value || '')
    .replace(/\0/g, '')
    .trim()
    .replace(/[.。；;，,]+$/g, '')
    .slice(0, CONTEXT_MENTION_PATH_LIMIT);
}

export function stripVolatileContextBlocks(content = ''): string {
  return String(content || '')
    .replace(/<related_memory>[\s\S]*?<\/related_memory>/gi, ' ')
    .replace(/<selected_context>[\s\S]*?<\/selected_context>/gi, ' ')
    .replace(/<task_checkpoint>[\s\S]*?<\/task_checkpoint>/gi, ' ');
}
