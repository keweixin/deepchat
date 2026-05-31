/**
 * Tool Card Tests
 */

import { describe, it, expect } from 'vitest';
import { RISK_LEVELS, APPROVAL_STATUS, renderToolCard, renderToolCardList } from '../src/modules/tool-card.js';

describe('risk levels', () => {
  it('has expected risk levels', () => {
    expect(RISK_LEVELS.read.label).toBe('读取');
    expect(RISK_LEVELS.write.label).toBe('写入');
    expect(RISK_LEVELS.execute.label).toBe('执行');
    expect(RISK_LEVELS.network.label).toBe('网络');
  });
});

describe('approval statuses', () => {
  it('has expected statuses', () => {
    expect(APPROVAL_STATUS.auto_approved.label).toBe('自动通过');
    expect(APPROVAL_STATUS.pending.label).toBe('待审批');
    expect(APPROVAL_STATUS.approved.label).toBe('已批准');
    expect(APPROVAL_STATUS.denied.label).toBe('已拒绝');
  });
});

describe('renderToolCard', () => {
  it('renders a card with header', () => {
    const card = renderToolCard({ name: 'read_file', args: { path: '/test.md' } });
    expect(card.className).toContain('tool-card');
    expect(card.querySelector('.tool-card-header')).toBeTruthy();
    expect(card.querySelector('.tool-card-name').textContent).toContain('read_file');
  });

  it('shows risk level for write tool (legacy fallback)', () => {
    const card = renderToolCard({ name: 'write_file', args: { path: '/test.md' } });
    // write_file is not in TOOL_REGISTRY, so it falls back to legacy risk classification
    expect(card.querySelector('.tool-card-risk').textContent).toContain('写入');
  });

  it('shows product-oriented risk level for execute tool', () => {
    const card = renderToolCard({ name: 'run_code', args: { code: '1+1' } });
    // run_code has product metadata with riskLevel: 'high'
    expect(card.querySelector('.tool-card-risk').textContent).toContain('高风险');
  });

  it('shows product-oriented risk level for read tool', () => {
    const card = renderToolCard({ name: 'read_file', args: { path: '/test.md' } });
    // read_file has product metadata with riskLevel: 'medium'
    expect(card.querySelector('.tool-card-risk').textContent).toContain('中风险');
  });

  it('shows product-oriented risk level for low-risk tool', () => {
    const card = renderToolCard({ name: 'web_search', args: { query: 'test' } });
    // web_search has product metadata with riskLevel: 'low'
    expect(card.querySelector('.tool-card-risk').textContent).toContain('低风险');
  });

  it('shows auto-approved status', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, autoApproved: true });
    expect(card.querySelector('.tool-card-approval').textContent).toContain('自动通过');
  });

  it('shows pending status', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, status: 'pending' });
    expect(card.querySelector('.tool-card-approval').textContent).toContain('待审批');
  });

  it('shows approved status', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, approved: true });
    expect(card.querySelector('.tool-card-approval').textContent).toContain('已批准');
  });

  it('shows denied status', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, approved: false });
    expect(card.querySelector('.tool-card-approval').textContent).toContain('已拒绝');
  });

  it('adds repair class for repaired tools', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, isRepair: true });
    expect(card.classList.contains('tool-card--repair')).toBe(true);
  });

  it('shows duration and tokens in meta', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, durationMs: 1500, tokens: 42 });
    const meta = card.querySelector('.tool-card-meta').textContent;
    expect(meta).toContain('1.5s');
    expect(meta).toContain('42 tokens');
  });

  it('shows context compaction reason and ratio', () => {
    const card = renderToolCard({
      name: 'read_file',
      args: {},
      rawOutputTokens: 800,
      contextOutputTokens: 200,
      contextCompacted: true,
      contextCompactionRatio: 0.25,
      contextCompactionReason: 'tool_type:read_file',
      contextCompactionType: 'file',
      expanded: true,
    });
    expect(card.querySelector('.tool-card-meta').textContent).toContain('压缩 保留 25%');
    expect(card.querySelector('.tool-card-details').textContent).toContain('压缩原因：tool_type:read_file');
    expect(card.querySelector('.tool-card-details').textContent).toContain('压缩类型：file');
  });

  it('shows evidence count', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, evidenceIds: ['e1', 'e2'] });
    expect(card.querySelector('.tool-card-meta').textContent).toContain('2 证据');
  });

  it('has collapsible details section', () => {
    const card = renderToolCard({ name: 'read_file', args: { path: '/test.md' } });
    const details = card.querySelector('.tool-card-details');
    const toggle = card.querySelector('.tool-card-toggle');
    expect(details).toBeTruthy();
    expect(toggle).toBeTruthy();
    expect(details.classList.contains('is-expanded')).toBe(false);
  });

  it('can expand details via option', () => {
    const card = renderToolCard({ name: 'read_file', args: {}, expanded: true });
    expect(card.querySelector('.tool-card-details').classList.contains('is-expanded')).toBe(true);
  });
});

describe('renderToolCardList', () => {
  it('renders multiple cards', () => {
    const container = document.createElement('div');
    renderToolCardList(container, [
      { name: 'read_file', args: {} },
      { name: 'web_search', args: {} },
    ]);
    expect(container.querySelectorAll('.tool-card').length).toBe(2);
  });

  it('hides container for empty list', () => {
    const container = document.createElement('div');
    renderToolCardList(container, []);
    expect(container.hidden).toBe(true);
  });

  it('handles null container', () => {
    expect(() => renderToolCardList(null, [{ name: 'read_file', args: {} }])).not.toThrow();
  });
});
