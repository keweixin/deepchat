/**
 * Agent Theatre — Visual agent crew with CSS/SVG animations
 *
 * Design:
 * - 6 roles in a horizontal stage layout
 * - Status expressed via CSS animations (no Canvas/WebGL)
 * - SVG paths show data flow between roles
 * - Toggle between compact (agent-crew) and theatre mode
 */

import { escapeHtml } from './shared-utils.js';
import { getActorRoleForTool, TraceRecorder } from './agent-trace.js';

// ─── SVG Icons (inline, no external assets) ─────────────────────────────────

const PLANNER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`;
const READER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;
const RESEARCHER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const CODER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
const REVIEWER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`;
const WRITER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

// ─── Role Definitions ──────────────────────────────────────────────────────

interface RoleDef {
  id: string;
  label: string;
  iconSvg: string;
  color: string;
}

const ROLES: RoleDef[] = [
  { id: 'planner', label: '规划师', iconSvg: PLANNER_ICON, color: '#f59e0b' },
  { id: 'reader', label: '阅读器', iconSvg: READER_ICON, color: '#3b82f6' },
  { id: 'researcher', label: '研究员', iconSvg: RESEARCHER_ICON, color: '#8b5cf6' },
  { id: 'coder', label: '编码器', iconSvg: CODER_ICON, color: '#10b981' },
  { id: 'reviewer', label: '审核员', iconSvg: REVIEWER_ICON, color: '#ef4444' },
  { id: 'writer', label: '撰写员', iconSvg: WRITER_ICON, color: '#06b6d4' },
];

// ─── Status Animation Classes ───────────────────────────────────────────────

const STATUS_ANIMATION: Record<string, string> = {
  idle: '',
  thinking: 'theatre-actor--thinking',
  waiting_approval: 'theatre-actor--waiting',
  running_tool: 'theatre-actor--running',
  observing: 'theatre-actor--observing',
  blocked: 'theatre-actor--blocked',
  done: 'theatre-actor--done',
  error: 'theatre-actor--error',
};

// ─── Data Flow Paths (which roles connect to which) ─────────────────────────

const DATA_FLOW: { from: string; to: string }[] = [
  { from: 'planner', to: 'reader' },
  { from: 'planner', to: 'researcher' },
  { from: 'reader', to: 'coder' },
  { from: 'researcher', to: 'coder' },
  { from: 'coder', to: 'reviewer' },
  { from: 'reviewer', to: 'writer' },
  { from: 'writer', to: 'planner' }, // feedback loop
];

// ─── Theatre Rendering ──────────────────────────────────────────────────────

interface CrewMember {
  id: string;
  status: string;
  currentAction?: string;
  outputSummary?: string;
  toolCount?: number;
}

interface AgentRun {
  id?: string;
  status?: string;
  crew?: CrewMember[];
}

interface TheatreOpts {
  showFlow?: boolean;
  traceRecorder?: TraceRecorder | null;
}

/**
 * Render Agent Theatre into a container
 */
