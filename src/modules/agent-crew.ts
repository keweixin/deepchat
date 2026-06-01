/**
 * Agent Crew Component — Renders the small coordination crew view
 */

export function renderAgentCrew(container: HTMLElement, agentRun: Record<string, any>) {
  if (!container) return;

  if (!agentRun || !agentRun.crew || agentRun.crew.length === 0) {
    container.textContent = '';
    container.hidden = true;
    return;
  }

  container.hidden = false;

  // Reuse or initialize the main wrapper
  let wrapper = container.querySelector('.agent-crew-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'agent-crew-wrapper';
    container.appendChild(wrapper);
  }

  const crew = Array.isArray(agentRun.crew) ? agentRun.crew : [];

  // Calculate completed count
  const runningOrDoneCount = crew.filter((c: Record<string, any>) =>
    ['running', 'done', 'waiting'].includes(c.status)
  ).length;
  const totalCount = agentRun.crew.length;

  // Render header
  let header = wrapper.querySelector('.agent-crew-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'agent-crew-header';
    wrapper.appendChild(header);
  }

  const statusLabels: Record<string, string> = {
    running: '正在处理这轮任务',
    waiting: '需要你确认后继续',
    done: '本轮任务已完成',
    error: '本轮执行遇到问题',
    cancelled: '本轮已停止',
  };
  const activeStatusText = statusLabels[agentRun.status] || '智能团队';
  const waitingCount = crew.filter((c: Record<string, any>) => c.status === 'waiting').length;
  const badgeText =
    agentRun.status === 'waiting' && waitingCount > 0
      ? `等待确认 · ${waitingCount} 个工具`
      : `${runningOrDoneCount}/${totalCount} 参与`;
  const runningCount = crew.filter((c: Record<string, any>) => c.status === 'running').length;
  const doneCount = crew.filter((c: Record<string, any>) => c.status === 'done').length;
  const skippedCount = crew.filter((c: Record<string, any>) => c.status === 'skipped').length;
  const errorCount = crew.filter((c: Record<string, any>) => c.status === 'error').length;
  const detailParts = [];
  if (runningCount > 0) detailParts.push(`运行 ${runningCount}`);
  if (waitingCount > 0) detailParts.push(`等待 ${waitingCount}`);
  if (doneCount > 0) detailParts.push(`完成 ${doneCount}`);
  if (errorCount > 0) detailParts.push(`错误 ${errorCount}`);
  if (skippedCount > 0) detailParts.push(`跳过 ${skippedCount}`);
  const badgeTitle = detailParts.length > 0 ? detailParts.join(' · ') : '智能团队状态';
  const badgeEl = createTextElement('div', 'agent-crew-badge', badgeText);
  badgeEl.title = badgeTitle;
  header.replaceChildren(createCrewHeaderTitle(agentRun.status, activeStatusText), badgeEl);

  let stage = wrapper.querySelector('.agent-crew-stage-wrap');
  if (!stage) {
    stage = document.createElement('div');
    stage.className = 'agent-crew-stage-wrap';
    wrapper.appendChild(stage);
  }
  stage.replaceChildren(createCrewStage(agentRun, crew));

  // Render Grid Container
  let grid = wrapper.querySelector('.agent-crew-grid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'agent-crew-grid';
    wrapper.appendChild(grid);
  }

  // DOM reuse map: persist across re-renders to avoid recreating cards and rebinding handlers
  let cardMap = (grid as any).__crewCardMap;
  if (!cardMap) {
    cardMap = new Map();
    (grid as any).__crewCardMap = cardMap;
  }

  const activeRoleIds = new Set();

  crew.forEach((member: Record<string, any>) => {
    activeRoleIds.add(member.id);
    let card = cardMap.get(member.id);

    if (!card) {
      card = document.createElement('button');
      card.type = 'button';
      card.dataset.roleId = member.id;
      card.addEventListener('click', (e: Event) => {
        if ((e.target as HTMLElement).closest('.crew-detail-val a')) return;
        card.dispatchEvent(
          new CustomEvent('deepchat:crew-role-click', {
            bubbles: true,
            detail: { roleId: member.id },
          })
        );
        card.classList.toggle('is-expanded');
      });
      cardMap.set(member.id, card);
      grid.appendChild(card);
    }

    // Preserve expand state while updating status class
    const wasExpanded = card.classList.contains('is-expanded');
    card.className = `agent-crew-card status-${member.status}`;
    if (wasExpanded) card.classList.add('is-expanded');

    const statusIcons: Record<string, string> = {
      idle: '○',
      running: '●',
      done: '✓',
      error: '⚠️',
      waiting: '⏳',
      skipped: '-',
    };
    const statusIcon = statusIcons[member.status] || '○';
    const toolCount = member.linkedToolCallIds?.length || 0;
    const stepCount = member.linkedStepIds?.length || 0;

    // Only rebuild children when data fingerprint changes
    const fingerprint = `${member.status}|${member.icon}|${member.label}|${member.title}|${statusIcon}|${member.currentAction || ''}|${member.outputSummary || ''}|${toolCount}|${stepCount}`;
    if ((card as any).__crewFingerprint !== fingerprint) {
      (card as any).__crewFingerprint = fingerprint;
      card.replaceChildren(
        createCrewCardMain(member, statusIcon),
        createCrewCardDetails(member, { toolCount, stepCount })
      );
    }
  });

  // Remove cards for roles no longer present
  for (const [roleId, card] of cardMap) {
    if (!activeRoleIds.has(roleId)) {
      card.remove();
      cardMap.delete(roleId);
    }
  }
}

