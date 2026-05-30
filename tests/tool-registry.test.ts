import { describe, it, expect } from 'vitest';
import {
  TOOL_REGISTRY,
  TOOL_NAMES,
  getToolDefinition,
  getToolIcon,
  getToolRole,
  getToolRiskLevel,
  getToolApprovalPolicy,
  isToolParallelSafe,
  getAllToolNames,
  getToolCardSummary,
  getToolSummary,
  getToolProductRiskLevel,
  hasToolProductMetadata,
  RISK_LEVEL_PRODUCT,
} from '../src/modules/tool-registry.js';

const ALL_12_TOOLS = [
  'web_search',
  'list_files',
  'search_workspace',
  'index_workspace',
  'read_file',
  'read_symbol',
  'run_code',
  'git_status',
  'git_diff',
  'git_log',
  'project_map',
  'read_many_files',
  'edit_file',
];

describe('TOOL_REGISTRY', () => {
  it('registers all 13 tools', () => {
    expect(getAllToolNames()).toEqual(expect.arrayContaining(ALL_12_TOOLS));
    expect(getAllToolNames()).toHaveLength(13);
  });

  it.each(ALL_12_TOOLS)('tool %s has all required fields', (name) => {
    const def = TOOL_REGISTRY[name];
    expect(def).toBeDefined();
    expect(def.name).toBe(name);
    expect(typeof def.icon).toBe('string');
    expect(def.icon.length).toBeGreaterThan(0);
    expect(['reader', 'researcher', 'coder', 'reviewer', 'planner']).toContain(def.role);
    expect(['low', 'medium', 'high']).toContain(def.riskLevel);
    expect(['always_allow', 'confirm_once', 'confirm_always']).toContain(def.approvalPolicy);
    expect(typeof def.parallelSafe).toBe('boolean');
    expect(typeof def.summary).toBe('function');
    expect(['search', 'file', 'code', 'git', 'workspace', 'mcp']).toContain(def.category);
  });
});

