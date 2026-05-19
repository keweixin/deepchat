const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const PAN_PADDING = 32;

let viewerInstance = null;

export function calculateFitScale(mediaRect, stageRect) {
  const mediaWidth = positiveNumber(mediaRect?.width, 1);
  const mediaHeight = positiveNumber(mediaRect?.height, 1);
  const stageWidth = positiveNumber(stageRect?.width, mediaWidth);
  const stageHeight = positiveNumber(stageRect?.height, mediaHeight);
  const fit = Math.min(stageWidth / mediaWidth, stageHeight / mediaHeight, 1);
  return roundScale(Math.max(MIN_SCALE, fit));
}

export function zoomAtPoint(state, point, nextScale) {
  const scale = roundScale(clampNumber(nextScale, MIN_SCALE, MAX_SCALE));
  const currentScale = positiveNumber(state?.scale, 1);
  const anchorX = Number(point?.x) || 0;
  const anchorY = Number(point?.y) || 0;
  const currentX = Number(state?.x) || 0;
  const currentY = Number(state?.y) || 0;
  const contentX = (anchorX - currentX) / currentScale;
  const contentY = (anchorY - currentY) / currentScale;

  return {
    scale,
    x: roundPixel(anchorX - contentX * scale),
    y: roundPixel(anchorY - contentY * scale),
  };
}

export function clampViewerState(state, bounds) {
  const scale = roundScale(clampNumber(state?.scale, MIN_SCALE, MAX_SCALE));
  const mediaWidth = positiveNumber(bounds?.mediaWidth, 1);
  const mediaHeight = positiveNumber(bounds?.mediaHeight, 1);
  const stageWidth = positiveNumber(bounds?.stageWidth, mediaWidth);
  const stageHeight = positiveNumber(bounds?.stageHeight, mediaHeight);
  const scaledWidth = mediaWidth * scale;
  const scaledHeight = mediaHeight * scale;
  const maxX = Math.max(0, (scaledWidth - stageWidth) / 2 + PAN_PADDING);
  const maxY = Math.max(0, (scaledHeight - stageHeight) / 2 + PAN_PADDING);

  return {
    scale,
    x: maxX === 0 ? 0 : roundPixel(clampNumber(state?.x, -maxX, maxX)),
    y: maxY === 0 ? 0 : roundPixel(clampNumber(state?.y, -maxY, maxY)),
  };
}

export function bindZoomableMedia(container) {
  if (!container) return;

  container.querySelectorAll('img:not([data-media-bound])').forEach((img) => {
    img.dataset.mediaBound = '1';
    img.classList.add('is-zoomable-media');
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', img.alt ? `放大查看图片：${img.alt}` : '放大查看图片');
    img.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openImageViewer(img);
    });
    img.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openImageViewer(img);
    });
  });

  container.querySelectorAll('.mermaid-wrapper:not([data-media-bound])').forEach((wrapper) => {
    const svg = wrapper.querySelector('svg');
    if (svg) bindSvgWrapper(wrapper, svg, '流程图');
  });

  container.querySelectorAll('.dc-widget-chart:not([data-media-bound])').forEach((wrapper) => {
    const svg = wrapper.querySelector('svg');
    if (svg) bindSvgWrapper(wrapper, svg, svg.getAttribute('aria-label') || '图表');
  });
}

function bindSvgWrapper(wrapper, svg, title) {
  wrapper.dataset.mediaBound = '1';
  wrapper.classList.add('is-zoomable-media', 'is-vector-media');
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'button');
  wrapper.setAttribute('aria-label', `放大查看${title}`);
  wrapper.addEventListener('click', (event) => {
    if (event.target.closest('button, input, select, textarea, a')) return;
    openSvgViewer(svg, title);
  });
  wrapper.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openSvgViewer(svg, title);
  });
}

