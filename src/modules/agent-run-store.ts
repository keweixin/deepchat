/**
 * Agent Run Store — Manages Agent Crew State & Transitions
 */

export const CREW_ROLES = [
  { id: 'planner', label: 'Planner', icon: '🧭', title: '计划员' },
  { id: 'reader', label: 'Reader', icon: '📄', title: '文档员' },
  { id: 'researcher', label: 'Researcher', icon: '🔎', title: '搜索员' },
  { id: 'coder', label: 'Coder', icon: '🧪', title: '实验员' },
  { id: 'reviewer', label: 'Reviewer', icon: '🛡️', title: '审核员' },
  { id: 'writer', label: 'Writer', icon: '✍️', title: '写手' },
];

export function createAgentRun(mode = 'auto') {
  return {
    id: `run_${Date.now().toString(36)}`,
    mode,
    status: 'running', // running, done, error, cancelled
    startedAt: new Date().toISOString(),
    finishedAt: null,
    crew: CREW_ROLES.map((role) => ({
      ...role,
      status: role.id === 'planner' ? 'running' : 'idle', // idle, running, done, error, waiting, skipped
      currentAction: role.id === 'planner' ? '正在拆解任务' : '等待中',
      outputSummary: '',
      linkedToolCallIds: [],
      linkedStepIds: [],
      startedAt: role.id === 'planner' ? new Date().toISOString() : null,
      finishedAt: null,
    })),
    steps: [],
  };
}

import { getToolRole, getToolSummary } from './tool-registry.js';

export function getCrewRoleForTool(toolName = '') {
  return getToolRole(toolName);
}

export function applyCrewToolRequest(agentRun: Record<string, any>, tool: Record<string, any> = {}) {
  if (!agentRun || !agentRun.crew) return;
  const toolName = tool.name || tool.function?.name || '';
  const roleId = getCrewRoleForTool(toolName);
  const member = agentRun.crew.find((m: Record<string, any>) => m.id === roleId);
  if (!member) return;

  const toolId = tool.id || tool.toolCallId || tool.callId || `${toolName}_${Date.now().toString(36)}`;
  if (!member.linkedToolCallIds.includes(toolId)) {
    member.linkedToolCallIds.push(toolId);
  }

  // Update status based on tool status
  const count = member.linkedToolCallIds.length;
  if (tool.status === 'pending') {
    member.status = 'waiting';
    member.currentAction = count > 1 ? `等待审批 ${count} 个工具（含 ${toolName}）` : `等待审批：${toolName}`;
  } else {
    member.status = 'running';
    member.currentAction = count > 1 ? `正在执行 ${count} 个工具（含 ${toolName}）` : `正在执行：${toolName}`;
  }

  if (!member.startedAt) {
    member.startedAt = new Date().toISOString();
  }
}

export function applyCrewToolResult(
  agentRun: Record<string, any>,
  event: Record<string, any> = {},
  toolCalls: Record<string, any>[] = []
) {
  if (!agentRun || !agentRun.crew) return;
  const toolId = event.toolCallId || event.id;
  const tool = toolCalls.find((t) => t.id === toolId) || event;
  const toolName = tool.name || event.name || event.toolName || '';
  if (!toolName) {
    // Cannot attribute to any role; record as orphan step
    agentRun.steps.push({ type: 'tool', status: 'unknown', label: '未知工具结果' });
    return;
  }
  const roleId = getCrewRoleForTool(toolName);
  const member = agentRun.crew.find((m: Record<string, any>) => m.id === roleId);
  if (!member) return;

  const ok = event.ok !== undefined ? event.ok : tool.ok;
  const status = event.status || tool.status || 'unknown';

  if (status === 'denied') {
    member.status = 'skipped';
    member.currentAction = `已拒绝执行 ${toolName}`;
    member.outputSummary = `审批拒绝`;
    member.finishedAt = new Date().toISOString();
  } else if (ok === false || status === 'failed') {
    member.status = 'error';
    member.currentAction = `${toolName} 执行失败`;
    member.outputSummary = event.error || event.output || '工具执行出错';
    member.finishedAt = new Date().toISOString();
  } else if (status === 'completed' || ok === true) {
    member.status = 'done';
    member.currentAction = `${toolName} 执行完毕`;

    // Create an intelligent summary via registry
    const summary = getToolSummary({
      toolName,
      args: tool.args || {},
      sources: event.sources || tool.sources || [],
      durationMs: (event.durationMs || tool.durationMs || 0) as number,
    });
    member.outputSummary = summary.label;
    member.finishedAt = new Date().toISOString();
  } else {
    // Approved but not completed yet
    member.status = 'running';
    member.currentAction = `正在运行：${toolName}`;
  }
}

