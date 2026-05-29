import re

TYPE_MAP = {
    'content': 'string',
    'html': 'string',
    'convs': 'Record<string, any>[]',
    'id': 'string',
    'f': 'string',
    'm': 'Record<string, any>',
    'v': 'any',
    'event': 'Event',
    'modeId': 'string',
    'newTitle': 'string',
    'msgIndex': 'number',
    'newContent': 'string',
    'messages': 'Record<string, any>[]',
    'msgEl': 'HTMLElement',
    'speed': 'number',
    'contentEl': 'HTMLElement',
    'msg': 'Record<string, any>',
    'idx': 'number',
    'el': 'HTMLElement',
    'totalMessageCount': 'number',
    'stage': 'Record<string, any>',
    'tool': 'Record<string, any>',
    'e': 'Event',
    't': 'string',
    'index': 'number',
    'container': 'HTMLElement',
    'outputText': 'string',
    'card': 'HTMLElement',
    'result': 'Record<string, any>',
    'label': 'string',
    'action': 'string',
    'text': 'string',
    'bytes': 'number',
    'prompt': 'string',
    'labelText': 'string',
    'stages': 'Record<string, any>[]',
    'apiMessages': 'Record<string, any>[]',
    'conversation': 'Record<string, any>',
    'value': 'unknown',
    'artifact': 'Record<string, any>',
    'heading': 'Element',
    'status': 'Record<string, any>',
    'source': 'string',
    'citation': 'Record<string, any>',
    'item': 'Record<string, any>',
    'onClick': '() => void',
    'fileName': 'string',
    'type': 'string',
    'direction': 'string',
    'btn': 'HTMLElement',
    'run': 'Record<string, any>',
    'streaming': 'boolean',
    'wrapper': 'HTMLElement',
    'output': 'string',
    'ok': 'boolean',
    'model': 'string',
}

# Parse TS7006 errors from tsc output
errors = []
with open('chat_errors.txt', 'r', encoding='utf-8') as f:
    for line in f:
        m = re.match(r"src/modules/chat\.ts\((\d+),(\d+)\): error TS7006: Parameter '([^']+)' implicitly", line)
        if m:
            errors.append((int(m.group(1)), int(m.group(2)), m.group(3)))

with open('src/modules/chat.ts', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Group by line, sort by col desc within each line
from collections import defaultdict
by_line = defaultdict(list)
for line_no, col, param in errors:
    by_line[line_no].append((col, param))

for line_no in by_line:
    by_line[line_no].sort(key=lambda x: -x[0])

for line_no, items in by_line.items():
    idx = line_no - 1
    if idx >= len(lines):
        continue
    line = lines[idx]
    for col, param in items:
        start = col - 1
        end = start + len(param)
        if start < 0 or end > len(line):
            continue
        if line[start:end] != param:
            # Try to find the param in the line
            pos = line.find(param)
            if pos == -1:
                continue
            start = pos
            end = pos + len(param)
        # Check if already typed
        after = line[end:end+20]
        if re.match(r'\s*:', after):
            continue
        type_ = TYPE_MAP.get(param, 'any')
        line = line[:end] + ': ' + type_ + line[end:]
    lines[idx] = line

with open('src/modules/chat.ts', 'w', encoding='utf-8') as f:
    f.writelines(lines)

print(f'Fixed {len(errors)} TS7006 errors')
