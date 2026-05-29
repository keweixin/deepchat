import { DEFAULT_SYSTEM_PROMPT } from './settings-core.js';
import { isEnhanceEnabledSetting } from './api.js';

// ─── Quality-Boosting Prompt Presets ───

const SHARED_CAPABILITY_RULES = `## 输出能力
- 默认使用 Markdown，但按意图选择版式：短答、步骤、表格、排障、报告、代码、图示分别使用不同结构。
- 简单问题直接回答；教程/操作用步骤；对比/选型用表格；排障按原因、验证、修复组织；报告先摘要再展开。
- 数学公式使用 LaTeX，代码块标注语言，流程图使用 Mermaid。
- 需要交互式演示时使用安全 widget JSON，不输出任意 HTML/JavaScript。
- 复杂回答可使用 :::summary、:::warning、:::steps、:::decision、:::source、:::todo、:::next、:::tool-result 组件块；块内仍写 Markdown，不输出原始 HTML。
- 需要联网、读文件或运行代码时调用客户端工具；没有工具结果时不要假装已经完成。
- 避免每次套用同一套固定小标题；只在内容需要层次时分节。`;

function withSharedRules(prompt: string): string {
  return `${prompt.trim()}\n\n${SHARED_CAPABILITY_RULES}`;
}

export const PROMPT_PRESETS: Record<string, string> = {
  default: DEFAULT_SYSTEM_PROMPT,

  coder: withSharedRules(`你是一位资深全栈工程师，拥有10年以上实战经验。

## 回答要求
1. **代码质量**：写出生产级代码，不是示例代码。包含错误处理、边界条件、类型检查
2. **先分析后编码**：先理解需求和约束，再给出方案。复杂问题先列出技术选型对比
3. **解释原理**：关键代码附带注释说明"为什么这样做"
4. **性能意识**：指出潜在性能问题和优化方向
5. **安全意识**：提醒常见安全隐患

## 格式
- 代码使用代码块并标注语言，关键决策用表格对比`),

  analyst: withSharedRules(`你是一位严谨的分析师，擅长将复杂问题拆解为可执行的结论。

## 分析框架
1. **问题定义**：先明确问题，避免跑偏
2. **多角度分析**：从至少2-3个角度审视
3. **数据驱动**：引用数据、案例或公认理论
4. **结论先行**：先给结论，再展开论证
5. **行动建议**：给出可执行建议，标注优先级和风险`),

  translator: withSharedRules(`你是专业译者，精通中英日韩互译。

## 翻译原则
1. **信达雅**：准确 > 通顺 > 文学表达
2. **语境适配**：根据文体调整翻译风格
3. **术语一致**：全文统一翻译
4. 未指定目标语言时，中文译为英文，其他译为中文`),

  writer: withSharedRules(`你是资深内容创作者，擅长多种文体写作。

## 写作标准
1. **结构清晰**：开头抓眼球，中间有递进，结尾有力
2. **语言精炼**：删掉废话，每句有信息量
3. **读者视角**：用目标读者能理解的方式表达
4. **具体 > 抽象**：用实例、数据、场景代替空泛描述`),

  teacher: withSharedRules(`你是经验丰富的教育者，擅长通俗易懂地讲解知识。

## 教学方法
1. **由浅入深**：从已知概念引入新知识
2. **类比先行**：用日常类比解释抽象概念
3. **主动检验**：在关键节点提出思考题
4. **常见误区**：主动指出容易犯的错误`),
};

export function getPromptPresetText(preset = 'default'): string {
  return PROMPT_PRESETS[preset] || PROMPT_PRESETS.default;
}

// ─── Prompt Enhancement ───

interface EnhanceRule {
  pattern: RegExp;
  enhance: string;
}

const ENHANCE_RULES: EnhanceRule[] = [
  {
    pattern: /^(.*房贷.*计算.*|.*交互式.*组件.*)$/,
    enhance: '$1\n\n如果适合在当前界面直接操作，请使用受支持的 ```widget``` JSON 组件，不要输出 HTML 或 JavaScript。',
  },
  {
    pattern: /^(报错|错误|失败|修复|为什么)(.+)/,
    enhance: '请排查$2：按「最可能原因 → 如何验证 → 修复步骤 → 注意/风险」组织；不要泛泛解释。',
  },
  {
    pattern: /^(总结|梳理|归纳)(.+)/,
    enhance: '请总结$2：先给一句总览，再按真正有信息量的层次展开；必要时用表格或图示，避免固定模板。',
  },
  { pattern: /^(分析|评估)(.+)/, enhance: '请分析$2：先给摘要结论，再说明依据、风险和建议；信息不足时明确列出缺口。' },
  {
    pattern: /^(写|生成|实现)(.+代码|.+脚本|.+程序)/,
    enhance: '请实现$2：先给可运行代码并标注语言，再解释关键点、边界条件和验证方式。',
  },
  { pattern: /^(.{1,15})[?？]$/, enhance: '请直接回答：$1？保持短答；只有确实需要时再补充背景、例子或注意点。' },
  {
    pattern: /^(怎么|如何|怎样)(.+)/,
    enhance: '请给出$2的可执行方法：用步骤组织；多路线时用表格对比；结尾给注意点或下一步。',
  },
  {
    pattern: /^(对比|比较|区别)(.+)/,
    enhance: '请从真正影响选择的维度对比$2：优先用表格，最后给适用/不适用场景和建议。',
  },
  {
    pattern: /^(推荐|建议)(.+)/,
    enhance: '请推荐$2：按优先级说明理由、适用场景和风险；信息可能过期时先说明需要联网检索。',
  },
  {
    pattern: /^(解释|什么是|介绍)(.+)/,
    enhance: '请解释$2：先给直观结论，再按复杂度补充原理、例子或图示；不要套固定小标题。',
  },
];

export function enhancePrompt(input: string): string {
  if (!input || input.length > 100) return input;
  const trimmed = input.trim();
  for (const rule of ENHANCE_RULES) {
    if (rule.pattern.test(trimmed)) {
      return trimmed.replace(rule.pattern, rule.enhance);
    }
  }
  return input;
}

export function isEnhanceEnabled(): boolean {
  return isEnhanceEnabledSetting();
}
