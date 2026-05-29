// @ts-nocheck
import { afterEach, describe, expect, it } from 'vitest';
import { confirmAction, promptText } from '../src/modules/dialogs.js';

describe('in-app dialogs', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves confirm dialogs from the primary action', async () => {
    const promise = confirmAction({ title: '删除', message: '确认删除？', confirmText: '删除', tone: 'danger' });

    expect(document.querySelector('.dc-dialog-panel')).toBeTruthy();
    expect(document.querySelector('.dc-dialog-title').textContent).toBe('删除');
    document.querySelector('.dc-dialog-btn.primary').click();

    await expect(promise).resolves.toBe(true);
    expect(document.querySelector('.dc-dialog-panel')).toBeNull();
  });

  it('returns text from prompt dialogs and null on cancel', async () => {
    const promise = promptText({ title: '标签', value: '项目' });
    const input = document.querySelector('.dc-dialog-input');
    input.value = '项目, 排障';
    document.querySelector('.dc-dialog-btn.primary').click();

    await expect(promise).resolves.toBe('项目, 排障');

    const cancelPromise = promptText({ title: '文件夹', value: '工作' });
    document.querySelector('.dc-dialog-btn.secondary').click();

    await expect(cancelPromise).resolves.toBeNull();
  });
});
