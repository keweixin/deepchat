export const COMPOSER_MODE_IDS = Object.freeze(['daily', 'analysis', 'project', 'agent', 'research', 'code', 'writing']);

export const COMPOSER_MODES = Object.freeze({
  daily: {
    id: 'daily',
    label: '日常',
    description: '先给结论，保持简洁，默认不强行用工具',
    activeSkill: 'none',
    enhance: true,
    instruction: '',
  },
  analysis: {
    id: 'analysis',
    label: '深析',
    description: '复杂问题按背景、原因、方案和优先级展开',
    activeSkill: 'none',
    enhance: true,
    instruction: [
      '你正在以深度分析模式回答。',
      '先给判断，再按背景、问题、原因、方案、优先级展开。',
      '输出 P0/P1/P2，并明确哪些是确定结论、哪些是推测。',
      '最后给执行顺序；不要为了形式调用工具，除非用户问题确实需要最新事实或本地证据。',
    ].join('\n'),
  },
  project: {
    id: 'project',
    label: '项目',
    description: '分析本地项目，优先保留文件证据和执行顺序',
    activeSkill: 'agent_auto',
    enhance: true,
    instruction: [
      '你正在以项目分析模式回答。',
      '先给核心判断，再按 P0/P1/P2 或执行顺序组织。',
      '涉及本地项目时，必须基于工具返回的文件、符号、行号或运行结果，不要假装读取未返回的内容。',
      '最终回答尽量说明证据来源和下一步。',
    ].join('\n'),
  },
  agent: {
    id: 'agent',
    label: 'Agent',
    description: '先规划工具流，再按证据推进并保留确认边界',
    activeSkill: 'agent_auto',
    enhance: true,
    instruction: [
      '你正在以 Agent 执行模式回答。',
      '先输出计划，明确要用哪些工具、每一步需要什么证据、哪些动作需要用户确认。',
      '按 Plan -> Execute -> Evidence -> Final 组织过程；每一步完成后展示关键证据。',
      '读取、搜索类工具可以按客户端审批流推进；运行代码、写入、MCP 外部操作和高风险动作必须等待用户确认。',
      '最终回答说明执行过的工具、来源、失败或跳过的步骤，以及下一步建议。',
    ].join('\n'),
  },
  research: {
    id: 'research',
    label: '研究',
    description: '先做搜索计划，区分事实、观点和不确定信息',
    activeSkill: 'web_search',
    enhance: true,
    instruction: [
      '你正在以研究模式回答。',
      '先给搜索/验证计划；需要外部事实时使用联网搜索。',
      '区分事实、观点和推测；最终回答必须列出来源或说明无法验证。',
      '如果缺少联网配置，明确提示需要 Tavily Key，不要编造来源。',
    ].join('\n'),
  },
  code: {
    id: 'code',
    label: '代码',
    description: '面向代码审查、符号读取、验证和最小修改建议',
    activeSkill: 'file_reader',
    enhance: true,
    instruction: [
      '你正在以代码模式回答。',
      '先说明代码职责或问题边界，再给 bug、安全、性能、可维护性和测试建议。',
      '用户给出函数/类名时优先使用 read_symbol；需要上下文再读取精确行范围。',
      '涉及修改时给最小可验证方案，并说明如何验证。',
    ].join('\n'),
  },
  writing: {
    id: 'writing',
    label: '写作',
    description: '把内容整理成精排文档、报告或行动清单',
    activeSkill: 'none',
    enhance: true,
    instruction: [
      '你正在以写作美化模式回答。',
      '使用清晰标题、摘要、表格、callout 和行动清单来组织内容。',
      '保持专业但不啰嗦，不输出原始 HTML。',
      '不确定的信息必须标注需要验证。',
    ].join('\n'),
  },
});

export function getComposerMode(modeId = 'daily') {
  return COMPOSER_MODES[modeId] || COMPOSER_MODES.daily;
}

export function buildComposerModeEntries(settings = {}) {
  return COMPOSER_MODE_IDS.map((id) => {
    const mode = getComposerMode(id);
    const unavailable = getComposerModeUnavailableReason(id, settings);
    return {
      ...mode,
      available: !unavailable,
      state: unavailable || '可用',
      activeSkill: resolveComposerModeActiveSkill(id, settings),
    };
  });
}

export function resolveComposerModeActiveSkill(modeId = 'daily', settings = {}) {
  const mode = getComposerMode(modeId);
  if (mode.id === 'research' && !settings.tavilyApiKey) return 'agent_auto';
  if (mode.id === 'code' && (!Array.isArray(settings.workspaceRoots) || settings.workspaceRoots.length === 0)) return 'agent_auto';
  return mode.activeSkill;
}

export function getComposerModeOverrides(modeId = 'daily', settings = {}) {
  const mode = getComposerMode(modeId);
  return {
    activeSkill: resolveComposerModeActiveSkill(mode.id, settings),
    enhance: mode.enhance !== false,
  };
}

export function applyComposerModeToPrompt(content = '', modeId = 'daily') {
  const text = String(content || '').trim();
  const mode = getComposerMode(modeId);
  if (!text || !mode.instruction) return text;
  if (text.includes('<response_mode>')) return text;
  return [
    text,
    '',
    '<response_mode>',
    `模式：${mode.label}`,
    mode.instruction,
    '</response_mode>',
  ].join('\n');
}

export function getComposerModeUnavailableReason(modeId = 'daily', settings = {}) {
  if (modeId === 'research' && !settings.tavilyApiKey) return '缺 Tavily Key 时会退回智能 Agent';
  if (modeId === 'code' && (!Array.isArray(settings.workspaceRoots) || settings.workspaceRoots.length === 0)) return '缺工作区时会退回智能 Agent';
  return '';
}
