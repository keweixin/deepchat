export function confirmAction(options = {}) {
  return openDialog({
    title: options.title || '确认操作',
    message: options.message || '',
    tone: options.tone || 'default',
    confirmText: options.confirmText || '确认',
    cancelText: options.cancelText || '取消',
  });
}

export function promptText(options = {}) {
  return openDialog({
    title: options.title || '输入内容',
    message: options.message || '',
    value: options.value || '',
    placeholder: options.placeholder || '',
    tone: options.tone || 'default',
    confirmText: options.confirmText || '保存',
    cancelText: options.cancelText || '取消',
    input: true,
    multiline: Boolean(options.multiline),
  });
}

function openDialog(options) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = `dc-dialog-overlay tone-${options.tone || 'default'}`;
    overlay.setAttribute('role', 'presentation');

    const panel = document.createElement('div');
    panel.className = 'dc-dialog-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'dc-dialog-title');

    const title = document.createElement('h2');
    title.id = 'dc-dialog-title';
    title.className = 'dc-dialog-title';
    title.textContent = options.title;
    panel.appendChild(title);

    if (options.message) {
      const message = document.createElement('p');
      message.className = 'dc-dialog-message';
      message.textContent = options.message;
      panel.appendChild(message);
    }

    let input = null;
    if (options.input) {
      input = options.multiline ? document.createElement('textarea') : document.createElement('input');
      input.className = 'dc-dialog-input';
      input.value = options.value || '';
      input.placeholder = options.placeholder || '';
      if (options.multiline) input.rows = 5;
      panel.appendChild(input);
    }

    const actions = document.createElement('div');
    actions.className = 'dc-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dc-dialog-btn secondary';
    cancel.textContent = options.cancelText || '取消';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'dc-dialog-btn primary';
    confirm.textContent = options.confirmText || '确认';
    actions.append(cancel, confirm);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const previousActive = document.activeElement;
    const cleanup = (value) => {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      if (previousActive?.focus) previousActive.focus();
      resolve(value);
    };
    const accept = () => cleanup(options.input ? input.value : true);
    const decline = () => cleanup(options.input ? null : false);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        decline();
      }
      if (!options.multiline && event.key === 'Enter') {
        event.preventDefault();
        accept();
      }
      if (event.key === 'Tab') trapFocus(event, panel);
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) decline();
    });
    cancel.addEventListener('click', decline);
    confirm.addEventListener('click', accept);
    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => (input || confirm).focus());
  });
}

function trapFocus(event, root) {
  const focusables = [
    ...root.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])'),
  ].filter((node) => !node.disabled && node.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