export function renderAgentTheatre(container: HTMLElement | null, agentRun: AgentRun | null, opts: TheatreOpts = {}) {
  if (!container) return;
  const showFlow = opts.showFlow !== false;
  const traceRecorder = opts.traceRecorder || null;

  // Compute tool call counts per role from traceRecorder
  const toolCountByRole = _computeToolCounts(traceRecorder);

  // Build or reuse wrapper
  let wrapper = container.querySelector('.agent-theatre-wrapper') as HTMLElement | null;
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'agent-theatre-wrapper';
    container.appendChild(wrapper);
  }

  // Determine if we need full rebuild
  const fingerprint = _buildFingerprint(agentRun);
  if ((wrapper as any).__theatreFingerprint === fingerprint && (wrapper as any).__theatreShowFlow === showFlow) {
    // Only update status animations and text
    _updateTheatreActors(wrapper, agentRun);
    return;
  }
  (wrapper as any).__theatreFingerprint = fingerprint;
  (wrapper as any).__theatreShowFlow = showFlow;

  // Full render
  wrapper.textContent = '';

  // Header
  const header = document.createElement('div');
  header.className = 'agent-theatre-header';
  header.innerHTML = /* safeSetHTML-exempt: static template */ `
    <span class="theatre-pulse"></span>
    <span class="agent-theatre-title">Agent Theatre</span>
    <span class="agent-theatre-badge">${agentRun?.status || 'idle'}</span>
  `;
  wrapper.appendChild(header);

  // Control bar (only when agent is running)
  if (agentRun?.status === 'running') {
    const controlBar = document.createElement('div');
    controlBar.className = 'theatre-control-bar';

    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'theatre-control-btn theatre-control-pause';
    pauseBtn.textContent = '暂停';
    pauseBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('deepchat:agent-pause', { detail: { runId: agentRun.id } }));
    });

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'theatre-control-btn theatre-control-skip';
    skipBtn.textContent = '跳过工具';
    skipBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('deepchat:agent-skip-tool', { detail: { runId: agentRun.id } }));
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'theatre-control-btn theatre-control-stop';
    stopBtn.textContent = '停止';
    stopBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('deepchat:agent-stop', { detail: { runId: agentRun.id } }));
    });

    controlBar.append(pauseBtn, skipBtn, stopBtn);
    wrapper.appendChild(controlBar);
  }

  // Stage: actors + SVG flow overlay
  const stage = document.createElement('div');
  stage.className = 'agent-theatre-stage';
  wrapper.appendChild(stage);

  // SVG flow layer
  let svgLayer: SVGSVGElement | null = null;
  if (showFlow) {
    svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgLayer.classList.add('agent-theatre-flow');
    svgLayer.setAttribute('preserveAspectRatio', 'none');
    stage.appendChild(svgLayer);
  }

  // Actor cards
  const actorMap = new Map<string, HTMLElement>();
  for (const role of ROLES) {
    const member = agentRun?.crew?.find((m) => m.id === role.id);
    const status = member?.status || 'idle';
    const animClass = STATUS_ANIMATION[status] || '';
    const toolCount = toolCountByRole.get(role.id) || 0;
    const statusText = member?.currentAction || _statusLabel(status);
    const actionText = statusText !== _statusLabel('idle') ? statusText : '';

    const actorEl = document.createElement('div');
    actorEl.className = `theatre-actor ${animClass}`;
    actorEl.dataset.roleId = role.id;
    actorEl.dataset.toolCount = String(toolCount);
    actorEl.innerHTML = /* safeSetHTML-exempt: static template */ `
      <div class="theatre-actor-icon" style="color:${role.color}">${role.iconSvg}</div>
      <div class="theatre-actor-name">${role.label}</div>
      <div class="theatre-actor-status">${escapeHtml(statusText)}</div>
      ${member?.outputSummary ? `<div class="theatre-actor-summary">${escapeHtml(member.outputSummary)}</div>` : ''}
      <div class="theatre-actor-tooltip" role="tooltip">
        <div class="theatre-tooltip-header" style="color:${role.color}">${role.label}</div>
        <div class="theatre-tooltip-status">${_statusLabel(status)}</div>
        ${actionText ? `<div class="theatre-tooltip-action">${escapeHtml(actionText)}</div>` : ''}
        ${toolCount > 0 ? `<div class="theatre-tooltip-meta">Tool calls: ${toolCount}</div>` : ''}
      </div>
    `;
    stage.appendChild(actorEl);
    actorMap.set(role.id, actorEl);
  }

  // Draw flow paths
  if (showFlow && svgLayer) {
    requestAnimationFrame(() => {
      _drawFlowPaths(svgLayer!, actorMap, agentRun);
    });

    // ResizeObserver: redraw paths when stage size changes
    if (typeof ResizeObserver !== 'undefined' && !(wrapper as any).__theatreResizeObserver) {
      const ro = new ResizeObserver(() => {
        const currentActors = wrapper!.querySelectorAll('.theatre-actor');
        const currentMap = new Map<string, HTMLElement>();
        for (const actor of currentActors)
          currentMap.set((actor as HTMLElement).dataset.roleId || '', actor as HTMLElement);
        _drawFlowPaths(svgLayer!, currentMap, agentRun);
      });
      ro.observe(stage);
      (wrapper as any).__theatreResizeObserver = ro;
    }
  }

  // Click: dispatch role-click event (enhanced with traceRecorder)
  stage.addEventListener('click', (e) => {
    const actorEl = (e.target as HTMLElement).closest('.theatre-actor') as HTMLElement | null;
    if (!actorEl) return;
    const roleId = actorEl.dataset.roleId;
    if (!roleId) return;

    // Highlight the clicked role
    for (const el of stage.querySelectorAll('.theatre-actor')) {
      el.classList.remove('theatre-actor--highlighted');
    }
    actorEl.classList.add('theatre-actor--highlighted');

    // Gather tool calls for this role from traceRecorder
    const roleToolCalls = _getToolCallsForRole(traceRecorder, roleId);

    stage.dispatchEvent(
      new CustomEvent('deepchat:crew-role-click', {
        bubbles: true,
        detail: {
          roleId,
          shiftKey: (e as MouseEvent).shiftKey,
          traceRecorder,
          toolCalls: roleToolCalls,
          toolCount: roleToolCalls.length,
        },
      })
    );
  });
}

