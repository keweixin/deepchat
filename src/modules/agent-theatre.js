/**
 * Agent Theatre — Visual agent crew with CSS/SVG animations
 *
 * Design:
 * - 6 roles in a horizontal stage layout
 * - Status expressed via CSS animations (no Canvas/WebGL)
 * - SVG paths show data flow between roles
 * - Toggle between compact (agent-crew) and theatre mode
 */

// ─── SVG Icons (inline, no external assets) ─────────────────────────────────

const PLANNER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`;
const READER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;
const RESEARCHER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const CODER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
const REVIEWER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`;
const WRITER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

// ─── Role Definitions ──────────────────────────────────────────────────────

const ROLES = [
  { id: 'planner', label: '规划师', iconSvg: PLANNER_ICON, color: '#f59e0b' },
  { id: 'reader', label: '阅读器', iconSvg: READER_ICON, color: '#3b82f6' },
  { id: 'researcher', label: '研究员', iconSvg: RESEARCHER_ICON, color: '#8b5cf6' },
  { id: 'coder', label: '编码器', iconSvg: CODER_ICON, color: '#10b981' },
  { id: 'reviewer', label: '审核员', iconSvg: REVIEWER_ICON, color: '#ef4444' },
  { id: 'writer', label: '撰写员', iconSvg: WRITER_ICON, color: '#06b6d4' },
];

// ─── Status Animation Classes ───────────────────────────────────────────────

