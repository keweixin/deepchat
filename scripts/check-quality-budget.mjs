import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const budgets = [
  {
    file: 'src/modules/chat.ts',
    maxLines: 2500,
    maxFunctionLines: 240,
    maxFunctionComplexity: 36,
    maxNesting: 6,
    maxImports: 90,
    maxExports: 130,
  },
  {
    file: 'electron/chat-service.ts',
    maxLines: 780,
    maxFunctionLines: 280,
    maxFunctionComplexity: 44,
    maxNesting: 7,
    maxImports: 90,
    maxExports: 90,
  },
  {
    file: 'electron/main.ts',
    maxLines: 650,
    maxFunctionLines: 190,
    maxFunctionComplexity: 32,
    maxNesting: 6,
    maxImports: 60,
    maxExports: 40,
  },
  {
    file: 'electron/tool-call-handler.ts',
    maxLines: 580,
    maxFunctionLines: 310,
    maxFunctionComplexity: 60,
    maxNesting: 7,
    maxImports: 40,
    maxExports: 20,
  },
  {
    file: 'electron/job-runtime.ts',
    maxLines: 620,
    maxFunctionLines: 320,
    maxFunctionComplexity: 26,
    maxNesting: 5,
    maxImports: 20,
    maxExports: 35,
  },
  {
    file: 'electron/agent-eval.ts',
    maxLines: 320,
    maxFunctionLines: 100,
    maxFunctionComplexity: 40,
    maxNesting: 12,
    maxImports: 10,
    maxExports: 20,
  },
];

export function analyzeFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  );
  const lineStarts = source.getLineStarts();
  const metrics = {
    file,
    lines: text.split(/\r?\n/).length,
    imports: 0,
    exports: 0,
    functions: [],
  };

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) metrics.imports += 1;
    if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) || hasExportModifier(node)) metrics.exports += 1;
    if (isFunctionLikeWithBody(node)) {
      metrics.functions.push(measureFunction(source, node, lineStarts));
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return metrics;
}

export function checkBudgets(budgetList = budgets) {
  const issues = [];
  const reports = budgetList.map((budget) => {
    const metrics = analyzeFile(budget.file);
    collectIssue(issues, budget, 'lines', metrics.lines, budget.maxLines, budget.file);
    collectIssue(issues, budget, 'imports', metrics.imports, budget.maxImports, budget.file);
    collectIssue(issues, budget, 'exports', metrics.exports, budget.maxExports, budget.file);
    for (const fn of metrics.functions) {
      collectIssue(issues, budget, 'function lines', fn.lines, budget.maxFunctionLines, formatFunction(fn));
      collectIssue(issues, budget, 'complexity', fn.complexity, budget.maxFunctionComplexity, formatFunction(fn));
      collectIssue(issues, budget, 'nesting', fn.maxNesting, budget.maxNesting, formatFunction(fn));
    }
    return { budget, metrics };
  });
  return { issues, reports };
}

function collectIssue(issues, budget, metric, actual, max, label) {
  if (typeof max !== 'number' || actual <= max) return;
  issues.push({
    file: budget.file,
    metric,
    actual,
    max,
    label,
  });
}

function measureFunction(source, node, lineStarts) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  const state = { complexity: 1, maxNesting: 0 };
  measureNode(node.body, state, 0);
  return {
    name: getFunctionName(node),
    startLine: start.line + 1,
    endLine: end.line + 1,
    lines: end.line - start.line + 1,
    complexity: state.complexity,
    maxNesting: state.maxNesting,
    lineStarts: lineStarts.length,
  };
}

function measureNode(node, state, nesting) {
  if (!node) return;
  if (node.kind !== ts.SyntaxKind.Block) state.maxNesting = Math.max(state.maxNesting, nesting);
  if (isDecisionNode(node)) state.complexity += 1;
  if (ts.isBinaryExpression(node) && isLogicalOperator(node.operatorToken.kind)) state.complexity += 1;
  if (isFunctionLikeWithBody(node)) return;
  const childNesting = nesting + (isNestingNode(node) ? 1 : 0);
  ts.forEachChild(node, (child) => measureNode(child, state, childNesting));
}

function isDecisionNode(node) {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node)
  );
}

function isNestingNode(node) {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node)
  );
}

function isLogicalOperator(kind) {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function isFunctionLikeWithBody(node) {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node)) &&
    Boolean(node.body)
  );
}

function hasExportModifier(node) {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function getFunctionName(node) {
  if ('name' in node && node.name) return node.name.getText();
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText();
    if (ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText();
  }
  return '<anonymous>';
}

function formatFunction(fn) {
  return `${fn.name} (${fn.startLine}-${fn.endLine})`;
}

function printSummary(reports) {
  for (const { budget, metrics } of reports) {
    const worst = [...metrics.functions]
      .sort((a, b) => b.complexity - a.complexity || b.lines - a.lines)
      .slice(0, 3)
      .map((fn) => `${fn.name}@${fn.startLine}: c${fn.complexity}/n${fn.maxNesting}/${fn.lines} lines`)
      .join('; ');
    console.log(
      `${budget.file}: ${metrics.lines} lines, ${metrics.functions.length} functions, ${metrics.imports} imports, ${metrics.exports} exports${worst ? ` | top: ${worst}` : ''}`
    );
  }
}

function runCli() {
  const { issues, reports } = checkBudgets();
  printSummary(reports);
  if (issues.length > 0) {
    console.error('\nQuality budget failed:');
    for (const issue of issues) {
      console.error(`- ${issue.file}: ${issue.label} ${issue.metric} is ${issue.actual}; budget is ${issue.max}`);
    }
    console.error(
      '\nSuggested fix: split the listed function, flatten nested branches, or move cohesive helpers to a module.'
    );
    process.exit(1);
  }
  console.log('Quality budgets passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
