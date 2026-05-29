import re

with open('src/modules/chat.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: DOM element declarations - change to HTMLElement | null
old = """let $messages: HTMLElement,
  $welcome: HTMLElement,
  $convList: HTMLElement,
  $chatTitle: HTMLElement,
  $modelName: HTMLElement,
  $chatUsageBadge: HTMLElement,
  $evidencePanelBtn: HTMLElement;"""
new = """let $messages: HTMLElement | null = null,
  $welcome: HTMLElement | null = null,
  $convList: HTMLElement | null = null,
  $chatTitle: HTMLElement | null = null,
  $modelName: HTMLElement | null = null,
  $chatUsageBadge: HTMLElement | null = null,
  $evidencePanelBtn: HTMLElement | null = null;"""
content = content.replace(old, new)

# Fix 2: setBulkMode type
old = "setBulkMode: (m: Record<string, any>) => {"
new = "setBulkMode: (m: boolean) => {"
content = content.replace(old, new)

# Fix 3: Event handlers with .detail -> CustomEvent
old = "const runCodeHandler = (event: Event) => {\n    handleRunCodeBlock(event.detail)"
new = "const runCodeHandler = (event: CustomEvent) => {\n    handleRunCodeBlock(event.detail)"
content = content.replace(old, new)

# Fix 3b: traceKeyHandler -> KeyboardEvent
old = "const traceKeyHandler = (event: Event) => {\n    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {"
new = "const traceKeyHandler = (event: KeyboardEvent) => {\n    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {"
content = content.replace(old, new)

# Fix 3c: crew role click handler -> CustomEvent
old = "historyCrewContainer.addEventListener('deepchat:crew-role-click', (e: Event) => {\n        const roleId = e.detail?.roleId;"
new = "historyCrewContainer.addEventListener('deepchat:crew-role-click', (e: CustomEvent) => {\n        const roleId = e.detail?.roleId;"
content = content.replace(old, new)

# Fix 3d: crew click handler -> MouseEvent
old = "historyCrewContainer.addEventListener('click', (e: Event) => {\n        if (!e.ctrlKey && !e.metaKey) return;"
new = "historyCrewContainer.addEventListener('click', (e: MouseEvent) => {\n        if (!e.ctrlKey && !e.metaKey) return;"
content = content.replace(old, new)

# Fix 3e: onKeyDown handlers -> KeyboardEvent (4 occurrences)
for old, new in [
    ("const onKeyDown = (event: Event) => {\n    if (event.key === 'Escape') cleanup();\n  };\n  closeBtn.addEventListener('click', cleanup, { once: true });\n  overlay.addEventListener('click', (event) => {\n    if (event.target === overlay) cleanup();\n  });\n  document.addEventListener('keydown', onKeyDown);",
     "const onKeyDown = (event: KeyboardEvent) => {\n    if (event.key === 'Escape') cleanup();\n  };\n  closeBtn.addEventListener('click', cleanup, { once: true });\n  overlay.addEventListener('click', (event) => {\n    if (event.target === overlay) cleanup();\n  });\n  document.addEventListener('keydown', onKeyDown);"),
]:
    content = content.replace(old, new)

# More robust: replace all "const onKeyDown = (event: Event) => {" with KeyboardEvent
content = content.replace("const onKeyDown = (event: Event) => {", "const onKeyDown = (event: KeyboardEvent) => {")

# Fix 4: contentEl null checks in _setupMessageElement
# Line 722: const contentEl = el.querySelector('.message-content');
# Need to add null guard after this
old = """  if (msg.role === 'assistant') {
    const contentEl = el.querySelector('.message-content');
    if (msg.error) {"""
new = """  if (msg.role === 'assistant') {
    const contentEl = el.querySelector('.message-content') as HTMLElement | null;
    if (!contentEl) return;
    if (msg.error) {"""
content = content.replace(old, new)

# Fix 5: renderStoppedNotice, renderAssistantToc etc. need null-safe calls
# Line 709: renderStoppedNotice(contentEl.closest('.message-body'), idx)
old = "    if (currentMsg.stopped) renderStoppedNotice(contentEl.closest('.message-body'), idx);"
new = "    if (currentMsg.stopped) renderStoppedNotice(contentEl.closest('.message-body') as HTMLElement | null, idx);"
content = content.replace(old, new)

# Fix 6: querySelector results passed to functions expecting HTMLElement
# Line 728: renderAssistantToc(el.querySelector('.answer-toc-container'), contentEl)
old = "            renderAssistantToc(el.querySelector('.answer-toc-container'), contentEl);"
new = "            renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement | null, contentEl);"
content = content.replace(old, new)

# Fix 7: errorWrap.firstElementChild append to contentEl (Line 734)
old = "        contentEl.appendChild(errorWrap.firstElementChild);"
new = "        if (errorWrap.firstElementChild) contentEl.appendChild(errorWrap.firstElementChild);"
content = content.replace(old, new)

# Fix 8: renderErrorContent(contentEl, msg.error) - contentEl is fine since we have null guard
# But renderCompactAssistantMessage(contentEl, msg, idx) - line 739
old = "      renderCompactAssistantMessage(contentEl, msg, idx);"
new = "      renderCompactAssistantMessage(contentEl!, msg, idx);"
content = content.replace(old, new)

# Fix 9: Line 742 postProcess, 744 renderAssistantToc
old = """      postProcess(contentEl)
        .then(() => {
          renderAssistantToc(el.querySelector('.answer-toc-container'), contentEl);"""
new = """      postProcess(contentEl)
        .then(() => {
          renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement | null, contentEl);"""
content = content.replace(old, new)

# Fix 10: Line 749 renderAssistantAnswerHeader
old = "    renderAssistantAnswerHeader(el.querySelector('.answer-header-container'), msg);"
new = "    renderAssistantAnswerHeader(el.querySelector('.answer-header-container') as HTMLElement | null, msg);"
content = content.replace(old, new)

# Fix 11: Line 751 addMessageActions, renderStoppedNotice
old = "    addMessageActions(el, msg.content, msg.tokens, msg.speed, idx);\n    if (msg.stopped) renderStoppedNotice(el.querySelector('.message-body'), idx);"
new = "    addMessageActions(el, msg.content, msg.tokens, msg.speed, idx);\n    if (msg.stopped) renderStoppedNotice(el.querySelector('.message-body') as HTMLElement | null, idx);"
content = content.replace(old, new)

# Fix 12: thinkingBlock.hidden and thinkingContentEl.textContent (lines 754-758)
old = """    if (msg.thinking) {
      const thinkingBlock = el.querySelector('.thinking-block');
      const thinkingContentEl = el.querySelector('.thinking-content');
      if (thinkingBlock && thinkingContentEl) {
        thinkingBlock.hidden = false;
        thinkingContentEl.textContent = msg.thinking;
      }
    }"""
new = """    if (msg.thinking) {
      const thinkingBlock = el.querySelector('.thinking-block') as HTMLElement | null;
      const thinkingContentEl = el.querySelector('.thinking-content') as HTMLElement | null;
      if (thinkingBlock && thinkingContentEl) {
        thinkingBlock.hidden = false;
        thinkingContentEl.textContent = msg.thinking;
      }
    }"""
content = content.replace(old, new)

# Fix 13: renderToolCalls, renderEvidencePanel, renderAgentTimeline (lines 761-763)
old = """    renderToolCalls(el.querySelector('.tool-calls-container'), msg.toolCalls || []);
    renderEvidencePanel(el.querySelector('.evidence-panel'), msg.toolCalls || []);
    renderAgentTimeline(el.querySelector('.agent-timeline-container'), msg);"""
new = """    renderToolCalls(el.querySelector('.tool-calls-container') as HTMLElement | null, msg.toolCalls || []);
    renderEvidencePanel(el.querySelector('.evidence-panel') as HTMLElement | null, msg.toolCalls || []);
    renderAgentTimeline(el.querySelector('.agent-timeline-container') as HTMLElement | null, msg);"""
content = content.replace(old, new)

# Fix 14: renderCrewOrTheatre (line 781) + __crewClickBound
old = """    const historyCrewContainer = el.querySelector('.agent-crew-container');
    renderCrewOrTheatre(historyCrewContainer, agentRun);
    if (historyCrewContainer && !historyCrewContainer.__crewClickBound) {
      historyCrewContainer.__crewClickBound = true;"""
new = """    const historyCrewContainer = el.querySelector('.agent-crew-container') as HTMLElement | null;
    renderCrewOrTheatre(historyCrewContainer, agentRun);
    if (historyCrewContainer && !(historyCrewContainer as any).__crewClickBound) {
      (historyCrewContainer as any).__crewClickBound = true;"""
content = content.replace(old, new)

# Fix 15: toolNameMap indexing (line 792)
old = """        const toolNameMap = {
          reader: ['read_file', 'search_workspace', 'read_symbol'],
          researcher: ['web_search'],
          coder: ['run_code'],
        };
        const targetTools = toolNameMap[roleId];"""
new = """        const toolNameMap: Record<string, string[]> = {
          reader: ['read_file', 'search_workspace', 'read_symbol'],
          researcher: ['web_search'],
          coder: ['run_code'],
        };
        const targetTools = toolNameMap[roleId];"""
content = content.replace(old, new)

# Fix 16: block.style.outline (line 800-802) - block is Element from querySelectorAll
old = """          for (const block of blocks) {
            const nameEl = block.querySelector('.tool-call-header strong');
            if (nameEl && targetTools.some((t: string) => nameEl.textContent.includes(t))) {
              block.scrollIntoView({ behavior: 'smooth', block: 'center' });
              block.style.outline = '2px solid var(--accent-primary)';
              setTimeout(() => {
                block.style.outline = '';
              }, 2000);"""
new = """          for (const block of blocks) {
            const nameEl = block.querySelector('.tool-call-header strong');
            if (nameEl && targetTools.some((t: string) => nameEl.textContent!.includes(t))) {
              (block as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
              (block as HTMLElement).style.outline = '2px solid var(--accent-primary)';
              setTimeout(() => {
                (block as HTMLElement).style.outline = '';
              }, 2000);"""
content = content.replace(old, new)

# Fix 17: renderAssistantArtifacts, renderAssistantEvidence (lines 825-826)
old = """    renderAssistantArtifacts(el.querySelector('.artifact-container'), msg);
    renderAssistantEvidence(el.querySelector('.message-body'), msg);"""
new = """    renderAssistantArtifacts(el.querySelector('.artifact-container') as HTMLElement | null, msg);
    renderAssistantEvidence(el.querySelector('.message-body') as HTMLElement | null, msg);"""
content = content.replace(old, new)

# Fix 18: plan parameter type (line 1441)
old = "function createAgentPlanCard(plan = null, contextBudget = null) {"
new = "function createAgentPlanCard(plan: Record<string, any> | null = null, contextBudget: Record<string, any> | null = null) {"
content = content.replace(old, new)

# Fix 19: labels indexing (line 1659-1676)
old = """  const labels = {
    plan: '规划',
    memory: '压缩记忆',
    warning: '配置提示',
    model: '模型思考',
    tool: '准备工具',
    tool_pending: '等待确认',
    tool_approved: '已确认工具',
    tool_denied: '工具被拒绝',
    tool_result: '已获得结果',
    tool_failed: '工具失败',
    final: '整理回答',
    stop: '已停止',
  };
  if (stage.stage === 'plan' && stage.intent?.toolMode) {
    const mode = stage.intent.toolMode === 'none' ? '普通回答' : stage.intent.toolMode;
    return `规划工具：${mode}`;
  }
  return labels[stage.stage] || String(stage.stage || 'Agent');"""
new = """  const labels: Record<string, string> = {
    plan: '规划',
    memory: '压缩记忆',
    warning: '配置提示',
    model: '模型思考',
    tool: '准备工具',
    tool_pending: '等待确认',
    tool_approved: '已确认工具',
    tool_denied: '工具被拒绝',
    tool_result: '已获得结果',
    tool_failed: '工具失败',
    final: '整理回答',
    stop: '已停止',
  };
  if (stage.stage === 'plan' && stage.intent?.toolMode) {
    const mode = stage.intent.toolMode === 'none' ? '普通回答' : stage.intent.toolMode;
    return `规划工具：${mode}`;
  }
  return labels[stage.stage] || String(stage.stage || 'Agent');"""
content = content.replace(old, new)

# Fix 20: statusLabels indexing (line 1681-1689)
old = """  const statusLabels = {
    ready: '可继续',
    needs_attention: '需要处理',
    waiting_for_approval: '等待确认',
    failed: '上一轮失败',
    completed: '已完成',
  };
  const parts = [];
  if (checkpoint.agentStatus) parts.push(statusLabels[checkpoint.agentStatus] || checkpoint.agentStatus);"""
new = """  const statusLabels: Record<string, string> = {
    ready: '可继续',
    needs_attention: '需要处理',
    waiting_for_approval: '等待确认',
    failed: '上一轮失败',
    completed: '已完成',
  };
  const parts: string[] = [];
  if (checkpoint.agentStatus) parts.push(statusLabels[checkpoint.agentStatus] || checkpoint.agentStatus);"""
content = content.replace(old, new)

# Fix 21: formatToolTime unknown value (line 1749-1751)
old = """function formatToolTime(value: unknown) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour12: false });
}"""
new = """function formatToolTime(value: unknown) {
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour12: false });
}"""
content = content.replace(old, new)

# Fix 22: headings for...of item null (line 1923)
# The error says item is possibly null. This is likely because headings array has null elements.
old = """  for (const item of headings.slice(0, 8)) {
    const row = document.createElement('li');
    row.className = `answer-toc-item level-${item.level}`;
    const link = document.createElement('a');
    link.href = `#${item.id}`;
    link.textContent = item.text;"""
new = """  for (const item of headings.slice(0, 8)) {
    if (!item) continue;
    const row = document.createElement('li');
    row.className = `answer-toc-item level-${item.level}`;
    const link = document.createElement('a');
    link.href = `#${item.id}`;
    link.textContent = item.text;"""
content = content.replace(old, new)

# Fix 23: source type in map (line 2331-2333)
old = """      items: grounding.sources.slice(0, 3).map((source: string) => ({
        label: source.title || source.url,
        href: source.url,
      })),"""
new = """      items: grounding.sources.slice(0, 3).map((source: Record<string, any>) => ({
        label: source.title || source.url,
        href: source.url,
      })),"""
content = content.replace(old, new)

# Fix 24: usage optional chaining (line 2424-2426)
old = """  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  if (usage?.cacheHit > 0 || usage?.cacheMiss > 0) {
    parts.push(`cache ${Math.round((usage.cacheHitRate || 0) * 100)}%`);"""
new = """  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  if ((usage?.cacheHit || 0) > 0 || (usage?.cacheMiss || 0) > 0) {
    parts.push(`cache ${Math.round((usage?.cacheHitRate || 0) * 100)}%`);"""
content = content.replace(old, new)

# Fix 25: run.sources map (line 2466)
old = "    (run.sources || []).slice(0, 3).map((source: string) => source.title || source.url)"
new = "    (run.sources || []).slice(0, 3).map((source: Record<string, any>) => source.title || source.url)"
content = content.replace(old, new)

# Fix 26: contentEl in addUserMessageActions (line 2804-2834)
old = """  editBtn.addEventListener('click', () => {
    const contentEl = msgEl.querySelector('.message-content');
    const originalText = msg.content;

    contentEl.innerHTML = '';"""
new = """  editBtn.addEventListener('click', () => {
    const contentEl = msgEl.querySelector('.message-content') as HTMLElement | null;
    if (!contentEl) return;
    const originalText = msg.content;

    contentEl.innerHTML = '';"""
content = content.replace(old, new)

# Fix 27: cancelBtn click handler - contentEl.textContent (line 2828)
# Already covered by the above fix since contentEl is now typed

# Fix 28: msgEl.querySelector('.message-content')?.innerText (line 2878)
old = "    const plainText = msgEl.querySelector('.message-content')?.innerText || content;"
new = "    const plainText = (msgEl.querySelector('.message-content') as HTMLElement | null)?.innerText || content;"
content = content.replace(old, new)

# Fix 29: switchVersion parameter type (line 2987-2991)
# Need to check what switchVersion expects
# Actually the error is "Argument of type 'number' is not assignable to parameter of type 'string'"
# This might be because msgIndex is inferred as string somewhere. Let's look at addMessageActions signature.
# addMessageActions(msgEl: HTMLElement, content: string, tokens: any, speed: any, msgIndex: number)
# Wait, let me check the actual error more carefully. The error at 2988 is switchVersion(msgIndex, -1)
# If msgIndex is a parameter of addMessageActions, and it's typed as number, then -1 is also number.
# The error says number not assignable to string. So one of the params expects string.
# Let me check switchVersion definition...
# From line 3282: function switchVersion(msgIndex: string, direction: number) ??
# Wait, I need to read the function signature.

with open('src/modules/chat.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Batch 2 fixes applied")