const STATUS_ANIMATION = {
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

const DATA_FLOW = [
  { from: 'planner', to: 'reader' },
  { from: 'planner', to: 'researcher' },
  { from: 'reader', to: 'coder' },
  { from: 'researcher', to: 'coder' },
  { from: 'coder', to: 'reviewer' },
  { from: 'reviewer', to: 'writer' },
  { from: 'writer', to: 'planner' }, // feedback loop
];

// ─── Theatre Rendering ──────────────────────────────────────────────────────

/**
 * Render Agent Theatre into a container
 * @param {HTMLElement|null} container
 * @param {Object} agentRun — run state with .crew[] members
 * @param {Object} [opts]
 * @param {boolean} [opts.showFlow=true] — show SVG data-flow lines
 */
export function renderAgentTheatre(container, agentRun, opts = {}) {
  if (!container) return;
  const showFlow = opts.showFlow !== false;

  // Build or reuse wrapper
  let wrapper = container.querySelector('.agent-theatre-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'agent-theatre-wrapper';
    container.appendChild(wrapper);
  }

  // Determine if we need full rebuild
  const fingerprint = _buildFingerprint(agentRun);
  if (wrapper.__theatreFingerprint === fingerprint && wrapper.__theatreShowFlow === showFlow) {
    // Only update status animations and text
    _updateTheatreActors(wrapper, agentRun);
    return;
  }
  wrapper.__theatreFingerprint = fingerprint;
  wrapper.__theatreShowFlow = showFlow;

  // Full render
  wrapper.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'agent-theatre-header';
  header.innerHTML = `
    <span class="theatre-pulse"></span>
    <span class="agent-theatre-title">Agent Theatre</span>
    <span class="agent-theatre-badge">${agentRun?.status || 'idle'}</span>
  `;
  wrapper.appendChild(header);

  // Stage: actors + SVG flow overlay
  const stage = document.createElement('div');
  stage.className = 'agent-theatre-stage';
  wrapper.appendChild(stage);

  // SVG flow layer
  let svgLayer = null;
  if (showFlow) {
    svgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgLayer.classList.add('agent-theatre-flow');
    svgLayer.setAttribute('preserveAspectRatio', 'none');
    stage.appendChild(svgLayer);
  }

  // Actor cards
  const actorMap = new Map();
  for (const role of ROLES) {
    const member = agentRun?.crew?.find((m) => m.id === role.id);
    const status = member?.status || 'idle';
    const animClass = STATUS_ANIMATION[status] || '';

    const actorEl = document.createElement('div');
    actorEl.className = `theatre-actor ${animClass}`;
    actorEl.dataset.roleId = role.id;
    actorEl.innerHTML = `
      <div class="theatre-actor-icon" style="color:${role.color}">${role.iconSvg}</div>
      <div class="theatre-actor-name">${role.label}</div>
      <div class="theatre-actor-status">${member?.currentAction || _statusLabel(status)}</div>
      ${member?.outputSummary ? `<div class="theatre-actor-summary">${escapeHtml(member.outputSummary)}</div>` : ''}
    `;
    stage.appendChild(actorEl);
    actorMap.set(role.id, actorEl);
  }

  // Draw flow paths
  if (showFlow && svgLayer) {
    requestAnimationFrame(() => {
      _drawFlowPaths(svgLayer, actorMap, agentRun);
    });
  }

  // Click: dispatch role-click event (same contract as agent-crew)
  stage.addEventListener('click', (e) => {
    const actorEl = e.target.closest('.theatre-actor');
    if (!actorEl) return;
    const roleId = actorEl.dataset.roleId;
    if (!roleId) return;
    stage.dispatchEvent(
      new CustomEvent('deepchat:crew-role-click', {
        bubbles: true,
        detail: { roleId, shiftKey: e.shiftKey },
      })
    );
  });
}

/** Update actor text/status without full rebuild */
function _updateTheatreActors(wrapper, agentRun) {
  const actors = wrapper.querySelectorAll('.theatre-actor');
  for (const actorEl of actors) {
    const roleId = actorEl.dataset.roleId;
    const member = agentRun?.crew?.find((m) => m.id === roleId);
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

    // Update summary
    let summaryEl = actorEl.querySelector('.theatre-actor-summary');
    if (member?.outputSummary) {
      if (!summaryEl) {
        summaryEl = document.createElement('div');
        summaryEl.className = 'theatre-actor-summary';
        actorEl.appendChild(summaryEl);
      }
      summaryEl.textContent = member.outputSummary;
    } else if (summaryEl) {
      summaryEl.remove();
    }
  }

  // Update badge
  const badge = wrapper.querySelector('.agent-theatre-badge');
  if (badge) badge.textContent = agentRun?.status || 'idle';

  // Redraw flow paths if SVG exists
  const svgLayer = wrapper.querySelector('.agent-theatre-flow');
  if (svgLayer) {
    const actorMap = new Map();
    for (const actor of actors) actorMap.set(actor.dataset.roleId, actor);
    _drawFlowPaths(svgLayer, actorMap, agentRun);
  }
}

/** Draw SVG paths between active actors */
function _drawFlowPaths(svg, actorMap, agentRun) {
  const stageRect = svg.parentElement.getBoundingClientRect();
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

  svg.innerHTML = pathsHtml;
  svg.setAttribute('viewBox', `0 0 ${stageRect.width} ${stageRect.height}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _buildFingerprint(agentRun) {
  if (!agentRun) return 'null';
  const crew = agentRun.crew || [];
  return crew.map((m) => `${m.id}:${m.status}:${m.currentAction || ''}`).join('|');
}

function _statusLabel(status) {
  const map = {
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Toggle API ─────────────────────────────────────────────────────────────

/**
 * Switch between compact crew and theatre mode in a container
 * @param {HTMLElement} container — the .agent-crew-container element
 * @param {string} mode — 'compact' | 'theatre'
 * @param {Object} agentRun
 */
export function setCrewDisplayMode(container, mode, agentRun) {
  if (!container) return;
  container.dataset.displayMode = mode;
  const wrapper = container.querySelector('.agent-theatre-wrapper, .agent-crew-wrapper');
  if (wrapper) wrapper.remove();
  if (mode === 'theatre') {
    renderAgentTheatre(container, agentRun);
  }
  // compact mode handled by caller (agent-crew.js)
}

/**
 * Check if theatre should be shown based on settings + run state
 * @param {Object} settings
 * @param {Object} agentRun
 * @returns {boolean}
 */
export function shouldShowTheatre(settings, agentRun) {
  const mode = settings?.crewDisplayMode || 'auto';
  if (mode === 'theatre') return true;
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  if (mode === 'tools_only') {
    return agentRun?.crew?.some((m) => m.status !== 'idle' && m.status !== 'skipped');
  }
  // auto: show if any non-idle member and run has tools/stages
  const hasActivity = agentRun?.crew?.some((m) => m.status !== 'idle' && m.status !== 'skipped');
  return hasActivity;
}
