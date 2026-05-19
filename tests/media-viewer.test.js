import { afterEach, describe, expect, it } from 'vitest';
import {
  bindZoomableMedia,
  calculateFitScale,
  clampViewerState,
  zoomAtPoint,
} from '../src/modules/media-viewer.js';

function defineImageSize(img, width = 1200, height = 800) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
}

function firePointer(target, type, clientX, clientY) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, 'pointerId', { configurable: true, value: 1 });
  target.dispatchEvent(event);
}

describe('media viewer', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('calculates fit scale without upscaling small media by default', () => {
    expect(calculateFitScale({ width: 1600, height: 900 }, { width: 800, height: 600 })).toBe(0.5);
    expect(calculateFitScale({ width: 320, height: 180 }, { width: 800, height: 600 })).toBe(1);
  });

  it('zooms around the pointer instead of the viewport center', () => {
    const next = zoomAtPoint({ scale: 1, x: 0, y: 0 }, { x: 100, y: 50 }, 2);
    expect(next).toEqual({ scale: 2, x: -100, y: -50 });
  });

  it('clamps pan only when scaled media exceeds the stage', () => {
    const centered = clampViewerState(
      { scale: 0.5, x: 200, y: 100 },
      { mediaWidth: 400, mediaHeight: 300, stageWidth: 800, stageHeight: 600 },
    );
    expect(centered.x).toBe(0);
    expect(centered.y).toBe(0);

    const clamped = clampViewerState(
      { scale: 2, x: 2000, y: -2000 },
      { mediaWidth: 1000, mediaHeight: 800, stageWidth: 800, stageHeight: 600 },
    );
    expect(clamped.x).toBeLessThan(2000);
    expect(clamped.y).toBeGreaterThan(-2000);
  });

  it('opens images and real zoom controls update scale and transform', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="https://example.com/map.png" alt="总览图">';
    document.body.appendChild(root);
    const img = root.querySelector('img');
    defineImageSize(img, 1200, 800);

    bindZoomableMedia(root);
    img.click();

    const viewer = document.querySelector('.media-viewer');
    const canvas = viewer.querySelector('.media-viewer-canvas');
    expect(viewer.hidden).toBe(false);
    expect(viewer.querySelector('.media-viewer-scale').textContent).toContain('%');

    viewer.querySelector('[data-media-action="zoom-in"]').click();
    expect(viewer.querySelector('.media-viewer-scale').textContent).not.toBe('100%');
    expect(canvas.style.transform).toContain('scale(');

    viewer.querySelector('[data-media-action="actual"]').click();
    expect(viewer.querySelector('.media-viewer-scale').textContent).toBe('100%');

    viewer.querySelector('[data-media-action="fit"]').click();
    expect(canvas.style.transform).toContain('translate(0px, 0px)');
  });

  it('supports wheel zoom and pointer dragging after zoom', () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="https://example.com/wide.png" alt="宽图">';
    document.body.appendChild(root);
    const img = root.querySelector('img');
    defineImageSize(img, 1600, 900);

    bindZoomableMedia(root);
    img.click();

    const viewer = document.querySelector('.media-viewer');
    const stage = viewer.querySelector('.media-viewer-stage');
    const canvas = viewer.querySelector('.media-viewer-canvas');

    const beforeWheel = canvas.style.transform;
    stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120, clientX: 300, clientY: 220 }));
    expect(canvas.style.transform).not.toBe(beforeWheel);

    const beforeDrag = canvas.style.transform;
    firePointer(stage, 'pointerdown', 300, 220);
    firePointer(stage, 'pointermove', 360, 260);
    firePointer(stage, 'pointerup', 360, 260);
    expect(canvas.style.transform).not.toBe(beforeDrag);
  });

  it('opens SVG charts without losing viewBox', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="mermaid-wrapper"><svg viewBox="0 0 640 300"><rect width="640" height="300"></rect></svg></div>';
    document.body.appendChild(root);

    bindZoomableMedia(root);
    root.querySelector('.mermaid-wrapper').click();

    const viewerSvg = document.querySelector('.media-viewer svg');
    expect(viewerSvg).toBeTruthy();
    expect(viewerSvg.getAttribute('viewBox')).toBe('0 0 640 300');
  });

  it('preserves Mermaid id-scoped styles when cloning SVGs into the viewer', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="mermaid-wrapper">
        <svg id="mermaid-test-1" viewBox="0 0 640 300">
          <style>#mermaid-test-1 .node rect { fill: #10161a; stroke: #2dd4bf; }</style>
          <g class="node"><rect width="120" height="48"></rect></g>
        </svg>
      </div>
    `;
    document.body.appendChild(root);

    bindZoomableMedia(root);
    root.querySelector('.mermaid-wrapper').click();

    const viewerSvg = document.querySelector('.media-viewer svg');
    expect(viewerSvg).toBeTruthy();
    expect(viewerSvg.id).toBe('mermaid-test-1');
    expect(viewerSvg.querySelector('style').textContent).toContain('#mermaid-test-1 .node rect');
  });
});
