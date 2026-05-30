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

  // Calculate completed count
  const runningOrDoneCount = agentRun.crew.filter((c: Record<string, any>) =>
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
    running: '智能团队协作中',
    waiting: '等待你确认',
    done: '任务协作已完成',
    error: '协作遇到错误',
    cancelled: '协作已被终止',
  };
  const activeStatusText = statusLabels[agentRun.status] || '智能团队';
  const waitingCount = agentRun.crew.filter((c: Record<string, any>) => c.status === 'waiting').length;
  const badgeText =
    agentRun.status === 'waiting' && waitingCount > 0
      ? `等待确认 · ${waitingCount} 个工具`
      : `${runningOrDoneCount}/${totalCount} 参与`;
  const runningCount = agentRun.crew.filter((c: Record<string, any>) => c.status === 'running').length;
  const doneCount = agentRun.crew.filter((c: Record<string, any>) => c.status === 'done').length;
  const skippedCount = agentRun.crew.filter((c: Record<string, any>) => c.status === 'skipped').length;
  const errorCount = agentRun.crew.filter((c: Record<string, any>) => c.status === 'error').length;
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

  agentRun.crew.forEach((member: Record<string, any>) => {
    activeRoleIds.add(member.id);
    let card = cardMap.get(member.id);

    if (!card) {
      card = document.createElement('div');
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
  name.textContent = 'Agent Crew';

  const label = createTextElement('span', 'agent-crew-status-text', statusText || '智能团队');
  title.append(pulse, name, label);
  return title;
}

function createCrewCardMain(member: Record<string, any> = {}, statusIcon = '○') {
  const main = document.createElement('div');
  main.className = 'agent-crew-card-main';

  const icon = createTextElement('span', 'agent-crew-role-icon', member.icon || '');

  const roleInfo = document.createElement('div');
  roleInfo.className = 'agent-crew-role-info';
  roleInfo.append(
    createTextElement('span', 'agent-crew-role-label', member.label || ''),
    createTextElement('span', 'agent-crew-role-title', member.title || '')
  );

  const status = createTextElement('span', 'agent-crew-status-dot', statusIcon);
  status.title = String(member.status || '');

  main.append(icon, roleInfo, status);
  return main;
}

function createCrewCardDetails(member: Record<string, any> = {}, { toolCount = 0, stepCount = 0 } = {}) {
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

function createCrewDetailRow(label: string, value: string) {
  const row = document.createElement('div');
  row.className = 'crew-detail-row';
  row.append(
    createTextElement('span', 'crew-detail-label', label),
    createTextElement('span', 'crew-detail-val', value)
  );
  return row;
}

function createTextElement(tag: string, className: string, text: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(text || '');
  return element;
}
