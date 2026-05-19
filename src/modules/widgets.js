/**
 * Safe built-in interactive widgets for assistant responses.
 *
 * The assistant can request a widget with a fenced JSON block:
 * ```widget
 * { "type": "mortgage-calculator" }
 * ```
 *
 * This module never evaluates model-generated JavaScript or HTML. It accepts
 * only JSON and renders a small allow-list of local components.
 */

const WIDGET_TYPES = new Set([
  'mortgage-calculator',
  'bar-chart',
  'line-chart',
  'projectile-demo',
]);

export function renderWidgets(container) {
  container.querySelectorAll('.widget-placeholder:not([data-rendered])').forEach((placeholder) => {
    placeholder.dataset.rendered = '1';
    const config = parseWidgetConfig(placeholder.dataset.widget || '');

    if (!config.ok) {
      placeholder.replaceWith(createWidgetError(config.error));
      return;
    }

    const widget = createWidget(config.value);
    placeholder.replaceWith(widget);
  });
}

function parseWidgetConfig(encoded) {
  try {
    const raw = decodeURIComponent(encoded);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '组件配置必须是 JSON 对象。' };
    }

    const type = normalizeType(parsed.type);
    if (!WIDGET_TYPES.has(type)) {
      return { ok: false, error: `暂不支持的组件类型：${parsed.type || '未指定'}` };
    }

    return { ok: true, value: { ...parsed, type } };
  } catch {
    return { ok: false, error: '组件 JSON 解析失败，请检查格式。' };
  }
}

function normalizeType(type) {
  const value = String(type || '').trim().toLowerCase();
  const aliases = {
    mortgage: 'mortgage-calculator',
    loan: 'mortgage-calculator',
    calculator: 'mortgage-calculator',
    chart: 'bar-chart',
    bar: 'bar-chart',
    line: 'line-chart',
    projectile: 'projectile-demo',
    physics: 'projectile-demo',
  };
  return aliases[value] || value;
}

function createWidget(config) {
  if (config.type === 'mortgage-calculator') return createMortgageCalculator(config);
  if (config.type === 'bar-chart') return createChartWidget(config, 'bar');
  if (config.type === 'line-chart') return createChartWidget(config, 'line');
  if (config.type === 'projectile-demo') return createProjectileDemo(config);
  return createWidgetError('未知组件类型。');
}

function createShell(title, subtitle) {
  const shell = el('section', 'dc-widget');
  const header = el('div', 'dc-widget-header');
  const copy = el('div', 'dc-widget-copy');
  copy.append(el('h3', '', title), el('p', '', subtitle));
  header.append(copy);
  shell.append(header);
  return shell;
}

function createMortgageCalculator(config) {
  const principal = clampNumber(config.principal, 10000, 100000000, 1000000);
  const rate = clampNumber(config.rate, 0, 30, 4.2);
  const years = clampNumber(config.years, 1, 40, 30);

  const shell = createShell('房贷计算器', '输入本金、年利率和贷款年限，实时查看月供与总利息。');
  const grid = el('div', 'dc-widget-grid dc-widget-grid-3');
  const principalInput = createNumberField('贷款本金', principal, 10000, 100000000, 10000, '元');
  const rateInput = createNumberField('年利率', rate, 0, 30, 0.05, '%');
  const yearsInput = createNumberField('贷款年限', years, 1, 40, 1, '年');
  grid.append(principalInput.wrap, rateInput.wrap, yearsInput.wrap);

  const results = el('div', 'dc-widget-results');
  shell.append(grid, results);

  function update() {
    const p = clampNumber(principalInput.input.value, 0, 100000000, principal);
    const annualRate = clampNumber(rateInput.input.value, 0, 30, rate);
    const termYears = clampNumber(yearsInput.input.value, 1, 40, years);
    const months = termYears * 12;
    const monthlyRate = annualRate / 100 / 12;
    const monthlyPayment = monthlyRate === 0
      ? p / months
      : p * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1);
    const totalPayment = monthlyPayment * months;
    const totalInterest = totalPayment - p;

    results.replaceChildren(
      createMetric('月供', formatCurrency(monthlyPayment)),
      createMetric('总利息', formatCurrency(totalInterest)),
      createMetric('还款总额', formatCurrency(totalPayment)),
    );
  }

  [principalInput.input, rateInput.input, yearsInput.input].forEach(input => {
    input.addEventListener('input', update);
  });
  update();
  return shell;
}

