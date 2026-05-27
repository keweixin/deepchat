import { describe, expect, it } from 'vitest';
import {
  applyPromptTemplate,
  getPromptTemplateEntries,
  getPromptTemplateRecommendedModeId,
} from '../src/modules/prompt-templates.js';

describe('prompt templates', () => {
  it('exposes high-frequency DeepChat workbench templates', () => {
    const entries = getPromptTemplateEntries();
    const titles = entries.map((entry) => entry.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        '分析当前项目',
        '优化当前文件',
        '研究一个主题',
        '生成漂亮文档',
        'Agent 执行任务',
        '排障',
        '代码审查',
      ])
    );
    expect(entries.find((entry) => entry.id === 'project-audit').text).toContain('@changed');
    expect(entries.find((entry) => entry.id === 'project-audit').text).toContain('file:line');
    expect(entries.find((entry) => entry.id === 'project-audit').text).toContain(':::todo');
    expect(entries.find((entry) => entry.id === 'project-audit')).toMatchObject({
      mode: '项目',
      intent: expect.stringContaining('@changed'),
      description: expect.stringContaining('当前仓库结构'),
    });
    expect(entries.find((entry) => entry.id === 'agent-execute').text).toContain('@changed');
    expect(entries.find((entry) => entry.id === 'agent-execute').text).toContain(':::tool-result');
    expect(entries.find((entry) => entry.id === 'agent-execute')).toMatchObject({
      mode: 'Agent',
      recommendedModeId: 'agent',
      intent: expect.stringContaining('Plan/Execute/Evidence/Final'),
    });
    expect(entries.find((entry) => entry.id === 'project-audit').recommendedModeId).toBe('project');
    expect(entries.find((entry) => entry.id === 'research-topic').recommendedModeId).toBe('research');
    expect(entries.find((entry) => entry.id === 'file-review').recommendedModeId).toBe('code');
    expect(entries.find((entry) => entry.id === 'research-topic').text).toContain('@web');
    expect(entries.find((entry) => entry.id === 'research-topic').text).toContain('官方文档');
    expect(entries.find((entry) => entry.id === 'file-review').text).toContain(':::decision');
    expect(entries.find((entry) => entry.id === 'polished-doc').text).toContain(':::summary');
    expect(entries.find((entry) => entry.id === 'polished-doc').text).toContain('不要输出原始 HTML');
    expect(entries.every((entry) => entry.mode && entry.intent && entry.description)).toBe(true);
  });

  it('appends templates without losing existing composer text', () => {
    expect(applyPromptTemplate('', '  请分析当前项目  ')).toBe('请分析当前项目');
    expect(applyPromptTemplate('已有内容\n', '模板内容')).toBe('已有内容\n\n模板内容');
    expect(applyPromptTemplate('已有内容', '')).toBe('已有内容');
  });

  it('maps template display modes to composer mode ids', () => {
    expect(getPromptTemplateRecommendedModeId({ mode: '项目' })).toBe('project');
    expect(getPromptTemplateRecommendedModeId({ mode: 'Agent' })).toBe('agent');
    expect(getPromptTemplateRecommendedModeId({ mode: '研究' })).toBe('research');
    expect(getPromptTemplateRecommendedModeId({ mode: '代码' })).toBe('code');
    expect(getPromptTemplateRecommendedModeId({ mode: 'unknown' })).toBe('daily');
  });
});
