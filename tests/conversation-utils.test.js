import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_FILTERS,
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
});
