export const COMPOSER_MODE_IDS = Object.freeze(['daily', 'analysis', 'project', 'agent', 'research', 'code', 'writing', 'polish']);

const COMPONENT_OUTPUT_GUIDE = [
  '需要精排或长回答时，优先使用 DeepChat 安全组件语法，不要输出原始 HTML。',
  '可用块：:::summary 核心结论、:::warning 风险提醒、:::decision 推荐方案、:::steps 执行步骤、:::source 来源证据、:::todo 行动清单、:::next 下一步、:::tool-result 工具结果摘要。',
].join('\n');

export const COMPOSER_MODES = Object.freeze({
  daily: {
    id: 'daily',
    label: '日常',
    description: '先给结论，保持简洁，默认不强行用工具',
    activeSkill: 'none',
    enhance: true,
    instruction: [
      '你正在以日常模式回答。',
      '先给结论，默认保持简洁；除非问题复杂，不要展开成报告。',
      '建议控制在 3 条以内；如果只是短问题，直接回答即可。',
      '默认不强行调用工具；只有问题明显需要最新事实、本地文件或代码验证时，才说明需要对应工具或配置。',
      '不确定的信息要标注“不确定”或“需要验证”。',
    ].join('\n'),
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
      COMPONENT_OUTPUT_GUIDE,
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
      COMPONENT_OUTPUT_GUIDE,
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
      '至少交叉验证 2-3 个来源；优先包含官方文档、GitHub/Issue 或独立资料。',
      '区分事实、观点和推测；最终回答必须列出来源、可信度判断，或说明无法验证。',
      COMPONENT_OUTPUT_GUIDE,
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
      '先说明代码职责或问题边界，再按 bug、安全、性能、可维护性和测试缺口审查。',
      '用户给出函数/类名时优先使用 read_symbol；需要上下文再读取精确行范围。',
      '每个问题尽量给文件位置、原因、修改建议和验证方式。',
      '涉及修改时给最小可验证方案；信息不足时先列缺口，不要编造 API 或依赖。',
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
      COMPONENT_OUTPUT_GUIDE,
      '保持专业但不啰嗦，不输出原始 HTML。',
      '不确定的信息必须标注需要验证。',
    ].join('\n'),
  },
  polish: {
    id: 'polish',
    label: '美化',
    description: '把回答升级为摘要卡片、决策、步骤和行动清单',
    activeSkill: 'none',
    enhance: true,
    instruction: [
      '你正在以输出美化模式回答。',
      COMPONENT_OUTPUT_GUIDE,
      '正文保持 Markdown 层级清晰；复杂信息优先用表格，最后给行动清单。',
      '只美化表达和结构，不编造上一文或用户问题中没有的事实。',
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