function createCrewHeaderTitle(status: string, statusText: string) {
  const title = document.createElement('div');
  title.className = 'agent-crew-title';

  const pulse = document.createElement('span');
  pulse.className = 'crew-pulse-icon';
  pulse.dataset.status = String(status || '');

  const name = document.createElement('strong');
  name.textContent = 'AI 小队';

  const label = createTextElement('span', 'agent-crew-status-text', statusText || '智能团队');
  title.append(pulse, name, label);
  return title;
}

function createCrewStage(agentRun: Record<string, any>, crew: Record<string, any>[] = []) {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(createCrewStageMap(crew));
  fragment.appendChild(createCrewCurrentPanel(agentRun, crew));
  return fragment;
}

function createCrewStageMap(crew: Record<string, any>[] = []) {
  const stage = document.createElement('div');
  stage.className = 'agent-crew-stage';
  stage.setAttribute('role', 'list');
  stage.setAttribute('aria-label', 'AI 小队工作进度');

  const progress = document.createElement('div');
  progress.className = 'agent-crew-stage-progress';
  const progressFill = document.createElement('span');
  progressFill.style.width = `${Math.round(calculateCrewProgress(crew) * 100)}%`;
  progress.appendChild(progressFill);
  stage.appendChild(progress);

  crew.forEach((member, index) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `agent-crew-persona status-${member.status || 'idle'}${isActiveCrewMember(member) ? ' is-active' : ''}`;
    node.dataset.roleId = member.id;
    node.setAttribute('role', 'listitem');
    node.setAttribute(
      'aria-label',
      `${getCrewRoleName(member)}：${getStatusText(member.status)}，${member.currentAction || '等待中'}`
    );
    node.style.setProperty('--crew-index', String(index));
    node.addEventListener('click', () => {
      node.dispatchEvent(
        new CustomEvent('deepchat:crew-role-click', {
          bubbles: true,
          detail: { roleId: member.id },
        })
      );
    });

    const bubble = createTextElement(
      'span',
      'agent-crew-persona-bubble',
      compactActionText(member.currentAction || '等待中')
    );
    const avatar = createTextElement('span', 'agent-crew-persona-avatar', member.icon || '•');
    const label = createTextElement('span', 'agent-crew-persona-label', getCrewRoleName(member));
    const place = createTextElement('span', 'agent-crew-persona-place', getCrewPlace(member.id));
    node.append(bubble, avatar, label, place);
    stage.appendChild(node);
  });

  return stage;
}

function createCrewCurrentPanel(agentRun: Record<string, any>, crew: Record<string, any>[] = []) {
  const active = getPrimaryCrewMember(crew);
  const panel = document.createElement('div');
  panel.className = 'agent-crew-current-panel';

  const status = createTextElement('span', 'agent-crew-current-status', getRunReadableStatus(agentRun.status));
  const action = createTextElement(
    'strong',
    'agent-crew-current-action',
    active ? `${getCrewRoleName(active)}：${active.currentAction || '处理中'}` : '本轮暂无可视化步骤'
  );
  const hint = createTextElement(
    'span',
    'agent-crew-current-hint',
    active ? getStatusHelp(active.status) : '模型开始规划或调用工具后，这里会显示进度。'
  );

  panel.append(status, action, hint);
  return panel;
}

