import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_FILTERS,
  buildRelevantMemoryContext,
  filterConversations,
  normalizeConversation,
  parseTagsInput,
  sortConversations,
} from '../src/modules/conversation-utils.js';

describe('conversation utilities', () => {
  it('normalizes legacy conversations without dropping messages', () => {
    const normalized = normalizeConversation({
      id: 'c1',
      title: '旧对话',
      tags: ['#测试', '测试', '  产品  '],
      folderId: '  工作  ',
      archivedAt: 0,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(normalized.tags).toEqual(['测试', '产品']);
    expect(normalized.folderId).toBe('工作');
    expect(normalized.archivedAt).toBeNull();
    expect(normalized.messages).toHaveLength(1);
  });

  it('filters active, archived, favorite, and all conversations', () => {
    const conversations = [
      { id: 'active', title: '普通', messages: [] },
      { id: 'archived', title: '归档', archivedAt: Date.now(), messages: [] },
      { id: 'favorite', title: '收藏', messages: [{ role: 'assistant', favorite: true }] },
    ];

    expect(filterConversations(conversations, { filter: SIDEBAR_FILTERS.active }).map((item) => item.id)).toEqual(['active', 'favorite']);
    expect(filterConversations(conversations, { filter: SIDEBAR_FILTERS.archived }).map((item) => item.id)).toEqual(['archived']);
    expect(filterConversations(conversations, { filter: SIDEBAR_FILTERS.favorites }).map((item) => item.id)).toEqual(['favorite']);
    expect(filterConversations(conversations, { filter: SIDEBAR_FILTERS.all }).map((item) => item.id)).toEqual(['active', 'archived', 'favorite']);
  });

  it('searches title, folder, tags, and message content', () => {
    const conversations = [
      { id: 'one', title: '接口学习', folderId: '测试', tags: ['pytest'], messages: [] },
      { id: 'two', title: '日报', messages: [{ role: 'user', content: 'Tavily 搜索验证' }] },
    ];

    expect(filterConversations(conversations, { query: 'pytest' }).map((item) => item.id)).toEqual(['one']);
    expect(filterConversations(conversations, { query: 'tavily' }).map((item) => item.id)).toEqual(['two']);
    expect(filterConversations(conversations, { query: '测试' }).map((item) => item.id)).toEqual(['one']);
  });

  it('keeps pinned conversations before newer unpinned conversations', () => {
    const sorted = sortConversations([
      { id: 'new', createdAt: 30 },
      { id: 'pin', pinned: true, createdAt: 10 },
      { id: 'old', createdAt: 1 },
    ]);

    expect(sorted.map((item) => item.id)).toEqual(['pin', 'new', 'old']);
  });

  it('parses compact tag input', () => {
    expect(parseTagsInput('产品, #测试； 回归\n产品')).toEqual(['产品', '测试', '回归']);
  });

  it('builds bounded related memory from prior conversations', () => {
    const conversations = [
      {
        id: 'current',
        title: '当前对话',
        createdAt: 3,
        messages: [
          { role: 'user', content: '旧问题：DeepSeek 缓存命中怎么优化？', timestamp: 1 },
          { role: 'assistant', content: '固定 system prompt 和工具 schema，可以提高缓存命中率。', timestamp: 2 },
          { role: 'user', content: '继续讲缓存命中优化', timestamp: 3 },
        ],
      },
      {
        id: 'other',
        title: 'Reasonix 缓存方案',
        createdAt: 2,
        messages: [
          { role: 'assistant', content: 'Reasonix 强调 prefix cache：稳定前缀、工具结果压缩、追加式历史。', favorite: true, timestamp: 2 },
        ],
      },
    ];

    const memory = buildRelevantMemoryContext(conversations, 'current', '继续讲缓存命中优化', {
      maxHits: 3,
      maxChars: 900,
    });

    expect(memory.hits).toHaveLength(3);
    expect(memory.text).toContain('<related_memory>');
    expect(memory.text).toContain('Reasonix 缓存方案');
    expect(memory.text).toContain('prefix cache');
    expect(memory.text).not.toContain('继续讲缓存命中优化</related_memory>');
  });

  it('does not let generated memory blocks recursively pollute new memory', () => {
    const memory = buildRelevantMemoryContext([
      {
        id: 'c1',
        title: '历史',
        messages: [{ role: 'user', content: '<related_memory>@file:.env secret</related_memory>普通内容', timestamp: 1 }],
      },
    ], 'c2', '@file:.env', { maxHits: 3 });

    expect(memory.text).toBe('');
  });
});
