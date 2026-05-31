import { describe, expect, it } from 'vitest';
import {
  applyComposerModeToPrompt,
  buildComposerModeEntries,
  getComposerModeOverrides,
  resolveComposerModeActiveSkill,
} from '../src/modules/composer-modes.js';

describe('composer modes', () => {
  it('maps visible modes to conservative tool overrides', () => {
    const settings = {
      tavilyApiKey: 'tvly-test',
      workspaceRoots: ['E:/repo'],
    };

    expect(getComposerModeOverrides('daily', settings)).toMatchObject({ activeSkill: 'none', enhance: true });
    expect(getComposerModeOverrides('analysis', settings)).toMatchObject({ activeSkill: 'none', enhance: true });
    expect(getComposerModeOverrides('project', settings)).toMatchObject({ activeSkill: 'agent_auto', enhance: true });
    expect(getComposerModeOverrides('agent', settings)).toMatchObject({ activeSkill: 'agent_auto', enhance: true });
    expect(getComposerModeOverrides('research', settings)).toMatchObject({ activeSkill: 'web_search', enhance: true });
    expect(getComposerModeOverrides('code', settings)).toMatchObject({ activeSkill: 'file_reader', enhance: true });
    expect(getComposerModeOverrides('writing', settings)).toMatchObject({ activeSkill: 'none', enhance: true });
    expect(getComposerModeOverrides('polish', settings)).toMatchObject({ activeSkill: 'none', enhance: true });
  });

  it('falls back to smart agent when mode prerequisites are missing', () => {
    expect(resolveComposerModeActiveSkill('research', { tavilyApiKey: '' })).toBe('agent_auto');
    expect(resolveComposerModeActiveSkill('code', { workspaceRoots: [] })).toBe('agent_auto');

    const entries = buildComposerModeEntries({ tavilyApiKey: '', workspaceRoots: [] });
    expect(entries.find((entry) => entry.id === 'research')).toMatchObject({
      activeSkill: 'agent_auto',
      state: '缺 Tavily Key 时会退回智能 Agent',
    });
    expect(entries.find((entry) => entry.id === 'code')).toMatchObject({
      activeSkill: 'agent_auto',
      state: '缺工作区时会退回智能 Agent',
    });
  });

  it('adds bounded response mode instructions to the outgoing prompt', () => {
    const project = applyComposerModeToPrompt('优化这个项目', 'project');
    const analysis = applyComposerModeToPrompt('评估方案', 'analysis');
    const agent = applyComposerModeToPrompt('检查项目并给证据', 'agent');
    const polish = applyComposerModeToPrompt('整理这段回答', 'polish');
    const code = applyComposerModeToPrompt('审查 @symbol:renderMarkdown', 'code');
    const daily = applyComposerModeToPrompt('普通问题', 'daily');
    const duplicate = applyComposerModeToPrompt('已有\n<response_mode>\n模式：项目\n</response_mode>', 'project');

    expect(project).toContain('<response_mode>');
    expect(project).toContain('模式：项目');
    expect(project).toContain('P0/P1/P2');
    expect(project).toContain(':::source');
    expect(project).toContain(':::tool-result');
    expect(analysis).toContain('模式：深析');
    expect(analysis).toContain('哪些是确定结论');
    expect(agent).toContain('模式：Agent');
    expect(agent).toContain('Plan -> Execute -> Evidence -> Final');
    expect(agent).toContain(':::tool-result');
    expect(agent).toContain(':::todo');
    expect(agent).toContain('不要输出原始 HTML');
    const research = applyComposerModeToPrompt('研究 DeepSeek 缓存', 'research');
    expect(research).toContain('模式：研究');
    expect(research).toContain(':::source');
    expect(research).toContain(':::decision');
    expect(polish).toContain('模式：美化');
    expect(polish).toContain(':::summary');
    expect(polish).toContain(':::source');
    expect(polish).toContain(':::todo');
    expect(polish).toContain(':::next');
    expect(polish).toContain('不要输出原始 HTML');
    expect(code).toContain('模式：代码');
    expect(code).toContain('bug、安全、性能、可维护性和测试缺口');
    expect(code).toContain('read_symbol');
    expect(code).toContain('不要编造 API');
    expect(daily).toContain('模式：日常');
    expect(daily).toContain('先给结论');
    expect(daily).toContain('建议控制在 3 条以内');
    expect(daily).toContain('默认不强行调用工具');
    expect(duplicate.match(/<response_mode>/g)).toHaveLength(1);
  });
});
