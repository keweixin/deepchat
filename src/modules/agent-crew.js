/**
 * Agent Crew Component — Renders the small coordination crew view
 */

export function renderAgentCrew(container, agentRun) {
  if (!container) return;

  if (!agentRun || !agentRun.crew || agentRun.crew.length === 0) {
    container.innerHTML = '';
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

  // Calculate completed count
  const runningOrDoneCount = agentRun.crew.filter(c => ['running', 'done', 'waiting'].includes(c.status)).length;
  const totalCount = agentRun.crew.length;

  // Render header
  let header = wrapper.querySelector('.agent-crew-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'agent-crew-header';
    wrapper.appendChild(header);
  }

  const statusLabels = {
    running: '智能团队协作中',
    done: '任务协作已完成',
    error: '协作遇到错误',
    cancelled: '协作已被终止'
  };
  const activeStatusText = statusLabels[agentRun.status] || '智能团队';
  header.replaceChildren(
    createCrewHeaderTitle(agentRun.status, activeStatusText),
    createTextElement('div', 'agent-crew-badge', `${runningOrDoneCount}/${totalCount} 激活`),
  );

  // Render Grid Container
  let grid = wrapper.querySelector('.agent-crew-grid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'agent-crew-grid';
    wrapper.appendChild(grid);
  }

  // To preserve expand/collapse states of individual cards across re-renders,
  // we can check which card was expanded previously.
  const expandedCardIds = new Set();
  grid.querySelectorAll('.agent-crew-card.is-expanded').forEach(card => {
    if (card.dataset.roleId) {
      expandedCardIds.add(card.dataset.roleId);
    }
  });

  grid.innerHTML = '';

  agentRun.crew.forEach((member) => {
    const card = document.createElement('div');
    card.className = `agent-crew-card status-${member.status}`;
    card.dataset.roleId = member.id;
    if (expandedCardIds.has(member.id)) {
      card.classList.add('is-expanded');
    }

    const statusIcons = {
      idle: '○',
      running: '●',
      done: '✓',
      error: '⚠️',
      waiting: '⏳',
      skipped: '-'
    };
    const statusIcon = statusIcons[member.status] || '○';

    const toolCount = member.linkedToolCallIds?.length || 0;
    const stepCount = member.linkedStepIds?.length || 0;

    card.append(
      createCrewCardMain(member, statusIcon),
      createCrewCardDetails(member, { toolCount, stepCount }),
    );

    // Click handler to toggle details expand/collapse
    card.addEventListener('click', (e) => {
      // Don't toggle if clicking on internal elements that might have their own actions
      if (e.target.closest('.crew-detail-val a')) return;
      card.classList.toggle('is-expanded');
    });

    grid.appendChild(card);
  });
}

function createCrewHeaderTitle(status, statusText) {
  const title = document.createElement('div');
  title.className = 'agent-crew-title';

  const pulse = document.createElement('span');
  pulse.className = 'crew-pulse-icon';
  pulse.dataset.status = String(status || '');

  const name = document.createElement('strong');
  name.textContent = 'Agent Crew';

  const label = createTextElement('span', 'agent-crew-status-text', statusText || '智能团队');
  title.append(pulse, name, label);
  return title;
}

function createCrewCardMain(member = {}, statusIcon = '○') {
  const main = document.createElement('div');
  main.className = 'agent-crew-card-main';

  const icon = createTextElement('span', 'agent-crew-role-icon', member.icon || '');

  const roleInfo = document.createElement('div');
  roleInfo.className = 'agent-crew-role-info';
  roleInfo.append(
    createTextElement('span', 'agent-crew-role-label', member.label || ''),
    createTextElement('span', 'agent-crew-role-title', member.title || ''),
  );

  const status = createTextElement('span', 'agent-crew-status-dot', statusIcon);
  status.title = String(member.status || '');

  main.append(icon, roleInfo, status);
  return main;
}

function createCrewCardDetails(member = {}, { toolCount = 0, stepCount = 0 } = {}) {
  const details = document.createElement('div');
  details.className = 'agent-crew-card-details';
  details.appendChild(createCrewDetailRow('当前动作', member.currentAction || '无'));

  if (member.outputSummary) {
    details.appendChild(createCrewDetailRow('执行摘要', member.outputSummary));
  }

  const meta = document.createElement('div');
  meta.className = 'crew-detail-meta';
  if (toolCount > 0) meta.appendChild(createTextElement('span', 'crew-meta-badge', `工具 x ${toolCount}`));
  if (stepCount > 0) meta.appendChild(createTextElement('span', 'crew-meta-badge', `步骤 x ${stepCount}`));
  details.appendChild(meta);
  return details;
}

function createCrewDetailRow(label, value) {
  const row = document.createElement('div');
  row.className = 'crew-detail-row';
  row.append(
    createTextElement('span', 'crew-detail-label', label),
    createTextElement('span', 'crew-detail-val', value),
  );
  return row;
}

function createTextElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(text || '');
  return element;
}