function createCrewCardMain(member: Record<string, any> = {}, statusIcon = '○') {
  const main = document.createElement('div');
  main.className = 'agent-crew-card-main';

  const icon = createTextElement('span', 'agent-crew-role-icon', member.icon || '');

  const roleInfo = document.createElement('div');
  roleInfo.className = 'agent-crew-role-info';
  roleInfo.append(
    createTextElement('span', 'agent-crew-role-label', getCrewRoleName(member)),
    createTextElement('span', 'agent-crew-role-title', getCrewPlace(member.id))
  );

  const status = createTextElement('span', 'agent-crew-status-dot', statusIcon);
  status.title = String(member.status || '');

  main.append(icon, roleInfo, status);
  return main;
}

function createCrewCardDetails(member: Record<string, any> = {}, { toolCount = 0, stepCount = 0 } = {}) {
  const details = document.createElement('div');
  details.className = 'agent-crew-card-details';
  details.appendChild(createCrewDetailRow('现在', member.currentAction || '无'));

  if (member.outputSummary) {
    details.appendChild(createCrewDetailRow('结果', member.outputSummary));
  }

  const meta = document.createElement('div');
  meta.className = 'crew-detail-meta';
  if (toolCount > 0) meta.appendChild(createTextElement('span', 'crew-meta-badge', `工具 x ${toolCount}`));
  if (stepCount > 0) meta.appendChild(createTextElement('span', 'crew-meta-badge', `步骤 x ${stepCount}`));
  details.appendChild(meta);
  return details;
}

function createCrewDetailRow(label: string, value: string) {
  const row = document.createElement('div');
  row.className = 'crew-detail-row';
  row.append(
    createTextElement('span', 'crew-detail-label', label),
    createTextElement('span', 'crew-detail-val', value)
  );
  return row;
}

function calculateCrewProgress(crew: Record<string, any>[] = []) {
  if (!crew.length) return 0;
  const weights: Record<string, number> = {
    idle: 0,
    skipped: 0.35,
    waiting: 0.55,
    running: 0.7,
    error: 0.85,
    done: 1,
  };
  const total = crew.reduce((sum, member) => sum + (weights[String(member.status || 'idle')] ?? 0), 0);
  return Math.max(0, Math.min(1, total / crew.length));
}

function getPrimaryCrewMember(crew: Record<string, any>[] = []) {
  return (
    crew.find((member) => member.status === 'waiting') ||
    crew.find((member) => member.status === 'running') ||
    [...crew].reverse().find((member) => member.status === 'error') ||
    [...crew].reverse().find((member) => member.status === 'done') ||
    crew[0] ||
    null
  );
}

function isActiveCrewMember(member: Record<string, any> = {}) {
  return ['running', 'waiting', 'error'].includes(String(member.status || ''));
}

function getCrewRoleName(member: Record<string, any> = {}) {
  return String(member.title || member.label || member.id || '成员');
}

function getCrewPlace(roleId = '') {
  const places: Record<string, string> = {
    planner: '拆任务',
    reader: '读文件',
    researcher: '查资料',
    coder: '运行/编辑',
    reviewer: '核对结果',
    writer: '写回答',
  };
  return places[String(roleId)] || '处理任务';
}

function getStatusText(status = '') {
  const labels: Record<string, string> = {
    idle: '待命',
    running: '工作中',
    done: '完成',
    error: '出错',
    waiting: '等待确认',
    skipped: '跳过',
  };
  return labels[String(status)] || '待命';
}

function getRunReadableStatus(status = '') {
  const labels: Record<string, string> = {
    running: '工作中',
    waiting: '等待确认',
    done: '已完成',
    error: '遇到问题',
    cancelled: '已停止',
  };
  return labels[String(status)] || '准备中';
}

function getStatusHelp(status = '') {
  const labels: Record<string, string> = {
    idle: '还没有轮到这个角色。',
    running: '正在处理，会继续更新。',
    done: '这一步已经完成。',
    error: '这一步失败了，可打开 Trace 查看原因。',
    waiting: '需要你先确认工具调用。',
    skipped: '本轮没有使用这个角色。',
  };
  return labels[String(status)] || '等待下一步。';
}

function compactActionText(text = '') {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '等待中';
  return normalized.length > 28 ? `${normalized.slice(0, 27)}…` : normalized;
}

function createTextElement(tag: string, className: string, text: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(text || '');
  return element;
}