/** Update actor text/status without full rebuild */
function _updateTheatreActors(wrapper: HTMLElement, agentRun: AgentRun | null) {
  const actors = wrapper.querySelectorAll('.theatre-actor');
  for (const actorEl of actors) {
    const roleId = (actorEl as HTMLElement).dataset.roleId;
    const member = agentRun?.crew?.find((m) => m.id === roleId);
    const toolCount = Number((actorEl as HTMLElement).dataset.toolCount) || 0;
    const status = member?.status || 'idle';

    // Update animation class
    Object.values(STATUS_ANIMATION).forEach((cls) => {
      if (cls) actorEl.classList.remove(cls);
    });
    const newCls = STATUS_ANIMATION[status];
    if (newCls) actorEl.classList.add(newCls);

    // Update status text
    const statusEl = actorEl.querySelector('.theatre-actor-status');
    if (statusEl) statusEl.textContent = member?.currentAction || _statusLabel(status);

    // Update summary (use textContent to avoid DOM churn)
    let summaryEl = actorEl.querySelector('.theatre-actor-summary');
    if (member?.outputSummary) {
      if (!summaryEl) {
        summaryEl = document.createElement('div');
        summaryEl.className = 'theatre-actor-summary';
        actorEl.appendChild(summaryEl);
      }
      if (summaryEl.textContent !== member.outputSummary) {
        summaryEl.textContent = member.outputSummary;
      }
    } else if (summaryEl) {
      summaryEl.remove();
    }

    // Update tooltip status text
    const tooltipStatusEl = actorEl.querySelector('.theatre-tooltip-status');
    if (tooltipStatusEl) tooltipStatusEl.textContent = _statusLabel(status);
    const tooltipActionEl = actorEl.querySelector('.theatre-tooltip-action');
    const actionText = member?.currentAction || '';
    if (actionText && actionText !== _statusLabel('idle')) {
      if (tooltipActionEl) {
        tooltipActionEl.textContent = actionText;
      } else {
        const newActionEl = document.createElement('div');
        newActionEl.className = 'theatre-tooltip-action';
        newActionEl.textContent = actionText;
        const tooltipMeta = actorEl.querySelector('.theatre-tooltip-meta');
        const tooltip = actorEl.querySelector('.theatre-actor-tooltip');
        if (tooltip) tooltip.insertBefore(newActionEl, tooltipMeta || null);
      }
    } else if (tooltipActionEl) {
      tooltipActionEl.remove();
    }
    // Update tooltip meta (tool count) — only on full rebuild via data attribute
    if (toolCount > 0) {
      const tooltipMetaEl = actorEl.querySelector('.theatre-tooltip-meta');
      if (tooltipMetaEl) tooltipMetaEl.textContent = `Tool calls: ${toolCount}`;
    }
  }

  // Update badge
  const badge = wrapper.querySelector('.agent-theatre-badge');
  if (badge) badge.textContent = agentRun?.status || 'idle';

  // Redraw flow paths if SVG exists
  const svgLayer = wrapper.querySelector('.agent-theatre-flow');
  if (svgLayer) {
    const actorMap = new Map<string, HTMLElement>();
    for (const actor of actors) actorMap.set((actor as HTMLElement).dataset.roleId || '', actor as HTMLElement);
    _drawFlowPaths(svgLayer as SVGSVGElement, actorMap, agentRun);
  }
}

