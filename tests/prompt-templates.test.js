import { describe, expect, it } from 'vitest';
import {
  applyPromptTemplate,
  getPromptTemplateEntries,
} from '../src/modules/prompt-templates.js';

describe('prompt templates', () => {
  it('exposes high-frequency DeepChat workbench templates', () => {
    const entries = getPromptTemplateEntries();
    const titles = entries.map((entry) => entry.title);

    expect(titles).toEqual(expect.arrayContaining([
      '分析当前项目',
      '优化当前文件',
      '研究一个主题',
      '生成漂亮文档',
      'Agent 执行任务',
      '排障',
      '代码审查',
    ]));
    expect(entries.find((entry) => entry.id === 'project-audit').text).toContain('P0/P1/P2');
    expect(entries.find((entry) => entry.id === 'agent-execute').text).toContain('每一步保留证据');
    expect(entries.find((entry) => entry.id === 'research-topic').text).toContain('官方文档');
    expect(entries.find((entry) => entry.id === 'polished-doc').text).toContain(':::summary');
    expect(entries.find((entry) => entry.id === 'polished-doc').text).toContain('不要输出原始 HTML');
  });

  it('appends templates without losing existing composer text', () => {
    expect(applyPromptTemplate('', '  请分析当前项目  ')).toBe('请分析当前项目');
    expect(applyPromptTemplate('已有内容\n', '模板内容')).toBe('已有内容\n\n模板内容');
    expect(applyPromptTemplate('已有内容', '')).toBe('已有内容');
  });
});