describe('getToolDefinition', () => {
  it('returns definition for known tools', () => {
    const def = getToolDefinition('web_search');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('web_search');
    expect(def!.role).toBe('researcher');
  });

  it('returns null for unknown tools', () => {
    expect(getToolDefinition('unknown_tool')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(getToolDefinition('WEB_SEARCH')).not.toBeNull();
    expect(getToolDefinition('Read_File')).not.toBeNull();
  });
});

describe('getToolIcon', () => {
  it('returns correct icons for all 12 tools', () => {
    expect(getToolIcon('web_search')).toBe('🌐'); // TOOL_ICON_MAP has 🌐 for webSearch
    expect(getToolIcon('list_files')).toBe('📂');
    expect(getToolIcon('search_workspace')).toBe('🔍');
    expect(getToolIcon('index_workspace')).toBe('🗂');
    expect(getToolIcon('read_file')).toBe('📄');
    expect(getToolIcon('read_symbol')).toBe('🔣');
    expect(getToolIcon('run_code')).toBe('⚡');
    expect(getToolIcon('git_status')).toBe('📋');
    expect(getToolIcon('git_diff')).toBe('📝');
    expect(getToolIcon('git_log')).toBe('📜');
    expect(getToolIcon('project_map')).toBe('🌳');
    expect(getToolIcon('read_many_files')).toBe('📄');
  });

  it('returns default icon for unknown tools', () => {
    expect(getToolIcon('unknown')).toBe('🛠');
  });
});

describe('getToolRole', () => {
  it('returns reader for file tools', () => {
    expect(getToolRole('read_file')).toBe('reader');
    expect(getToolRole('list_files')).toBe('reader');
    expect(getToolRole('search_workspace')).toBe('reader');
    expect(getToolRole('read_many_files')).toBe('reader');
    expect(getToolRole('project_map')).toBe('reader');
  });

  it('returns researcher for web_search', () => {
    expect(getToolRole('web_search')).toBe('researcher');
  });

  it('returns coder for run_code', () => {
    expect(getToolRole('run_code')).toBe('coder');
  });

  it('returns reviewer for git tools', () => {
    expect(getToolRole('git_status')).toBe('reviewer');
    expect(getToolRole('git_diff')).toBe('reviewer');
    expect(getToolRole('git_log')).toBe('reviewer');
  });
});

describe('getToolApprovalPolicy', () => {
  it('returns always_allow for read-only tools', () => {
    expect(getToolApprovalPolicy('web_search')).toBe('always_allow');
    expect(getToolApprovalPolicy('list_files')).toBe('always_allow');
    expect(getToolApprovalPolicy('git_status')).toBe('always_allow');
    expect(getToolApprovalPolicy('project_map')).toBe('always_allow');
  });

  it('returns confirm_once for medium-risk tools', () => {
    expect(getToolApprovalPolicy('read_file')).toBe('confirm_once');
    expect(getToolApprovalPolicy('read_symbol')).toBe('confirm_once');
    expect(getToolApprovalPolicy('read_many_files')).toBe('confirm_once');
  });

  it('returns confirm_always for high-risk tools', () => {
    expect(getToolApprovalPolicy('run_code')).toBe('confirm_always');
  });

  it('returns confirm_always for unknown tools', () => {
    expect(getToolApprovalPolicy('unknown_tool')).toBe('confirm_always');
  });
});

describe('isToolParallelSafe', () => {
  it('returns true for read-only tools', () => {
    expect(isToolParallelSafe('web_search')).toBe(true);
    expect(isToolParallelSafe('list_files')).toBe(true);
    expect(isToolParallelSafe('git_status')).toBe(true);
    expect(isToolParallelSafe('project_map')).toBe(true);
  });

  it('returns false for run_code', () => {
    expect(isToolParallelSafe('run_code')).toBe(false);
  });

  it('returns false for unknown tools', () => {
    expect(isToolParallelSafe('unknown_tool')).toBe(false);
  });
});

describe('getToolCardSummary', () => {
  it('returns meaningful summaries for all tools', () => {
    for (const name of ALL_12_TOOLS) {
      const summary = getToolCardSummary(name, {});
      expect(summary).toBeTruthy();
      expect(summary.length).toBeGreaterThan(0);
    }
  });

  it('includes query for web_search', () => {
    expect(getToolCardSummary('web_search', { query: 'test query' })).toContain('test query');
  });

  it('includes file name for read_file', () => {
    expect(getToolCardSummary('read_file', { path: '/src/index.ts' })).toContain('index.ts');
  });
});

describe('getToolSummary', () => {
  it('returns correct summary for web_search with sources', () => {
    const result = getToolSummary({ toolName: 'web_search', sources: [{}, {}, {}] });
    expect(result.label).toContain('3');
  });

  it('returns correct summary for read_file', () => {
    const result = getToolSummary({ toolName: 'read_file', args: { path: '/src/main.ts' } });
    expect(result.label).toContain('main.ts');
  });

  it('returns correct summary for git_status', () => {
    const result = getToolSummary({ toolName: 'git_status' });
    expect(result.label).toContain('Git');
  });

  it('returns correct summary for project_map', () => {
    const result = getToolSummary({ toolName: 'project_map' });
    expect(result.label).toContain('项目结构');
  });
});

describe('getToolProductRiskLevel', () => {
  it('returns low risk for web_search', () => {
    const risk = getToolProductRiskLevel('web_search');
    expect(risk.level).toBe('low');
    expect(risk.label).toBe('低风险');
    expect(risk.color).toBe('#22c55e');
  });

  it('returns medium risk for read_file', () => {
    const risk = getToolProductRiskLevel('read_file');
    expect(risk.level).toBe('medium');
    expect(risk.label).toBe('中风险');
    expect(risk.color).toBe('#eab308');
  });

  it('returns high risk for run_code', () => {
    const risk = getToolProductRiskLevel('run_code');
    expect(risk.level).toBe('high');
    expect(risk.label).toBe('高风险');
    expect(risk.color).toBe('#ef4444');
  });

  it('falls back to medium for unknown tools', () => {
    const risk = getToolProductRiskLevel('unknown_tool');
    expect(risk.level).toBe('medium');
    expect(risk.label).toBe('中风险');
  });
});

describe('hasToolProductMetadata', () => {
  it('returns true for registered tools', () => {
    expect(hasToolProductMetadata('web_search')).toBe(true);
    expect(hasToolProductMetadata('read_file')).toBe(true);
    expect(hasToolProductMetadata('run_code')).toBe(true);
  });

  it('returns false for unknown tools', () => {
    expect(hasToolProductMetadata('unknown_tool')).toBe(false);
  });
});

describe('consistency', () => {
  it('TOOL_NAMES includes git tools', () => {
    expect(TOOL_NAMES.gitStatus).toBe('git_status');
    expect(TOOL_NAMES.gitDiff).toBe('git_diff');
    expect(TOOL_NAMES.gitLog).toBe('git_log');
    expect(TOOL_NAMES.projectMap).toBe('project_map');
  });

  it('TOOL_REGISTRY keys match TOOL_NAMES values', () => {
    const registryKeys = getAllToolNames();
    const toolNameValues = Object.values(TOOL_NAMES).filter((v) => v !== 'mcp__');
    for (const name of toolNameValues) {
      if (['write_file', 'edit_file', 'generate_tree'].includes(name)) continue; // not in registry
      expect(registryKeys).toContain(name);
    }
  });
});