export function handleCrewAgentStage(agentRun: Record<string, any>, stageEvent: Record<string, any> = {}) {
  if (!agentRun || !agentRun.crew) return;
  const stage = stageEvent.stage;

  if (stage === 'plan') {
    const planner = agentRun.crew.find((m: Record<string, any>) => m.id === 'planner');
    if (planner) {
      planner.status = 'running';
      planner.currentAction = '正在分析规划任务';
      if (stageEvent.planSummary) {
        planner.status = 'done';
        planner.currentAction = '规划完毕';
        const stepCount = stageEvent.planSummary.steps?.length || 0;
        planner.outputSummary = `已生成 ${stepCount} 步任务执行计划`;
        planner.finishedAt = new Date().toISOString();
        agentRun.steps = stageEvent.planSummary.steps || [];
      }
    }
  } else if (stage === 'memory' || stage === 'checkpoint') {
    const planner = agentRun.crew.find((m: Record<string, any>) => m.id === 'planner');
    if (planner && planner.status !== 'done' && planner.status !== 'error') {
      planner.status = 'done';
      planner.currentAction = stage === 'memory' ? '已检索历史记忆' : '已载入任务状态';
      planner.outputSummary = stageEvent.warning || '记忆前缀稳定';
    }
  } else if (stage === 'summary') {
    const reviewer = agentRun.crew.find((m: Record<string, any>) => m.id === 'reviewer');
    if (reviewer) {
      reviewer.status = 'running';
      reviewer.currentAction = '正在整理/压缩长上下文...';
      reviewer.startedAt = new Date().toISOString();
    }
  } else if (stage === 'final') {
    const writer = agentRun.crew.find((m: Record<string, any>) => m.id === 'writer');
    if (writer) {
      writer.status = 'running';
      writer.currentAction = '正在整理最终回答...';
      writer.startedAt = new Date().toISOString();
    }
    // Also, if Reviewer was running summary, complete it
    const reviewer = agentRun.crew.find((m: Record<string, any>) => m.id === 'reviewer');
    if (reviewer && reviewer.status === 'running') {
      reviewer.status = 'done';
      reviewer.currentAction = '上下文整理完毕';
      reviewer.outputSummary = '历史对话已被安全压缩';
      reviewer.finishedAt = new Date().toISOString();
    }
  }
}

export function markCrewThinking(agentRun: Record<string, any>, action = '正在理解问题和规划下一步') {
  if (!agentRun || !agentRun.crew) return;
  const planner = agentRun.crew.find((m: Record<string, any>) => m.id === 'planner');
  if (!planner || planner.status === 'done' || planner.status === 'error') return;
  planner.status = 'running';
  planner.currentAction = action;
  if (!planner.startedAt) planner.startedAt = new Date().toISOString();
}

export function markCrewWriting(agentRun: Record<string, any>, action = '正在组织回答') {
  if (!agentRun || !agentRun.crew) return;
  const now = new Date().toISOString();
  const planner = agentRun.crew.find((m: Record<string, any>) => m.id === 'planner');
  if (planner && (planner.status === 'running' || planner.status === 'idle')) {
    planner.status = 'done';
    planner.currentAction = '已完成任务理解';
    planner.outputSummary = planner.outputSummary || '已进入回答生成阶段';
    planner.finishedAt = planner.finishedAt || now;
  }
  const writer = agentRun.crew.find((m: Record<string, any>) => m.id === 'writer');
  if (writer && writer.status !== 'done' && writer.status !== 'error') {
    writer.status = 'running';
    writer.currentAction = action;
    if (!writer.startedAt) writer.startedAt = now;
  }
  if (agentRun.status !== 'error' && agentRun.status !== 'cancelled') {
    agentRun.status = 'running';
  }
}