function createChartWidget(config, mode) {
  const items = normalizeChartData(config.data);
  const shell = createShell(config.title || (mode === 'bar' ? '数据柱状图' : '数据折线图'), '支持模型输出 JSON 数据后在当前回答中直接可视化。');
  const chart = el('div', 'dc-widget-chart');
  const svg = svgEl('svg');
  svg.setAttribute('viewBox', '0 0 640 300');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', config.title || '数据图表');
  chart.append(svg);
  shell.append(chart);

  if (items.length === 0) {
    chart.replaceChildren(createWidgetError('图表数据为空。'));
    return shell;
  }

  if (mode === 'line') drawLineChart(svg, items);
  else drawBarChart(svg, items);

  return shell;
}

function createProjectileDemo(config) {
  const shell = createShell('抛体运动演示', '调整初速度和角度，观察轨迹、最大高度和飞行距离。');
  const controls = el('div', 'dc-widget-grid dc-widget-grid-2');
  const velocity = createRangeField('初速度', clampNumber(config.velocity, 5, 100, 35), 5, 100, 1, 'm/s');
  const angle = createRangeField('发射角度', clampNumber(config.angle, 5, 85, 45), 5, 85, 1, '°');
  controls.append(velocity.wrap, angle.wrap);

  const stage = el('div', 'dc-widget-chart dc-widget-projectile');
  const svg = svgEl('svg');
  svg.setAttribute('viewBox', '0 0 640 300');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '抛体运动轨迹');
  stage.append(svg);
  const results = el('div', 'dc-widget-results');
  shell.append(controls, stage, results);

  function update() {
    const v = Number(velocity.input.value);
    const deg = Number(angle.input.value);
    velocity.value.textContent = `${v} m/s`;
    angle.value.textContent = `${deg}°`;

    const g = 9.8;
    const rad = deg * Math.PI / 180;
    const flight = 2 * v * Math.sin(rad) / g;
    const range = v * Math.cos(rad) * flight;
    const maxHeight = Math.pow(v * Math.sin(rad), 2) / (2 * g);
    drawProjectile(svg, v, rad, flight, range);
    results.replaceChildren(
      createMetric('飞行时间', `${flight.toFixed(2)} s`),
      createMetric('最大高度', `${maxHeight.toFixed(2)} m`),
      createMetric('水平距离', `${range.toFixed(2)} m`),
    );
  }

  [velocity.input, angle.input].forEach(input => input.addEventListener('input', update));
  update();
  return shell;
}

function createNumberField(label, value, min, max, step, suffix) {
  const wrap = el('label', 'dc-field');
  const text = el('span', 'dc-field-label', label);
  const row = el('span', 'dc-input-row');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.inputMode = 'decimal';
  row.append(input, el('span', 'dc-input-suffix', suffix));
  wrap.append(text, row);
  return { wrap, input };
}

function createRangeField(label, value, min, max, step, suffix) {
  const wrap = el('label', 'dc-field');
  const top = el('span', 'dc-field-top');
  const valueEl = el('span', 'dc-field-value', `${value} ${suffix}`);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  top.append(el('span', 'dc-field-label', label), valueEl);
  wrap.append(top, input);
  return { wrap, input, value: valueEl };
}

function createMetric(label, value) {
  const item = el('div', 'dc-metric');
  item.append(el('span', 'dc-metric-label', label), el('strong', '', value));
  return item;
}

function normalizeChartData(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map((item, index) => {
      if (typeof item === 'number') return { label: String(index + 1), value: item };
      if (!item || typeof item !== 'object') return null;
      return {
        label: String(item.label ?? item.name ?? index + 1).slice(0, 24),
        value: Number(item.value ?? item.y ?? item.amount),
      };
    })
    .filter(item => item && Number.isFinite(item.value))
    .slice(0, 16);
}

