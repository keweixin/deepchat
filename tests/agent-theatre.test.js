/**
 * Agent Theatre Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderAgentTheatre, setCrewDisplayMode, shouldShowTheatre } from '../src/modules/agent-theatre.js';

describe('agent-theatre', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'agent-crew-container';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  const makeAgentRun = (overrides = {}) => ({
    status: 'running',
    crew: [
      { id: 'planner', status: 'thinking', currentAction: 'Planning...', icon: '🧭', label: '规划师' },
      { id: 'reader', status: 'idle', currentAction: '', icon: '📖', label: '阅读器' },
      { id: 'researcher', status: 'running_tool', currentAction: 'Searching...', icon: '🔍', label: '研究员' },
      { id: 'coder', status: 'idle', currentAction: '', icon: '⚙️', label: '编码器' },
      { id: 'reviewer', status: 'idle', currentAction: '', icon: '✓', label: '审核员' },
      { id: 'writer', status: 'idle', currentAction: '', icon: '✎', label: '撰写员' },
    ],
    ...overrides,
  });

  it('renders theatre wrapper with header and stage', () => {
    renderAgentTheatre(container, makeAgentRun());
    const wrapper = container.querySelector('.agent-theatre-wrapper');
    expect(wrapper).toBeTruthy();
    expect(wrapper.querySelector('.agent-theatre-header')).toBeTruthy();
    expect(wrapper.querySelector('.agent-theatre-stage')).toBeTruthy();
  });

  it('renders 6 actor cards', () => {
    renderAgentTheatre(container, makeAgentRun());
    const actors = container.querySelectorAll('.theatre-actor');
    expect(actors.length).toBe(6);
  });

  it('renders correct role labels', () => {
    renderAgentTheatre(container, makeAgentRun());
    const names = [...container.querySelectorAll('.theatre-actor-name')].map((el) => el.textContent);
    expect(names).toContain('规划师');
    expect(names).toContain('阅读器');
    expect(names).toContain('研究员');
    expect(names).toContain('编码器');
    expect(names).toContain('审核员');
    expect(names).toContain('撰写员');
  });

  it('applies status animation classes', () => {
    renderAgentTheatre(container, makeAgentRun());
    const thinking = container.querySelector('.theatre-actor[data-role-id="planner"]');
    expect(thinking.classList.contains('theatre-actor--thinking')).toBe(true);
    const running = container.querySelector('.theatre-actor[data-role-id="researcher"]');
    expect(running.classList.contains('theatre-actor--running')).toBe(true);
  });

  it('shows status badge from agentRun', () => {
    renderAgentTheatre(container, makeAgentRun({ status: 'done' }));
    const badge = container.querySelector('.agent-theatre-badge');
    expect(badge.textContent).toBe('done');
  });

  it('renders SVG flow layer when showFlow is true', () => {
    renderAgentTheatre(container, makeAgentRun(), { showFlow: true });
    expect(container.querySelector('.agent-theatre-flow')).toBeTruthy();
  });

  it('skips SVG flow layer when showFlow is false', () => {
    renderAgentTheatre(container, makeAgentRun(), { showFlow: false });
    expect(container.querySelector('.agent-theatre-flow')).toBeFalsy();
  });

  it('does not full-rebuild on fingerprint match', () => {
    const run = makeAgentRun();
    renderAgentTheatre(container, run);
    const wrapper = container.querySelector('.agent-theatre-wrapper');
    const firstFingerprint = wrapper.__theatreFingerprint;
    renderAgentTheatre(container, run);
    expect(wrapper.__theatreFingerprint).toBe(firstFingerprint);
    // wrapper should be same DOM node
    expect(container.querySelector('.agent-theatre-wrapper')).toBe(wrapper);
  });

  it('updates status on fingerprint change', () => {
    const run = makeAgentRun();
    renderAgentTheatre(container, run);
    const run2 = makeAgentRun({
      crew: [
        { id: 'planner', status: 'done', currentAction: 'Done', icon: '🧭', label: '规划师' },
        { id: 'reader', status: 'idle', currentAction: '', icon: '📖', label: '阅读器' },
        { id: 'researcher', status: 'idle', currentAction: '', icon: '🔍', label: '研究员' },
        { id: 'coder', status: 'idle', currentAction: '', icon: '⚙️', label: '编码器' },
        { id: 'reviewer', status: 'idle', currentAction: '', icon: '✓', label: '审核员' },
        { id: 'writer', status: 'idle', currentAction: '', icon: '✎', label: '撰写员' },
      ],
    });
    renderAgentTheatre(container, run2);
    const planner = container.querySelector('.theatre-actor[data-role-id="planner"]');
    expect(planner.classList.contains('theatre-actor--done')).toBe(true);
    expect(planner.classList.contains('theatre-actor--thinking')).toBe(false);
  });

  it('dispatches deepchat:crew-role-click on actor click', () => {
    renderAgentTheatre(container, makeAgentRun());
    const handler = vi.fn();
    container.querySelector('.agent-theatre-stage').addEventListener('deepchat:crew-role-click', handler);
    const actor = container.querySelector('.theatre-actor[data-role-id="planner"]');
    actor.click();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.roleId).toBe('planner');
  });

  it('gracefully handles null container', () => {
    expect(() => renderAgentTheatre(null, makeAgentRun())).not.toThrow();
  });

  it('gracefully handles null agentRun', () => {
    renderAgentTheatre(container, null);
    const actors = container.querySelectorAll('.theatre-actor');
    expect(actors.length).toBe(6);
    expect(actors[0].classList.contains('theatre-actor--thinking')).toBe(false);
  });
});

describe('setCrewDisplayMode', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
  });

  it('sets data-display-mode attribute', () => {
    setCrewDisplayMode(container, 'theatre', { status: 'running', crew: [] });
    expect(container.dataset.displayMode).toBe('theatre');
  });

  it('removes previous wrapper before rendering', () => {
    container.innerHTML = '<div class="agent-crew-wrapper"></div>';
    setCrewDisplayMode(container, 'theatre', { status: 'running', crew: [] });
    expect(container.querySelector('.agent-crew-wrapper')).toBeFalsy();
    expect(container.querySelector('.agent-theatre-wrapper')).toBeTruthy();
  });
});

describe('shouldShowTheatre', () => {
  it('returns true for theatre mode', () => {
    expect(shouldShowTheatre({ crewDisplayMode: 'theatre' }, { crew: [] })).toBe(true);
  });

  it('returns false for off mode', () => {
    expect(shouldShowTheatre({ crewDisplayMode: 'off' }, { crew: [{ id: 'coder', status: 'running' }] })).toBe(false);
  });

  it('returns true for always mode', () => {
    expect(shouldShowTheatre({ crewDisplayMode: 'always' }, { crew: [] })).toBe(true);
  });

  it('returns true for tools_only when crew is active', () => {
    expect(shouldShowTheatre({ crewDisplayMode: 'tools_only' }, { crew: [{ id: 'coder', status: 'running' }] })).toBe(
      true
    );
  });

  it('returns false for tools_only when crew is idle', () => {
    expect(shouldShowTheatre({ crewDisplayMode: 'tools_only' }, { crew: [{ id: 'coder', status: 'idle' }] })).toBe(
      false
    );
  });

  it('returns true for auto mode with active crew', () => {
    expect(shouldShowTheatre({ crewDisplayMode: 'auto' }, { crew: [{ id: 'coder', status: 'running' }] })).toBe(true);
  });

  it('returns false for auto mode with all idle crew', () => {
    expect(shouldShowTheatre({ crewDisplayMode: 'auto' }, { crew: [{ id: 'coder', status: 'idle' }] })).toBe(false);
  });

  it('defaults to auto when no setting', () => {
    expect(shouldShowTheatre({}, { crew: [{ id: 'coder', status: 'running' }] })).toBe(true);
  });
});