function ensureViewer() {
  if (viewerInstance?.root?.isConnected) return viewerInstance;
  viewerInstance = null;

  const root = document.createElement('div');
  root.className = 'media-viewer';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '媒体预览');

  const toolbar = document.createElement('div');
  toolbar.className = 'media-viewer-toolbar';

  const title = document.createElement('div');
  title.className = 'media-viewer-title';

  const actions = document.createElement('div');
  actions.className = 'media-viewer-actions';

  const zoomOut = createViewerButton('zoom-out', '缩小', '-');
  const scaleText = document.createElement('span');
  scaleText.className = 'media-viewer-scale';
  const zoomIn = createViewerButton('zoom-in', '放大', '+');
  const fit = createViewerButton('fit', '适应窗口', '适应');
  const actual = createViewerButton('actual', '100% 查看', '100%');
  const contrast = createViewerButton('contrast', '高对比流程图', '高对比');
  const openOriginal = createViewerButton('open', '打开原图', '原图');
  const close = createViewerButton('close', '关闭', '关闭');

  actions.append(zoomOut, scaleText, zoomIn, fit, actual, contrast, openOriginal, close);
  toolbar.append(title, actions);

  const stage = document.createElement('div');
  stage.className = 'media-viewer-stage';
  const canvas = document.createElement('div');
  canvas.className = 'media-viewer-canvas';
  const minimap = document.createElement('div');
  minimap.className = 'media-viewer-minimap';
  const minimapViewport = document.createElement('span');
  minimapViewport.className = 'media-viewer-minimap-viewport';
  minimap.appendChild(minimapViewport);
  const hint = document.createElement('div');
  hint.className = 'media-viewer-hint';
  hint.textContent = '滚轮缩放 · 拖拽移动 · 双击复位/放大';
  stage.appendChild(canvas);
  stage.append(minimap, hint);
  root.append(toolbar, stage);
  document.body.appendChild(root);

  const state = {
    scale: 1,
    fitScale: 1,
    x: 0,
    y: 0,
    mediaWidth: 1,
    mediaHeight: 1,
    highContrast: false,
    dragging: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    src: '',
  };

  function getStageRect() {
    const rect = stage.getBoundingClientRect();
    const width = rect.width || Math.max(320, window.innerWidth - 48);
    const height = rect.height || Math.max(240, window.innerHeight - 120);
    return { width, height, left: rect.left || 24, top: rect.top || 80 };
  }

  function getBounds() {
    const stageRect = getStageRect();
    return {
      mediaWidth: state.mediaWidth,
      mediaHeight: state.mediaHeight,
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
    };
  }

  function applyTransform() {
    const clamped = clampViewerState(state, getBounds());
    state.scale = clamped.scale;
    state.x = clamped.x;
    state.y = clamped.y;
    canvas.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    scaleText.textContent = `${Math.round(state.scale * 100)}%`;
    root.classList.toggle('is-pannable', canPan(state, getStageRect()));
    root.classList.toggle('is-high-contrast', state.highContrast);
    updateMinimap();
  }

  function setMediaSize(width, height) {
    state.mediaWidth = Math.max(1, Math.round(width));
    state.mediaHeight = Math.max(1, Math.round(height));
    canvas.style.width = `${state.mediaWidth}px`;
    canvas.style.height = `${state.mediaHeight}px`;
    const child = canvas.firstElementChild;
    if (child) {
      child.style.width = `${state.mediaWidth}px`;
      child.style.height = `${state.mediaHeight}px`;
    }
  }

  function setScale(nextScale, point = { x: 0, y: 0 }) {
    const clampedScale = clampNumber(nextScale, Math.min(state.fitScale, 1), MAX_SCALE);
    const next = zoomAtPoint(state, point, clampedScale);
    state.scale = next.scale;
    state.x = next.x;
    state.y = next.y;
    applyTransform();
  }

  function fitToStage() {
    state.fitScale = calculateFitScale(
      { width: state.mediaWidth, height: state.mediaHeight },
      getStageRect(),
    );
    state.scale = state.fitScale;
    state.x = 0;
    state.y = 0;
    applyTransform();
  }

  function actualSize() {
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    applyTransform();
  }

  function open(payload) {
    title.textContent = payload.title || '媒体预览';
    state.src = payload.src || '';
    state.x = 0;
    state.y = 0;
    canvas.replaceChildren(payload.node);
    setMediaSize(payload.width, payload.height);
    openOriginal.hidden = !state.src;
    openOriginal.dataset.href = state.src;
    root.hidden = false;
    root.classList.add('is-open');
    document.body.classList.add('media-viewer-open');
    fitToStage();
    close.focus();
  }

  function closeViewer() {
    root.hidden = true;
    root.classList.remove('is-open', 'is-pannable');
    document.body.classList.remove('media-viewer-open');
    canvas.replaceChildren();
    openOriginal.dataset.href = '';
  }

  zoomOut.addEventListener('click', () => setScale(state.scale / 1.25));
  zoomIn.addEventListener('click', () => setScale(state.scale * 1.25));
  fit.addEventListener('click', fitToStage);
  actual.addEventListener('click', actualSize);
  contrast.addEventListener('click', () => {
    state.highContrast = !state.highContrast;
    contrast.classList.toggle('is-active', state.highContrast);
    applyTransform();
  });
  close.addEventListener('click', closeViewer);
  openOriginal.addEventListener('click', () => {
    const href = openOriginal.dataset.href;
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  });

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = getPointerFromEvent(event, stage);
    setScale(state.scale * (event.deltaY < 0 ? 1.15 : 0.87), point);
  }, { passive: false });

  stage.addEventListener('pointerdown', (event) => {
    if (!canPan(state, getStageRect())) return;
    state.dragging = true;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.originX = state.x;
    state.originY = state.y;
    stage.setPointerCapture?.(event.pointerId);
  });

  stage.addEventListener('pointermove', (event) => {
    if (!state.dragging) return;
    state.x = state.originX + event.clientX - state.startX;
    state.y = state.originY + event.clientY - state.startY;
    applyTransform();
  });

  stage.addEventListener('pointerup', (event) => {
    state.dragging = false;
    if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture?.(event.pointerId);
  });

  stage.addEventListener('dblclick', (event) => {
    const point = getPointerFromEvent(event, stage);
    if (state.scale > state.fitScale * 1.08) {
      fitToStage();
    } else {
      setScale(Math.max(1, state.fitScale * 2), point);
    }
  });

  root.addEventListener('click', (event) => {
    if (event.target === stage) closeViewer();
  });

  document.addEventListener('keydown', (event) => {
    if (root.hidden) return;
    if (event.key === 'Escape') closeViewer();
    if (event.key === '+' || event.key === '=') setScale(state.scale * 1.25);
    if (event.key === '-' || event.key === '_') setScale(state.scale / 1.25);
    if (event.key === '0') actualSize();
  });

  window.addEventListener('resize', () => {
    if (!root.hidden) fitToStage();
  });

  function updateMinimap() {
    const stageRect = getStageRect();
    const scaledWidth = state.mediaWidth * state.scale;
    const scaledHeight = state.mediaHeight * state.scale;
    minimap.hidden = scaledWidth <= stageRect.width && scaledHeight <= stageRect.height;
    if (minimap.hidden) return;
    const viewportWidth = clampNumber(stageRect.width / Math.max(scaledWidth, 1), 0.08, 1) * 100;
    const viewportHeight = clampNumber(stageRect.height / Math.max(scaledHeight, 1), 0.08, 1) * 100;
    const maxLeft = 100 - viewportWidth;
    const maxTop = 100 - viewportHeight;
    const left = clampNumber(50 - (state.x / Math.max(scaledWidth, 1)) * 100 - viewportWidth / 2, 0, maxLeft);
    const top = clampNumber(50 - (state.y / Math.max(scaledHeight, 1)) * 100 - viewportHeight / 2, 0, maxTop);
    minimapViewport.style.width = `${viewportWidth}%`;
    minimapViewport.style.height = `${viewportHeight}%`;
    minimapViewport.style.left = `${left}%`;
    minimapViewport.style.top = `${top}%`;
  }

  viewerInstance = { root, stage, canvas, title, state, open, close: closeViewer };
  return viewerInstance;
}

