// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openTraceInspector,
  closeTraceInspector,
  isTraceInspectorOpen,
  toggleTraceInspector,
} from '../src/modules/agent-trace-inspector.js';
import { TraceRecorder, RUN_STATUS } from '../src/modules/agent-trace.js';

describe('agent-trace-inspector', () => {
  beforeEach(() => {
    closeTraceInspector();
  });

  afterEach(() => {
    closeTraceInspector();
    // Clean up any leftover DOM
    document.querySelectorAll('.trace-inspector-overlay').forEach((el) => el.remove());
  });

  it('is closed by default', () => {
    expect(isTraceInspectorOpen()).toBe(false);
  });

  it('opens with a recorder', () => {
    const recorder = new TraceRecorder({ runId: 'run_1', mode: 'agent_auto' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    expect(isTraceInspectorOpen()).toBe(true);

    const overlay = document.querySelector('.trace-inspector-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.classList.contains('is-visible')).toBe(true);

    const panel = document.querySelector('.trace-inspector-panel');
    expect(panel).not.toBeNull();
    expect(panel.classList.contains('is-visible')).toBe(true);
  });

  it('closes on closeTraceInspector', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    expect(isTraceInspectorOpen()).toBe(true);

    closeTraceInspector();
    expect(isTraceInspectorOpen()).toBe(false);

    const overlay = document.querySelector('.trace-inspector-overlay');
    expect(overlay.classList.contains('is-visible')).toBe(false);
  });

  it('closes on overlay click', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const overlay = document.querySelector('.trace-inspector-overlay');
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(isTraceInspectorOpen()).toBe(false);
  });

  it('closes on Escape key', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    expect(isTraceInspectorOpen()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isTraceInspectorOpen()).toBe(false);
  });

  it('does not open for null recorder', () => {
    openTraceInspector(null);
    expect(isTraceInspectorOpen()).toBe(false);
  });

  it('toggles inspector', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    toggleTraceInspector(recorder);
    expect(isTraceInspectorOpen()).toBe(true);

    toggleTraceInspector(recorder);
    expect(isTraceInspectorOpen()).toBe(false);
  });

  it('renders run summary bar', () => {
    const recorder = new TraceRecorder({ runId: 'run_1', mode: 'agent_auto' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const bar = document.querySelector('.trace-run-summary');
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain('Status');
    expect(bar.textContent).toContain('Duration');
    expect(bar.textContent).toContain('Actors');
  });

  it('renders actor grid with 6 cards', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const grid = document.querySelector('.trace-actor-grid');
    expect(grid).not.toBeNull();
    const cards = grid.querySelectorAll('.trace-actor-card');
    expect(cards).toHaveLength(6);
  });

  it('renders tool call cards', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({
      toolCallId: 'tc_1',
      toolName: 'web_search',
      ok: true,
      outputSummary: 'Found 5 sources',
    });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const cards = document.querySelectorAll('.trace-tool-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('web_search');
    expect(cards[0].textContent).toContain('Found 5 sources');
  });

  it('renders event timeline', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordStage({ stage: 'plan' });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const timeline = document.querySelector('.trace-timeline');
    expect(timeline).not.toBeNull();
    const items = timeline.querySelectorAll('.trace-timeline-item');
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  it('renders export buttons', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const panel = document.querySelector('.trace-inspector-panel');
    expect(panel.textContent).toContain('Export JSONL');
    expect(panel.textContent).toContain('Export JSON');
    expect(panel.textContent).toContain('Copy Summary');
  });

  it('sections are collapsible', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const sections = document.querySelectorAll('.trace-section');
    expect(sections.length).toBeGreaterThan(0);

    const firstSection = sections[0];
    const header = firstSection.querySelector('.trace-section-header');
    const content = firstSection.querySelector('.trace-section-content');

    expect(content).not.toBeNull();
    expect(firstSection.classList.contains('is-collapsed')).toBe(false);

    header.click();
    expect(firstSection.classList.contains('is-collapsed')).toBe(true);

    header.click();
    expect(firstSection.classList.contains('is-collapsed')).toBe(false);
  });

  it('includes conversation title in header', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder, { conversationTitle: 'Test Chat' });
    const title = document.querySelector('.trace-inspector-title');
    expect(title.textContent).toContain('Test Chat');
  });

  it('renders Rerun from here button on tool call cards', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true, outputSummary: 'Found results' });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const cards = document.querySelectorAll('.trace-tool-card');
    expect(cards).toHaveLength(1);
    const rerunBtn = cards[0].querySelector('.trace-action-btn--rerun');
    expect(rerunBtn).not.toBeNull();
    expect(rerunBtn.textContent).toBe('Rerun from here');
  });

  it('dispatches deepchat:rerun-from-tool on Rerun click', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const handler = vi.fn();
    document.addEventListener('deepchat:rerun-from-tool', handler);

    const rerunBtn = document.querySelector('.trace-action-btn--rerun');
    rerunBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.toolName).toBe('web_search');
    expect(handler.mock.calls[0][0].detail.toolCallId).toBe('tc_1');
    expect(rerunBtn.textContent).toBe('Rerun requested');

    document.removeEventListener('deepchat:rerun-from-tool', handler);
  });

  it('renders Override plan button when run is active', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    // Run is still active (no recordRunEnd)

    openTraceInspector(recorder);
    const overrideBtn = document.querySelector('.trace-action-btn--override');
    expect(overrideBtn).not.toBeNull();
    expect(overrideBtn.textContent).toBe('Override plan');
  });

  it('does not render Override plan button when run is done', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder);
    const overrideBtn = document.querySelector('.trace-action-btn--override');
    expect(overrideBtn).toBeNull();
  });

  it('dispatches deepchat:override-plan on Override click', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();

    openTraceInspector(recorder);
    const handler = vi.fn();
    document.addEventListener('deepchat:override-plan', handler);

    const overrideBtn = document.querySelector('.trace-action-btn--override');
    overrideBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.runId).toBe('run_1');
    expect(overrideBtn.textContent).toBe('Override sent');

    document.removeEventListener('deepchat:override-plan', handler);
  });

  it('scrolls to focused role tools when focusedRoleId is set', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true });
    recorder.recordToolRequest({ toolCallId: 'tc_2', toolName: 'read_file', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_2', toolName: 'read_file', ok: true });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    openTraceInspector(recorder, { focusedRoleId: 'researcher' });

    // Wait for requestAnimationFrame
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        const focusedCards = document.querySelectorAll('.trace-tool-card--focused');
        expect(focusedCards.length).toBeGreaterThanOrEqual(1);
        // The focused card should be the web_search one (researcher role)
        expect(focusedCards[0].textContent).toContain('web_search');
        resolve(undefined);
      });
    });
  });
});
