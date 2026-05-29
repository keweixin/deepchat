import re

with open('src/modules/chat.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: _on($messages, ...) -> _on($messages!, ...)
# The regex might have missed some because of preceding characters
content = content.replace('_on($messages,', '_on($messages!,')
content = content.replace('scrollToBottom($messages,', 'scrollToBottom($messages!,')

# Fix 2: CustomEvent in addEventListener -> Event with cast
old = """      historyCrewContainer.addEventListener('deepchat:crew-role-click', (e: CustomEvent) => {
        const roleId = e.detail?.roleId;"""
new = """      historyCrewContainer.addEventListener('deepchat:crew-role-click', (e: Event) => {
        const roleId = (e as CustomEvent).detail?.roleId;"""
content = content.replace(old, new)

# Fix 3: forEach type annotation
old = """    ['Agent 轮次', details.usage.rounds || 1],
  ].forEach(([label, value]: [string, string | number]) => metrics.appendChild(createUsageMetric(label, String(value))));"""
new = """    ['Agent 轮次', details.usage.rounds || 1],
  ] as [string, string | number][].forEach(([label, value]) => metrics.appendChild(createUsageMetric(label, String(value))));"""
content = content.replace(old, new)

with open('src/modules/chat.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Batch 5 fixes applied")
