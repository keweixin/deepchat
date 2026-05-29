export const PROMPT_TEMPLATES = Object.freeze([
  {
    id: 'project-audit',
    title: '分析当前项目',
    mode: '项目',
    intent: '@changed · 工作区索引 · 证据引用',
    description: '适合快速摸清当前仓库结构、风险和 P0/P1/P2 优先级。',
    text: [
      '@changed 请分析当前工作区：',
      '1. 先建立或刷新索引，再列出最近变更文件并说明项目结构。',
      '2. 找 UI、Agent、性能、安全、工程化问题。',
      '3. 按 P0/P1/P2 给出优化建议。',
      '4. 每条建议尽量引用具体文件或 file:line 证据。',
      '5. 用 :::summary 写核心结论，用 :::source 汇总证据，用 :::todo 给出下一步顺序。',
    ].join('\n'),
  },
  {
    id: 'file-review',
    title: '优化当前文件',
    mode: '代码',
    intent: '@file · 最小 patch · 验证步骤',
    description: '适合围绕一个文件做职责梳理、问题定位和最小修改建议。',
    text: [
      '请审查 @file:{当前文件}：',
      '1. 解释它的职责。',
      '2. 找可维护性、性能、安全和测试缺口。',
      '3. 给出最小修改方案。',
      '4. 输出 patch 风格修改建议。',
      '5. 用 :::decision 给推荐改法，用 :::source 标注文件证据，用 :::steps 说明如何验证。',
    ].join('\n'),
  },
  {
    id: 'research-topic',
    title: '研究一个主题',
    mode: '研究',
    intent: '@web · 多来源交叉验证',
    description: '适合需要官方文档、独立来源和可借鉴改法的外部调研。',
    text: [
      '@web 请联网研究这个主题：',
      '主题：',
      '',
      '要求：',
      '1. 先给搜索计划。',
      '2. 至少查官方文档和两个独立来源。',
      '3. 区分事实、观点和推测。',
      '4. 总结共识和分歧。',
      '5. 用 :::summary 写核心结论，用 :::source 汇总来源，用 :::decision 给出本项目可借鉴的具体改法。',
    ].join('\n'),
  },
  {
    id: 'polished-doc',
    title: '生成漂亮文档',
    mode: '美化',
    intent: '组件化回答 · 文档排版',
    description: '适合把已有内容整理成摘要、表格、风险和行动清单齐全的精排文档。',
    text: [
      '请把上面的内容整理成一份精排文档：',
      '- 有摘要卡片。',
      '- 有目录式标题层级。',
      '- 有必要的表格。',
      '- 有风险和注意事项。',
      '- 有行动清单。',
      '- 优先使用 DeepChat 安全组件块：:::summary、:::decision、:::warning、:::source、:::todo、:::next。',
      '- 不要输出原始 HTML。',
      '- 语气专业但不啰嗦。',
    ].join('\n'),
  },
  {
    id: 'agent-execute',
    title: 'Agent 执行任务',
    mode: 'Agent',
    intent: '@changed · Plan/Execute/Evidence/Final',
    description: '适合让 Agent 按计划使用工具推进，并保留每一步证据。',
    text: [
      '@changed 请以 Agent 模式处理：',
      '1. 先建立/刷新工作区索引，再列计划。',
      '2. 低风险搜索和读取工具可按权限策略推进，并保留证据。',
      '3. 运行代码、MCP 外部操作和任何写入动作前必须询问。',
      '4. 每一步保留证据。',
      '5. 最后用 :::tool-result 总结工具结果，用 :::source 汇总读取的文件或来源，用 :::next 给下一步建议。',
      '',
      '任务：',
    ].join('\n'),
  },
  {
    id: 'debug',
    title: '排障',
    mode: '深析',
    intent: '现象 · 报错 · 验证 · 修复',
    description: '适合定位错误根因，并输出可执行的验证和修复步骤。',
    text: '请帮我排查这个问题：\n\n现象：\n报错：\n我已经尝试：\n\n请按「最可能原因 -> 如何验证 -> 修复步骤 -> 风险」回答。',
  },
  {
    id: 'compare',
    title: '对比选型',
    mode: '深析',
    intent: '表格对比 · 推荐结论',
    description: '适合多方案选型，按关键维度、场景和风险给出建议。',
    text: '请对比以下方案：A / B / C。\n\n请用表格列出关键维度、适用场景、风险，最后给推荐结论。',
  },
  {
    id: 'code-review',
    title: '代码审查',
    mode: '代码',
    intent: 'bug · 安全 · 性能 · 测试',
    description: '适合贴代码或配合 @file 做审查，重点找真实问题和测试缺口。',
    text: '请审查下面代码，重点看 bug、边界条件、安全风险、性能问题和缺少的测试：\n\n```语言\n\n```',
  },
  {
    id: 'learning',
    title: '学习讲解',
    mode: '日常',
    intent: '直观解释 · 例子 · 练习',
    description: '适合学习新概念，先讲人话，再给例子和练习题。',
    text: '请用初学者能理解的方式讲解：\n\n要求：先直观解释，再给例子，最后给练习题。',
  },
]);

const TEMPLATE_MODE_TO_COMPOSER_MODE = Object.freeze({
  日常: 'daily',
  深析: 'analysis',
  项目: 'project',
  Agent: 'agent',
  研究: 'research',
  代码: 'code',
  写作: 'writing',
  美化: 'polish',
});

export function getPromptTemplateEntries() {
  return PROMPT_TEMPLATES.map((template) => ({
    ...template,
    recommendedModeId: getPromptTemplateRecommendedModeId(template),
  }));
}

export function applyPromptTemplate(currentValue = '', templateText = '') {
  const current = String(currentValue || '');
  const text = String(templateText || '').trim();
  if (!text) return current;
  return current.trim() ? `${current.trimEnd()}\n\n${text}` : text;
}

export function getPromptTemplateRecommendedModeId(template: Record<string, any> = {}) {
  const mode = String(template.mode || '').trim();
  return TEMPLATE_MODE_TO_COMPOSER_MODE[mode] || 'daily';
}