/** Draw SVG paths between active actors */
function _drawFlowPaths(svg: SVGSVGElement, actorMap: Map<string, HTMLElement>, agentRun: AgentRun | null) {
  const stageRect = svg.parentElement!.getBoundingClientRect();
  const activeIds = new Set(
    (agentRun?.crew || []).filter((m) => m.status !== 'idle' && m.status !== 'skipped').map((m) => m.id)
  );

  let pathsHtml = '';
  for (const { from, to } of DATA_FLOW) {
    const fromEl = actorMap.get(from);
    const toEl = actorMap.get(to);
    if (!fromEl || !toEl) continue;

    const isActive = activeIds.has(from) && activeIds.has(to);
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    const x1 = fromRect.left + fromRect.width / 2 - stageRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - stageRect.top;
    const x2 = toRect.left + toRect.width / 2 - stageRect.left;
    const y2 = toRect.top + toRect.height / 2 - stageRect.top;

    // Control points for curved path
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2 - 20;

    pathsHtml += `<path d="M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" class="theatre-flow-path ${isActive ? 'is-active' : ''}"/>`;
  }

  svg.innerHTML = pathsHtml; /* safeSetHTML-exempt: static template */
  svg.setAttribute('viewBox', `0 0 ${stageRect.width} ${stageRect.height}`);
}

// ─── Tool Count Helpers ─────────────────────────────────────────────────────

/** Compute tool call counts per role from a TraceRecorder */
function _computeToolCounts(recorder: TraceRecorder | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (!recorder) return counts;
  const toolCalls = recorder.getAllToolCalls();
  for (const tc of toolCalls) {
    const roleId = getActorRoleForTool(tc.toolName);
    counts.set(roleId, (counts.get(roleId) || 0) + 1);
  }
  return counts;
}

/** Get tool call records for a specific role from a TraceRecorder */
function _getToolCallsForRole(recorder: TraceRecorder | null, roleId: string): Record<string, unknown>[] {
  if (!recorder) return [];
  return recorder.getAllToolCalls().filter((tc) => getActorRoleForTool(tc.toolName) === roleId);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _buildFingerprint(agentRun: AgentRun | null): string {
  if (!agentRun) return 'null';
  const crew = agentRun.crew || [];
  // Structural fingerprint only: role IDs and their ordering.
  // Status/action/summary changes MUST NOT trigger full rebuild.
  return crew.map((m) => m.id).join('|');
}

function _statusLabel(status: string): string {
  const map: Record<string, string> = {
    idle: '待机',
    thinking: '思考中',
    waiting_approval: '等待确认',
    running_tool: '执行中',
    observing: '观察中',
    blocked: '阻塞',
    done: '完成',
    error: '错误',
    skipped: '跳过',
  };
  return map[status] || status;
}

// ─── Toggle API ─────────────────────────────────────────────────────────────

/**
 * Switch between compact crew and theatre mode in a container
 */
export function setCrewDisplayMode(container: HTMLElement | null, mode: string, agentRun: AgentRun | null) {
  if (!container) return;
  container.dataset.displayMode = mode;
  const wrapper = container.querySelector('.agent-theatre-wrapper, .agent-crew-wrapper') as HTMLElement | null;
  if (wrapper) {
    if ((wrapper as any).__theatreResizeObserver) {
      (wrapper as any).__theatreResizeObserver.disconnect();
      (wrapper as any).__theatreResizeObserver = null;
    }
    wrapper.remove();
  }
  if (mode === 'theatre') {
    renderAgentTheatre(container, agentRun);
  }
  // compact mode handled by caller (agent-crew.js)
}

/**
 * Check if theatre should be shown based on settings + run state
 */
export function shouldShowTheatre(settings: Record<string, unknown>, agentRun: AgentRun | null): boolean {
  const mode = (settings.crewDisplayMode as string) || 'auto';
  if (mode === 'theatre') return true;
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  if (mode === 'tools_only') {
    return agentRun?.crew?.some((m) => m.status !== 'idle' && m.status !== 'skipped') || false;
  }
  // auto: show if any non-idle member and run has tools/stages
  const hasActivity = agentRun?.crew?.some((m) => m.status !== 'idle' && m.status !== 'skipped');
  return hasActivity || false;
}
