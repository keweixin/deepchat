import re

with open('src/modules/chat.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: All $messages usage -> $messages!
# Use regex to avoid double-fixing
content = re.sub(r'(?<![!$])\$messages\b(?!\s*[=])', r'$messages!', content)
# But fix cases where it was already $messages! -> don't double
content = content.replace('$messages!!', '$messages!')

# Fix 2: $chatTitle, $modelName, $chatUsageBadge, $evidencePanelBtn, $welcome, $convList
for var in ['$chatTitle', '$modelName', '$chatUsageBadge', '$evidencePanelBtn', '$welcome', '$convList']:
    # Replace standalone usage (not on left side of assignment, not already !)
    pattern = r'(?<![!\w])' + re.escape(var) + r'\b(?!\s*[=])'
    replacement = var + '!'
    content = re.sub(pattern, replacement, content)
    # Fix double !
    content = content.replace(var + '!!', var + '!')

# Fix 3: Fix null assertions that shouldn't be assertions (left side of assignments)
# e.g. "$messages! =" should be "$messages ="
content = content.replace('$messages! =', '$messages =')
content = content.replace('$chatTitle! =', '$chatTitle =')
content = content.replace('$modelName! =', '$modelName =')
content = content.replace('$chatUsageBadge! =', '$chatUsageBadge =')
content = content.replace('$evidencePanelBtn! =', '$evidencePanelBtn =')
content = content.replace('$welcome! =', '$welcome =')
content = content.replace('$convList! =', '$convList =')

# Fix 4: HTMLElement | null passed to functions expecting HTMLElement
# scrollToBottom($messages, smooth) -> scrollToBottom($messages!, smooth)
# But we already did $messages -> $messages! above. Let me check specific ones.

# Fix 5: labels type annotation
old = """function formatAgentStageLabel(stage: Record<string, any> = {}) {
  const labels = {
    plan: '规划工具',"""
new = """function formatAgentStageLabel(stage: Record<string, any> = {}) {
  const labels: Record<string, string> = {
    plan: '规划工具',"""
content = content.replace(old, new)

# Fix 6: contextBudget type
old = "function createAgentPlanBudgetSummary(contextBudget = null) {"
new = "function createAgentPlanBudgetSummary(contextBudget: Record<string, any> | null = null) {"
content = content.replace(old, new)

# Fix 7: switchVersion direction type
old = "function switchVersion(msgIndex: number, direction: string) {"
new = "function switchVersion(msgIndex: number, direction: number) {"
content = content.replace(old, new)

# Fix 8: usage.rounds > 1 -> (usage.rounds || 0) > 1
old = "if (usage.rounds > 1) parts.push"
new = "if ((usage.rounds || 0) > 1) parts.push"
content = content.replace(old, new)

# Fix 9: createUsageMetric label/value type
# [label, value] where value is string | number -> String(value)
old = """  ].forEach(([label, value]) => metrics.appendChild(createUsageMetric(label, value)));"""
new = """  ].forEach(([label, value]) => metrics.appendChild(createUsageMetric(label, String(value))));"""
content = content.replace(old, new)

# Fix 10: newIdx < 0 -> currentIdx is string? Let me check
# msg._versionIdx ?? totalVersions - 1 -> if _versionIdx is string, currentIdx is string
# Fix by ensuring it's a number
old = """  let currentIdx = msg._versionIdx ?? totalVersions - 1;
  const newIdx = currentIdx + direction;
  if (newIdx < 0 || newIdx >= totalVersions) return;"""
new = """  let currentIdx = Number(msg._versionIdx ?? totalVersions - 1);
  const newIdx = currentIdx + direction;
  if (newIdx < 0 || newIdx >= totalVersions) return;"""
content = content.replace(old, new)

# Fix 11: forEach with HTMLElement parameter
old = "container.querySelectorAll('.code-copy-btn:not([data-bound])').forEach((btn: HTMLElement) => {"
new = "container.querySelectorAll('.code-copy-btn:not([data-bound])').forEach((btn) => {"
content = content.replace(old, new)

old = "container.querySelectorAll('.code-run-btn:not([data-bound])').forEach((btn: HTMLElement) => {"
new = "container.querySelectorAll('.code-run-btn:not([data-bound])').forEach((btn) => {"
content = content.replace(old, new)

# Fix 12: btn.querySelector('.copy-icon').hidden -> cast to HTMLElement
old = """        btn.querySelector('.copy-icon').hidden = true;
        btn.querySelector('.check-icon').hidden = false;
        btn.querySelector('.copy-text').textContent = '已复制';"""
new = """        (btn.querySelector('.copy-icon') as HTMLElement | null)!.hidden = true;
        (btn.querySelector('.check-icon') as HTMLElement | null)!.hidden = false;
        (btn.querySelector('.copy-text') as HTMLElement | null)!.textContent = '已复制';"""
content = content.replace(old, new)

old = """          btn.querySelector('.copy-icon').hidden = false;
          btn.querySelector('.check-icon').hidden = true;
          btn.querySelector('.copy-text').textContent = '复制';"""
new = """          (btn.querySelector('.copy-icon') as HTMLElement | null)!.hidden = false;
          (btn.querySelector('.check-icon') as HTMLElement | null)!.hidden = true;
          (btn.querySelector('.copy-text') as HTMLElement | null)!.textContent = '复制';"""
content = content.replace(old, new)

# Fix 13: renderCodeOutput output type
old = """        renderCodeOutput(wrapper, output, true);
      } catch (error) {
        if (tool) {
          applyToolResult(msg.toolCalls, {
            toolCallId: tool.id,
            name: 'run_code',
            args: { language, code },
            ok: false,
            output: error.message || String(error),
          });
          syncToolRuns(msg);
          renderToolCalls(msgEl.querySelector('.tool-calls-container'), msg.toolCalls);
          persist();
        }
        renderCodeOutput(wrapper, error.message || String(error), false);"""
new = """        renderCodeOutput(wrapper, output as string, true);
      } catch (error) {
        if (tool) {
          applyToolResult(msg.toolCalls, {
            toolCallId: tool.id,
            name: 'run_code',
            args: { language, code },
            ok: false,
            output: (error as Error).message || String(error),
          });
          syncToolRuns(msg);
          renderToolCalls(msgEl.querySelector('.tool-calls-container') as HTMLElement | null, msg.toolCalls);
          persist();
        }
        renderCodeOutput(wrapper, (error as Error).message || String(error), false);"""
content = content.replace(old, new)

# Fix 14: sendBtn/stopBtn null check
old = """  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('message-input') as HTMLInputElement;

  if (streaming) {
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');"""
new = """  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('message-input') as HTMLInputElement;

  if (!sendBtn || !stopBtn) return;

  if (streaming) {
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');"""
content = content.replace(old, new)

# Fix 15: buildArtifactDownloadName type
old = "link.download = buildArtifactDownloadName(artifact, index);"
new = "link.download = buildArtifactDownloadName(artifact as any, index);"
content = content.replace(old, new)

# Fix 16: CustomEvent removeEventListener type mismatch
# document.addEventListener('deepchat:run-code-block', runCodeHandler)
# where runCodeHandler is (event: CustomEvent) => void
# Type 'CustomEvent' provides no match for the signature '(evt: Event): void'
# Fix: cast to Event
old = "document.addEventListener('deepchat:run-code-block', runCodeHandler);"
new = "document.addEventListener('deepchat:run-code-block', runCodeHandler as EventListener);"
content = content.replace(old, new)

old = "_chatCleanupFns.push(() => document.removeEventListener('deepchat:run-code-block', runCodeHandler));"
new = "_chatCleanupFns.push(() => document.removeEventListener('deepchat:run-code-block', runCodeHandler as EventListener));"
content = content.replace(old, new)

# Fix 17: createAgentPlanCard parameter - contextBudget passed to createAgentPlanBudgetSummary
# Line 1464: createAgentPlanBudgetSummary(contextBudget) but contextBudget is Record<string,any>|null
# and createAgentPlanBudgetSummary expects the same. The error is "not assignable to null | undefined"
# This means createAgentPlanBudgetSummary parameter is actually null | undefined not Record<string,any>|null
# Let me check... the function signature is createAgentPlanBudgetSummary(contextBudget: Record<string, any> | null = null)
# But the error says "not assignable to parameter of type 'null | undefined'"
# So the actual parameter type is probably `contextBudget?: null` or something
# Actually wait, the error says Record<string, any> | null is not assignable to null | undefined
# This means the parameter type is something like `null | undefined`, not `Record<string, any> | null`
# But I just changed it to `Record<string, any> | null = null`... 
# Let me re-check the actual line. It might be that my replacement didn't match.

# Fix 18: _on function - el is HTMLElement but $messages is HTMLElement | null
# Line 344: _on($messages, 'scroll', () => {
# _on expects el: HTMLElement
# Since we changed $messages to $messages!, this should be fine now.

# Fix 19: scrollToBottom($messages) -> $messages! already fixed

# Fix 20: Line 366/367 - CustomEvent addEventListener
# Actually the TS2769 might be about addEventListener expecting EventListener
# I already fixed by casting runCodeHandler to EventListener

with open('src/modules/chat.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Batch 3 fixes applied")
