/**
 * Inspector Panel Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openInspectorPanel,
  closeInspectorPanel,
  toggleInspectorPanel,
  isInspectorPanelOpen,
  updateInspectorPanel,
  bindInspectorPanelShortcut,
} from '../src/modules/inspector-panel.js';

describe('inspector-panel', () => {
  let panel;

  beforeEach(() => {
    panel = document.createElement('aside');
    panel.id = 'right-inspector-panel';
    panel.innerHTML = `
      <div class="inspector-panel-header"><h2>Inspector</h2></div>
      <div class="inspector-panel-content"></div>
    `;
    document.body.appendChild(panel);
  });

  afterEach(() => {
    panel.remove();
  });

  it('opens panel and adds visible class', () => {
    openInspectorPanel('empty');
    expect(panel.classList.contains('is-visible')).toBe(true);
    expect(isInspectorPanelOpen()).toBe(true);
  });

  it('closes panel and removes visible class', () => {
    openInspectorPanel('empty');
    closeInspectorPanel();
    expect(panel.classList.contains('is-visible')).toBe(false);
    expect(isInspectorPanelOpen()).toBe(false);
  });

  it('toggles panel open/close', () => {
    toggleInspectorPanel('empty');
    expect(isInspectorPanelOpen()).toBe(true);
    toggleInspectorPanel('empty');
    expect(isInspectorPanelOpen()).toBe(false);
  });

  it('switches mode when opening different mode', () => {
    openInspectorPanel('message', { msg: { role: 'assistant' }, index: 0 });
    expect(isInspectorPanelOpen()).toBe(true);
    openInspectorPanel('model', { settings: { model: 'deepseek-chat' } });
    expect(isInspectorPanelOpen()).toBe(true);
  });

  it('update does nothing when closed', () => {
    updateInspectorPanel('message', { msg: { role: 'user' }, index: 0 });
    expect(panel.classList.contains('is-visible')).toBe(false);
  });

  it('binds keyboard shortcut', () => {
    const unbind = bindInspectorPanelShortcut();
    expect(typeof unbind).toBe('function');

    const event = new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'i' });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    document.dispatchEvent(event);
    expect(preventDefault).toHaveBeenCalled();

    unbind();
  });

  it('gracefully handles missing panel DOM', () => {
    panel.remove();
    expect(() => openInspectorPanel('empty')).not.toThrow();
    expect(() => closeInspectorPanel()).not.toThrow();
    expect(() => toggleInspectorPanel('empty')).not.toThrow();
  });
});
