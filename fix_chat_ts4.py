import re

with open('src/modules/chat.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: Remove ! from variable declarations with initializers
old = """let $messages!: HTMLElement | null = null,
  $welcome!: HTMLElement | null = null,
  $convList!: HTMLElement | null = null,
  $chatTitle!: HTMLElement | null = null,
  $modelName!: HTMLElement | null = null,
  $chatUsageBadge!: HTMLElement | null = null,
  $evidencePanelBtn!: HTMLElement | null = null;"""
new = """let $messages: HTMLElement | null = null,
  $welcome: HTMLElement | null = null,
  $convList: HTMLElement | null = null,
  $chatTitle: HTMLElement | null = null,
  $modelName: HTMLElement | null = null,
  $chatUsageBadge: HTMLElement | null = null,
  $evidencePanelBtn: HTMLElement | null = null;"""
content = content.replace(old, new)

# Fix 2: Remove ! from object literal properties
content = content.replace('$convList!,', '$convList,')
content = content.replace('$messages!,', '$messages,')

# Fix 3: HTMLElement | null passed to functions expecting HTMLElement
# Line 709: renderStoppedNotice(contentEl.closest('.message-body') as HTMLElement | null, idx)
# But renderStoppedNotice expects HTMLElement, not HTMLElement | null
# Need to use `as HTMLElement` (non-null assertion via cast)
old = "    if (currentMsg.stopped) renderStoppedNotice(contentEl.closest('.message-body') as HTMLElement | null, idx);"
new = "    if (currentMsg.stopped) renderStoppedNotice(contentEl.closest('.message-body') as HTMLElement, idx);"
content = content.replace(old, new)

# Line 729: renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement | null, contentEl)
old = "            renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement | null, contentEl);"
new = "            renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement, contentEl);"
content = content.replace(old, new)

# Line 745: same
old = "          renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement | null, contentEl);"
new = "          renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement, contentEl);"
content = content.replace(old, new)

# Line 750: renderAssistantAnswerHeader
old = "    renderAssistantAnswerHeader(el.querySelector('.answer-header-container') as HTMLElement | null, msg);"
new = "    renderAssistantAnswerHeader(el.querySelector('.answer-header-container') as HTMLElement, msg);"
content = content.replace(old, new)

# Line 752: renderStoppedNotice
old = "    if (msg.stopped) renderStoppedNotice(el.querySelector('.message-body') as HTMLElement | null, idx);"
new = "    if (msg.stopped) renderStoppedNotice(el.querySelector('.message-body') as HTMLElement, idx);"
content = content.replace(old, new)

# Line 762: renderToolCalls
old = "    renderToolCalls(el.querySelector('.tool-calls-container') as HTMLElement | null, msg.toolCalls || []);"
new = "    renderToolCalls(el.querySelector('.tool-calls-container') as HTMLElement, msg.toolCalls || []);"
content = content.replace(old, new)

# Line 764: renderAgentTimeline
old = "    renderAgentTimeline(el.querySelector('.agent-timeline-container') as HTMLElement | null, msg);"
new = "    renderAgentTimeline(el.querySelector('.agent-timeline-container') as HTMLElement, msg);"
content = content.replace(old, new)

# Line 785: renderCrewOrTheatre(historyCrewContainer, agentRun)
# historyCrewContainer is HTMLElement | null. Let me check renderCrewOrTheatre signature.
# If it expects HTMLElement, cast it.
old = "    renderCrewOrTheatre(historyCrewContainer, agentRun);"
new = "    renderCrewOrTheatre(historyCrewContainer as HTMLElement, agentRun);"
content = content.replace(old, new)

# Line 826: renderAssistantArtifacts
old = "    renderAssistantArtifacts(el.querySelector('.artifact-container') as HTMLElement | null, msg);"
new = "    renderAssistantArtifacts(el.querySelector('.artifact-container') as HTMLElement, msg);"
content = content.replace(old, new)

# Line 827: renderAssistantEvidence
old = "    renderAssistantEvidence(el.querySelector('.message-body') as HTMLElement | null, msg);"
new = "    renderAssistantEvidence(el.querySelector('.message-body') as HTMLElement, msg);"
content = content.replace(old, new)

# Fix 4: btn.dataset on Element -> cast btn to HTMLElement
old = """  container.querySelectorAll('.code-copy-btn:not([data-bound])').forEach((btn) => {
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', async () => {
      const code = decodeURIComponent(btn.dataset.code || '');"""
new = """  container.querySelectorAll('.code-copy-btn:not([data-bound])').forEach((btn) => {
    const el = btn as HTMLElement;
    el.setAttribute('data-bound', '1');
    el.addEventListener('click', async () => {
      const code = decodeURIComponent(el.dataset.code || '');"""
content = content.replace(old, new)

# Also need to replace remaining btn references in this callback
old = """      (btn.querySelector('.copy-icon') as HTMLElement | null)!.hidden = true;
        (btn.querySelector('.check-icon') as HTMLElement | null)!.hidden = false;
        (btn.querySelector('.copy-text') as HTMLElement | null)!.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          (btn.querySelector('.copy-icon') as HTMLElement | null)!.hidden = false;
          (btn.querySelector('.check-icon') as HTMLElement | null)!.hidden = true;
          (btn.querySelector('.copy-text') as HTMLElement | null)!.textContent = '复制';
          btn.classList.remove('copied');"""
new = """      (el.querySelector('.copy-icon') as HTMLElement | null)!.hidden = true;
        (el.querySelector('.check-icon') as HTMLElement | null)!.hidden = false;
        (el.querySelector('.copy-text') as HTMLElement | null)!.textContent = '已复制';
        el.classList.add('copied');
        setTimeout(() => {
          (el.querySelector('.copy-icon') as HTMLElement | null)!.hidden = false;
          (el.querySelector('.check-icon') as HTMLElement | null)!.hidden = true;
          (el.querySelector('.copy-text') as HTMLElement | null)!.textContent = '复制';
          el.classList.remove('copied');"""
content = content.replace(old, new)

# Fix 5: code-run-btn dataset
old = """  container.querySelectorAll('.code-run-btn:not([data-bound])').forEach((btn) => {
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', () => {
      const code = decodeURIComponent(btn.dataset.code || '');
      document.dispatchEvent(
        new CustomEvent('deepchat:run-code-block', {
          detail: { button: btn, code, language: btn.dataset.language || 'javascript' },
        })
      );"""
new = """  container.querySelectorAll('.code-run-btn:not([data-bound])').forEach((btn) => {
    const el = btn as HTMLElement;
    el.setAttribute('data-bound', '1');
    el.addEventListener('click', () => {
      const code = decodeURIComponent(el.dataset.code || '');
      document.dispatchEvent(
        new CustomEvent('deepchat:run-code-block', {
          detail: { button: el, code, language: el.dataset.language || 'javascript' },
        })
      );"""
content = content.replace(old, new)

# Fix 6: createUsageMetric value type - need to check actual line 3145
old = """  ].forEach(([label, value]) => metrics.appendChild(createUsageMetric(label, String(value))));"""
new = """  ].forEach(([label, value]: [string, string | number]) => metrics.appendChild(createUsageMetric(label, String(value))));"""
content = content.replace(old, new)

# Fix 7: Line 3476 - renderToolCalls with HTMLElement | null
old = "          renderToolCalls(msgEl.querySelector('.tool-calls-container') as HTMLElement | null, msg.toolCalls);"
new = "          renderToolCalls(msgEl.querySelector('.tool-calls-container') as HTMLElement, msg.toolCalls);"
content = content.replace(old, new)

with open('src/modules/chat.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Batch 4 fixes applied")
