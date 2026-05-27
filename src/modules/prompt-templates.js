export const PROMPT_TEMPLATES = Object.freeze([
  {
    id: 'project-audit',
    title: '分析当前项目',
    text: [
      '请分析当前工作区：',
      '1. 先建立或刷新索引，说明项目结构。',
      '2. 找 UI、Agent、性能、安全、工程化问题。',
      '3. 按 P0/P1/P2 给出优化建议。',
      '4. 每条建议尽量引用具体文件或证据。',
      '5. 最后给可执行的下一步顺序。',
    ].join('\n'),
  },
  {
    id: 'file-review',
    title: '优化当前文件',
    text: [
      '请审查 @file:{当前文件}：',
      '1. 解释它的职责。',
      '2. 找可维护性、性能、安全和测试缺口。',
      '3. 给出最小修改方案。',
      '4. 输出 patch 风格修改建议。',
      '5. 说明如何验证。',
    ].join('\n'),
  },
  {
    id: 'research-topic',
    title: '研究一个主题',
    text: [
      '请联网研究这个主题：',
      '主题：',
      '',
      '要求：',
      '1. 先给搜索计划。',
      '2. 至少查官方文档和两个独立来源。',
      '3. 区分事实、观点和推测。',
      '4. 总结共识和分歧。',
      '5. 给出本项目可借鉴的具体改法。',
    ].join('\n'),
  },
  {
    id: 'polished-doc',
    title: '生成漂亮文档',
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
    text: [
      '请以 Agent 模式处理：',
      '1. 先列计划。',
      '2. 低风险搜索和读取工具可按权限策略推进。',
      '3. 运行代码、MCP 外部操作和任何写入动作前必须询问。',
      '4. 每一步保留证据。',
      '5. 最后总结结果、使用的工具、读取的文件或来源，以及下一步建议。',
      '',
      '任务：',
    ].join('\n'),
  },
  {
    id: 'debug',
    title: '排障',
    text: '请帮我排查这个问题：\n\n现象：\n报错：\n我已经尝试：\n\n请按「最可能原因 -> 如何验证 -> 修复步骤 -> 风险」回答。',
  },
  {
    id: 'compare',
    title: '对比选型',
    text: '请对比以下方案：A / B / C。\n\n请用表格列出关键维度、适用场景、风险，最后给推荐结论。',
  },
  {
    id: 'code-review',
    title: '代码审查',
    text: '请审查下面代码，重点看 bug、边界条件、安全风险、性能问题和缺少的测试：\n\n```语言\n\n```',
  },
  {
    id: 'learning',
    title: '学习讲解',
    text: '请用初学者能理解的方式讲解：\n\n要求：先直观解释，再给例子，最后给练习题。',
  },
]);

export function getPromptTemplateEntries() {
  return PROMPT_TEMPLATES.map((template) => ({ ...template }));
}

export function applyPromptTemplate(currentValue = '', templateText = '') {
  const current = String(currentValue || '');
  const text = String(templateText || '').trim();
  if (!text) return current;
  return current.trim() ? `${current.trimEnd()}\n\n${text}` : text;
}