function createViewerButton(action, label, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'media-viewer-btn';
  button.dataset.mediaAction = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.textContent = text;
  return button;
}

function openImageViewer(sourceImage) {
  const viewer = ensureViewer();
  const src = sourceImage.currentSrc || sourceImage.src;
  const img = document.createElement('img');
  img.src = src;
  img.alt = sourceImage.alt || '';
  img.decoding = 'async';
  const size = getImageSize(sourceImage);

  viewer.open({
    node: img,
    title: sourceImage.alt || sourceImage.title || '图片预览',
    src,
    width: size.width,
    height: size.height,
  });

  img.addEventListener('load', () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    if (img.naturalWidth === size.width && img.naturalHeight === size.height) return;
    const active = ensureViewer();
    if (active.state.src !== src) return;
    active.open({
      node: img,
      title: sourceImage.alt || sourceImage.title || '图片预览',
      src,
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  }, { once: true });
}

function openSvgViewer(sourceSvg, title) {
  const viewer = ensureViewer();
  const clone = sourceSvg.cloneNode(true);
  // Mermaid scopes most generated styles to the root SVG id. Removing it makes
  // nodes and edges fall back to browser defaults, which turns diagrams into
  // unreadable black blocks in the viewer.
  clone.classList.add('media-viewer-vector');
  const size = getSvgSize(sourceSvg);
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  viewer.open({
    node: clone,
    title: title || '图表预览',
    src: '',
    width: size.width,
    height: size.height,
  });
}

function getImageSize(img) {
  const rect = img.getBoundingClientRect?.() || {};
  return {
    width: positiveNumber(img.naturalWidth, positiveNumber(rect.width, 960)),
    height: positiveNumber(img.naturalHeight, positiveNumber(rect.height, 540)),
  };
}

function getSvgSize(svg) {
  const viewBox = parseViewBox(svg.getAttribute('viewBox'));
  if (viewBox) return viewBox;
  const rect = svg.getBoundingClientRect?.() || {};
  return {
    width: positiveNumber(svg.getAttribute('width'), positiveNumber(rect.width, 960)),
    height: positiveNumber(svg.getAttribute('height'), positiveNumber(rect.height, 540)),
  };
}

function parseViewBox(value) {
  const parts = String(value || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return {
    width: positiveNumber(parts[2], 960),
    height: positiveNumber(parts[3], 540),
  };
}

function getPointerFromEvent(event, stage) {
  const rect = stage.getBoundingClientRect();
  const width = rect.width || Math.max(320, window.innerWidth - 48);
  const height = rect.height || Math.max(240, window.innerHeight - 120);
  const left = rect.left || 24;
  const top = rect.top || 80;
  return {
    x: event.clientX - left - width / 2,
    y: event.clientY - top - height / 2,
  };
}

function canPan(state, stageRect) {
  return state.mediaWidth * state.scale > stageRect.width || state.mediaHeight * state.scale > stageRect.height;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function roundScale(value) {
  return Math.round(value * 10000) / 10000;
}

function roundPixel(value) {
  return Math.round(value * 100) / 100;
}
