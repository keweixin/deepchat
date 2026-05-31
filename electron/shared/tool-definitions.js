// Shared tool definitions single source of truth - CommonJS format
const TOOL_DEFINITIONS = {
  web_search: {
    name: 'web_search',
    category: 'search',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'researcher',
    schema: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web through the configured Tavily Search API and return concise sourced results.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            queries: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 4,
              description:
                'Optional multiple planned search queries for research mode. Results are merged and de-duplicated by URL.',
            },
            max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of results.' },
          },
        },
      },
    },
    productCopy: {
      purpose: '从互联网获取最新信息和参考来源',
      scope: '外部网络资源',
      riskReason: '仅读取公开信息，不修改本地数据',
      icon: '🌐',
    },
  },
  list_files: {
    name: 'list_files',
    category: 'file',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    schema: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List text-oriented files inside a user-approved workspace directory.',
        parameters: {
          type: 'object',
          properties: {
            root: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
            directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to list.' },
            pattern: { type: 'string', description: 'Optional filename substring or simple wildcard pattern.' },
            recent_days: {
              type: 'integer',
              minimum: 1,
              maximum: 3650,
              description: 'Only include files modified within this many days.',
            },
            sort_by: {
              type: 'string',
              enum: ['name', 'modified'],
              description: 'Sort files by name or modified time.',
            },
          },
        },
      },
    },
    productCopy: {
      purpose: '查看指定目录的文件列表',
      scope: '单个目录',
      riskReason: '仅列出文件名，不读取内容',
      icon: '📂',
    },
  },
  search_workspace: {
    name: 'search_workspace',
    category: 'search',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    schema: {
      type: 'function',
      function: {
        name: 'search_workspace',
        description:
          'Search text files, file names, paths, or an exact code symbol inside a user-approved workspace. Returns IDE-like structured results with file, line range, score, kind, symbol, and snippets.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keyword or phrase to search for.' },
            symbol: {
              type: 'string',
              description: 'Optional exact function/class/variable/component symbol to search for.',
            },
            root: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
            directory: {
              type: 'string',
              description: 'Optional workspace-relative or absolute subdirectory to search.',
            },
            pattern: {
              type: 'string',
              description: 'Optional filename substring or wildcard, such as *.js or README.',
            },
            max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of file hits.' },
          },
        },
      },
    },
    productCopy: {
      purpose: '在工作区代码中搜索匹配内容',
      scope: '整个项目工作区',
      riskReason: '只读搜索，不修改代码',
      icon: '🔍',
    },
  },
  index_workspace: {
    name: 'index_workspace',
    category: 'workspace',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    schema: {
      type: 'function',
      function: {
        name: 'index_workspace',
        description:
          'Build or refresh a lightweight cached index of approved workspace text files for faster cited search.',
        parameters: {
          type: 'object',
          properties: {
            root: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
            directory: {
              type: 'string',
              description: 'Optional workspace-relative or absolute subdirectory to index.',
            },
            pattern: {
              type: 'string',
              description: 'Optional filename substring or wildcard, such as *.js or README.',
            },
            force_refresh: { type: 'boolean', description: 'Rebuild the index even when a fresh cached index exists.' },
            max_files: {
              type: 'integer',
              minimum: 1,
              maximum: 700,
              description: 'Maximum files to scan.',
            },
          },
        },
      },
    },
    productCopy: {
      purpose: '为工作区建立搜索索引以加速后续查询',
      scope: '整个项目工作区',
      riskReason: '仅构建索引，不修改源文件',
      icon: '🗂',
    },
  },
  read_file: {
    name: 'read_file',
    category: 'file',
    riskLevel: 'medium',
    approvalPolicy: 'confirm_once',
    parallelSafe: true,
    role: 'reader',
    schema: {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read a text file inside a user-approved workspace directory. Supports focused line ranges via start_line/end_line or path citations like src/file.js:10-20.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
            max_bytes: { type: 'integer', minimum: 1024, maximum: 100 * 1024, description: 'Maximum bytes to read.' },
            start_line: {
              type: 'integer',
              minimum: 1,
              description: 'Optional 1-based line number to start reading from.',
            },
            end_line: { type: 'integer', minimum: 1, description: 'Optional 1-based line number to stop reading at.' },
          },
          required: ['path'],
        },
      },
    },
    productCopy: {
      purpose: '读取单个文件的内容',
      scope: '单个文件',
      riskReason: '可能访问敏感配置文件',
      icon: '📄',
    },
  },
  read_symbol: {
    name: 'read_symbol',
    category: 'file',
    riskLevel: 'medium',
    approvalPolicy: 'confirm_once',
    parallelSafe: true,
    role: 'reader',
    schema: {
      type: 'function',
      function: {
        name: 'read_symbol',
        description:
          'Read the definition block for a function, class, variable, or component symbol inside a user-approved workspace. Prefer this before reading broad file ranges when the user names a code symbol.',
        parameters: {
          type: 'object',
          properties: {
            symbol: {
              type: 'string',
              description: 'Exact symbol name to locate, such as renderMarkdown or buildContextBudgetBundle.',
            },
            root: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
            directory: {
              type: 'string',
              description: 'Optional workspace-relative or absolute subdirectory to search.',
            },
            pattern: {
              type: 'string',
              description: 'Optional filename substring or wildcard, such as *.js or renderer.',
            },
            context_lines: {
              type: 'integer',
              minimum: 0,
              maximum: 20,
              description: 'Extra lines before and after the symbol definition.',
            },
            max_lines: {
              type: 'integer',
              minimum: 20,
              maximum: 240,
              description: 'Maximum lines returned for the symbol block.',
            },
          },
          required: ['symbol'],
        },
      },
    },
    productCopy: {
      purpose: '查找并读取指定符号（函数/类/变量）的 definition',
      scope: '工作区中匹配的文件',
      riskReason: '可能暴露内部实现细节',
      icon: '🔣',
    },
  },
  run_code: {
    name: 'run_code',
    category: 'code',
    riskLevel: 'high',
    approvalPolicy: 'confirm_always',
    parallelSafe: false,
    role: 'coder',
    schema: {
      type: 'function',
      function: {
        name: 'run_code',
        description:
          'Run a small JavaScript or Python snippet after explicit user approval. Local light isolation only: temporary cwd/HOME/TEMP, cleaned environment, timeout termination, output truncation, and secret redaction. Does not provide hard network isolation or a hard memory limit.',
        parameters: {
          type: 'object',
          properties: {
            language: { type: 'string', enum: ['javascript', 'js', 'python', 'py'], description: 'Runtime language.' },
            code: { type: 'string', description: 'Complete code snippet to execute.' },
            stdin: { type: 'string', description: 'Optional stdin.' },
          },
          required: ['language', 'code'],
        },
      },
    },
    productCopy: {
      purpose: '执行代码片段并返回运行结果',
      scope: '隔离执行 environment',
      riskReason: '执行任意代码存在安全风险',
      icon: '⚡',
    },
  },
  git_status: {
    name: 'git_status',
    category: 'git',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reviewer',
    schema: {
      type: 'function',
      function: {
        name: 'git_status',
        description:
          'Show the Git working tree status for an approved workspace directory. Returns a structured list of changed, added, deleted, untracked, and conflicted files. Read-only operation.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
          },
        },
      },
    },
    productCopy: {
      purpose: '查看当前仓库的 Git 状态',
      scope: '当前 Git 仓库',
      riskReason: '只读查询版本控制状态',
      icon: '📋',
    },
  },
  git_diff: {
    name: 'git_diff',
    category: 'git',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reviewer',
    schema: {
      type: 'function',
      function: {
        name: 'git_diff',
        description:
          'Show Git diff output for an approved workspace directory, optionally filtered to a single file or the staging area. Returns structured file list with additions, deletions, and full diff text. Read-only operation.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
            file: { type: 'string', description: 'Optional workspace-relative file path to diff.' },
            staged: { type: 'boolean', description: 'If true, show staged changes instead of unstaged changes.' },
          },
        },
      },
    },
    productCopy: {
      purpose: '查看文件的变更差异',
      scope: '指定文件或整个仓库',
      riskReason: '只读查询变更内容',
      icon: '📝',
    },
  },
  git_log: {
    name: 'git_log',
    category: 'git',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reviewer',
    schema: {
      type: 'function',
      function: {
        name: 'git_log',
        description:
          'Show Git commit history for an approved workspace directory, optionally filtered to a single file. Returns structured commit list with hash, author, date, and message. Read-only operation.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
            count: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of recent commits to show.' },
            file: { type: 'string', description: 'Optional workspace-relative file path to filter commits.' },
          },
        },
      },
    },
    productCopy: {
      purpose: '查看最近的提交历史',
      scope: '当前分支提交记录',
      riskReason: '只读查询提交历史',
      icon: '📜',
    },
  },
  project_map: {
    name: 'project_map',
    category: 'workspace',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    schema: {
      type: 'function',
      function: {
        name: 'project_map',
        description:
          'Generate a tree-like project structure overview with file counts per directory. Excludes .git, node_modules, dist, build, .cache, and release directories. Read-only, low-risk operation.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Approved workspace root. If omitted, the first configured root is used.',
            },
            maxDepth: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: 'Maximum directory depth to traverse. Defaults to 4.',
            },
            maxNodes: {
              type: 'integer',
              minimum: 10,
              maximum: 5000,
              description: 'Maximum total nodes (files + dirs) to include. Defaults to 800.',
            },
            maxEntriesPerDir: {
              type: 'integer',
              minimum: 10,
              maximum: 2000,
              description: 'Maximum entries to list per directory. Defaults to 200.',
            },
          },
        },
      },
    },
    productCopy: {
      purpose: '生成项目整体结构地图',
      scope: '整个项目工作区',
      riskReason: '仅扫描文件结构，不读取内容',
      icon: '🌳',
    },
  },
  read_many_files: {
    name: 'read_many_files',
    category: 'file',
    riskLevel: 'medium',
    approvalPolicy: 'confirm_once',
    parallelSafe: true,
    role: 'reader',
    schema: {
      type: 'function',
      function: {
        name: 'read_many_files',
        description:
          'Read multiple text files at once from an approved workspace. Each file is returned with a path header. Total output capped at 500KB. Read-only, medium-risk (bulk read) operation.',
        parameters: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 50,
              description: 'List of absolute or workspace-relative file paths to read.',
            },
            maxTotalBytes: {
              type: 'integer',
              minimum: 1024,
              maximum: 500 * 1024,
              description: 'Maximum total bytes to read across all files. Defaults to 500KB.',
            },
          },
          required: ['paths'],
        },
      },
    },
    productCopy: {
      purpose: '批量读取多个文件的内容',
      scope: '多个文件',
      riskReason: '可能一次性访问大量敏感文件',
      icon: '📄',
    },
  },
  edit_file: {
    name: 'edit_file',
    category: 'file',
    riskLevel: 'high',
    approvalPolicy: 'confirm_always',
    parallelSafe: false,
    role: 'coder',
    schema: {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Edit a file using SEARCH/REPLACE pattern. SEARCH text must uniquely match exactly one location in the file. The replacement is validated before writing, backed up, and written through a same-directory temporary file rename.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (workspace-relative or absolute).' },
            search: { type: 'string', description: 'Exact text to find in the file. Must match exactly one location.' },
            replace: { type: 'string', description: 'Text to replace the search match with.' },
          },
          required: ['path', 'search', 'replace'],
        },
      },
    },
    productCopy: {
      purpose: '通过精确搜索替换编辑文件内容',
      scope: '单个文件的指定位置',
      riskReason: '会直接修改文件内容，必须先确认修改内容',
      icon: '✏️',
    },
  },
  multi_edit: {
    name: 'multi_edit',
    category: 'file',
    riskLevel: 'high',
    approvalPolicy: 'confirm_always',
    parallelSafe: false,
    role: 'coder',
    schema: {
      type: 'function',
      function: {
        name: 'multi_edit',
        description:
          'Apply multiple SEARCH/REPLACE edits to a single file. All edits are validated before writing, backed up, and written through a same-directory temporary file rename.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path.' },
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  search: { type: 'string', description: 'Text to find.' },
                  replace: { type: 'string', description: 'Replacement text.' },
                },
                required: ['search', 'replace'],
              },
              minItems: 1,
              maxItems: 20,
              description: 'Array of search/replace edits to apply.',
            },
          },
          required: ['path', 'edits'],
        },
      },
    },
    productCopy: {
      purpose: '对单个文件应用多处精确修改',
      scope: '单个文件的多个位置',
      riskReason: '会直接修改文件内容，所有修改必须先确认',
      icon: '✏️',
    },
  },
};

module.exports = { TOOL_DEFINITIONS };