function drawBarChart(svg, items) {
  svg.replaceChildren();
  const width = 640;
  const height = 300;
  const pad = 42;
  const values = items.map(item => item.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const zeroY = height - pad - ((0 - min) / span) * (height - pad * 2);
  const barGap = 10;
  const barWidth = (width - pad * 2 - barGap * (items.length - 1)) / items.length;
  drawAxes(svg, width, height, pad);
  drawZeroLine(svg, width, pad, zeroY);

  items.forEach((item, index) => {
    const barHeight = Math.abs((height - pad * 2) * (item.value / span));
    const x = pad + index * (barWidth + barGap);
    const y = item.value >= 0 ? zeroY - barHeight : zeroY;
    const rect = svgEl('rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(Math.max(barWidth, 2)));
    rect.setAttribute('height', String(Math.max(barHeight, 1)));
    rect.setAttribute('rx', '5');
    rect.setAttribute('class', 'dc-chart-mark');
    svg.append(rect);
    drawLabel(svg, item.label, x + barWidth / 2, height - 14);
  });
}

function drawLineChart(svg, items) {
  svg.replaceChildren();
  const width = 640;
  const height = 300;
  const pad = 42;
  const values = items.map(item => item.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  drawAxes(svg, width, height, pad);

  const points = items.map((item, index) => {
    const x = pad + index * ((width - pad * 2) / Math.max(items.length - 1, 1));
    const y = height - pad - ((item.value - min) / span) * (height - pad * 2);
    return { x, y, label: item.label };
  });

  const path = svgEl('polyline');
  path.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
  path.setAttribute('class', 'dc-chart-line');
  path.setAttribute('fill', 'none');
  svg.append(path);

  points.forEach((point) => {
    const dot = svgEl('circle');
    dot.setAttribute('cx', String(point.x));
    dot.setAttribute('cy', String(point.y));
    dot.setAttribute('r', '4');
    dot.setAttribute('class', 'dc-chart-dot');
    svg.append(dot);
    drawLabel(svg, point.label, point.x, height - 14);
  });
}

function drawProjectile(svg, velocity, angle, flight, range) {
  svg.replaceChildren();
  const width = 640;
  const height = 300;
  const pad = 36;
  const g = 9.8;
  const points = [];
  for (let i = 0; i <= 64; i++) {
    const t = flight * i / 64;
    const x = velocity * Math.cos(angle) * t;
    const y = velocity * Math.sin(angle) * t - 0.5 * g * t * t;
    points.push({ x, y });
  }
  const maxY = Math.max(...points.map(point => point.y), 1);
  const pathPoints = points.map(point => {
    const x = pad + (point.x / Math.max(range, 1)) * (width - pad * 2);
    const y = height - pad - (point.y / maxY) * (height - pad * 2);
    return `${x},${y}`;
  }).join(' ');

  drawAxes(svg, width, height, pad);
  const path = svgEl('polyline');
  path.setAttribute('points', pathPoints);
  path.setAttribute('class', 'dc-chart-line');
  path.setAttribute('fill', 'none');
  svg.append(path);
}

function drawAxes(svg, width, height, pad) {
  const xAxis = svgEl('line');
  xAxis.setAttribute('x1', String(pad));
  xAxis.setAttribute('y1', String(height - pad));
  xAxis.setAttribute('x2', String(width - pad));
  xAxis.setAttribute('y2', String(height - pad));
  xAxis.setAttribute('class', 'dc-chart-axis');
  const yAxis = svgEl('line');
  yAxis.setAttribute('x1', String(pad));
  yAxis.setAttribute('y1', String(pad));
  yAxis.setAttribute('x2', String(pad));
  yAxis.setAttribute('y2', String(height - pad));
  yAxis.setAttribute('class', 'dc-chart-axis');
  svg.append(xAxis, yAxis);
}

function drawZeroLine(svg, width, pad, y) {
  const line = svgEl('line');
  line.setAttribute('x1', String(pad));
  line.setAttribute('y1', String(y));
  line.setAttribute('x2', String(width - pad));
  line.setAttribute('y2', String(y));
  line.setAttribute('class', 'dc-chart-axis dc-chart-zero');
  svg.append(line);
}

function drawLabel(svg, text, x, y) {
  const label = svgEl('text');
  label.setAttribute('x', String(x));
  label.setAttribute('y', String(y));
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('class', 'dc-chart-label');
  label.textContent = text;
  svg.append(label);
}

function createWidgetError(message) {
  const error = el('div', 'dc-widget-error');
  error.textContent = message;
  return error;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function formatCurrency(value) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 0,
  }).format(value);
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}
