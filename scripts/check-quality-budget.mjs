import fs from 'node:fs';

const budgets = [
  { file: 'src/modules/chat.ts', maxLines: 2500 },
  { file: 'electron/chat-service.ts', maxLines: 780 },
  { file: 'electron/main.ts', maxLines: 650 },
];

let failed = false;
for (const budget of budgets) {
  const lines = fs.readFileSync(budget.file, 'utf8').split('\n').length;
  if (lines > budget.maxLines) {
    console.error(`${budget.file} has ${lines} lines; budget is ${budget.maxLines}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('Quality budgets passed.');
