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
    const daily = applyComposerModeToPrompt('普通问题', 'daily');
    const duplicate = applyComposerModeToPrompt('已有\n<response_mode>\n模式：项目\n</response_mode>', 'project');

    expect(project).toContain('<response_mode>');
    expect(project).toContain('模式：项目');
    expect(project).toContain('P0/P1/P2');
    expect(analysis).toContain('模式：深析');
    expect(analysis).toContain('哪些是确定结论');
    expect(agent).toContain('模式：Agent');
    expect(agent).toContain('Plan -> Execute -> Evidence -> Final');
    expect(daily).toBe('普通问题');
    expect(duplicate.match(/<response_mode>/g)).toHaveLength(1);
  });
});