export function markCrewMemberDone(agentRun: Record<string, any>, roleId: string, action = '已完成') {
  if (!agentRun || !agentRun.crew) return;
  const member = agentRun.crew.find((m: Record<string, any>) => m.id === roleId);
  if (member) {
    member.status = 'done';
    member.currentAction = action;
    if (!member.finishedAt) member.finishedAt = new Date().toISOString();
  }
}

export function finalizeCrewRun(agentRun: Record<string, any>, options: Record<string, any> = {}) {
  if (!agentRun || !agentRun.crew) return;
  const { aborted = false, error = '', source = 'unknown' } = options;

  // 1. If error occurred
  if (error) {
    agentRun.status = 'error';
    agentRun.finishedAt = new Date().toISOString();

    if (source === 'model_stream') {
      // Model/API/stream errors belong to Writer or Planner, not arbitrary running tool roles
      const writer = agentRun.crew.find((m: Record<string, any>) => m.id === 'writer');
      const planner = agentRun.crew.find((m: Record<string, any>) => m.id === 'planner');
      const target = writer && (writer.status === 'running' || writer.status === 'idle') ? writer : planner;
      if (target) {
        target.status = 'error';
        target.currentAction = '模型输出或网络流中断';
        target.outputSummary = error;
        target.finishedAt = new Date().toISOString();
      }
      // Mark other running/waiting members as skipped (not error) since the fault isn't theirs
      agentRun.crew.forEach((member: Record<string, any>) => {
        if (member.status === 'running' || member.status === 'waiting') {
          member.status = 'skipped';
          member.currentAction = '因模型流错误被跳过';
          member.finishedAt = new Date().toISOString();
        }
      });
      return;
    }

    // Default: mark any running/waiting agent as error (tool-level failure)
    agentRun.crew.forEach((member: Record<string, any>) => {
      if (member.status === 'running' || member.status === 'waiting') {
        member.status = 'error';
        member.currentAction = '执行中途出错中断';
        member.outputSummary = error;
        member.finishedAt = new Date().toISOString();
      }
    });
    return;
  }

  // 2. Mark Reviewer and Writer done (or skipped if aborted)
  const reviewer = agentRun.crew.find((m: Record<string, any>) => m.id === 'reviewer');
  if (reviewer && (reviewer.status === 'idle' || reviewer.status === 'running')) {
    if (aborted) {
      reviewer.status = 'skipped';
      reviewer.currentAction = '因用户停止跳过复核';
    } else {
      reviewer.status = 'done';
      reviewer.currentAction = '已完成证据审查';
      reviewer.outputSummary = '已校验所有运行工具与引用证据';
    }
    reviewer.finishedAt = new Date().toISOString();
  }

  const writer = agentRun.crew.find((m: Record<string, any>) => m.id === 'writer');
  if (writer && (writer.status === 'idle' || writer.status === 'running')) {
    if (aborted) {
      writer.status = 'skipped';
      writer.currentAction = '已停止输出';
      writer.outputSummary = '回答被用户终止';
    } else {
      writer.status = 'done';
      writer.currentAction = '已完成最终回答';
      writer.outputSummary = '内容整理已全部输出';
    }
    writer.finishedAt = new Date().toISOString();
  }

  // 3. Mark all remaining agents
  agentRun.crew.forEach((member: Record<string, any>) => {
    if (member.status === 'idle') {
      member.status = 'skipped';
      member.currentAction = '本轮跳过';
      member.outputSummary = '无相关动作';
    } else if (member.status === 'waiting') {
      member.status = aborted ? 'skipped' : 'waiting';
      member.currentAction = aborted ? '已取消等待确认' : '仍在等待确认';
      if (!member.finishedAt) member.finishedAt = new Date().toISOString();
    } else if (member.status === 'running') {
      member.status = aborted ? 'skipped' : 'done';
      if (!member.finishedAt) member.finishedAt = new Date().toISOString();
    }
  });

  const hasWaiting = agentRun.crew.some((m: Record<string, any>) => m.status === 'waiting');
  if (hasWaiting && !aborted && !error) {
    agentRun.status = 'waiting';
  } else {
    agentRun.status = aborted ? 'cancelled' : 'done';
  }
  agentRun.finishedAt = new Date().toISOString();
}
