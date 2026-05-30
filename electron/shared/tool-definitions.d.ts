export interface ToolDefinition {
  name: string;
  category: 'search' | 'file' | 'code' | 'git' | 'workspace' | 'mcp';
  riskLevel: 'low' | 'medium' | 'high';
  approvalPolicy: 'always_allow' | 'confirm_once' | 'confirm_always';
  parallelSafe: boolean;
  role: 'reader' | 'researcher' | 'coder' | 'reviewer' | 'planner';
  schema: any;
  productCopy: {
    purpose: string;
    scope: string;
    riskReason: string;
    icon: string;
  };
}

export const TOOL_DEFINITIONS: Record<string, ToolDefinition>;
