// 看板渲染：纯 SVG 图表 + 表格视图双胞胎 + 全局工具提示
// 数据来自 window.SBD_DATA（build-data.js 生成）
(function () {
  'use strict';
  const DATA = window.SBD_DATA;
  const SBD = window.SBD;
  const tooltip = document.getElementById('tooltip');

  const C = {
    pop: 'var(--series-1)', sample: 'var(--series-2)', corrected: 'var(--series-3)',
    sens: 'var(--series-4)', supp: 'var(--series-5)',
    grid: 'var(--grid)', axis: 'var(--axis)',
    muted: 'var(--text-muted)', ink2: 'var(--text-secondary)',
    good: 'var(--good)', warning: 'var(--warning)', critical: 'var(--critical)',
    neg: 'var(--diverge-neg)', pos: 'var(--diverge-pos)',
  };

  // ---------- DOM 辅助（全部 textContent，防注入） ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function showTip(evt, title, rows) {
    tooltip.innerHTML = '';
    tooltip.appendChild(el('div', 'tt-title', title));
    for (const r of rows) {
      const row = el('div', 'tt-row');
      if (r.color) {
        const key = el('span', 'tt-key');
        key.style.background = r.color;
        row.appendChild(key);
      }
      row.appendChild(el('span', null, r.label));
      row.appendChild(el('span', 'tt-val', r.value));
      tooltip.appendChild(row);
    }
    tooltip.classList.add('show');
    moveTip(evt);
  }
  function moveTip(evt) {
    const pad = 14;
    const rect = tooltip.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  function hideTip() { tooltip.classList.remove('show'); }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }

  // 数值格式化
  const fmtPct = (v, d = 1) => v == null ? '—' : (v * 100).toFixed(d) + '%';
  const fmtNum = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const fmtSigned = (v, d = 3) => v == null ? '—' : (v > 0 ? '+' : '') + fmtNum(v, d);
  const fmtMoney = v => v == null ? '—' : '¥' + fmtNum(v, 0);
  function estimandFmt(row, v) {
    if (!row) return fmtNum(v);
    if (row.fmt === 'pct') return fmtPct(v, 2);
    if (row.fmt === 'money') return fmtMoney(v);
    return fmtNum(v, 2);
  }

  // ---------- 通用坐标轴 ----------
  function niceTicks(max, min = 0, count = 4) {
    const range = max - min;
    const raw = range / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  // ================================================================
  // 图 1：分组条形（总体 vs 样本占比），支持第三系列（修正后）
  // ================================================================
  function groupedBar(container, rows, opts = {}) {
    const { width = 640, barH = 22, gapGroup = 16, padL = 92, padR = 56, padT = 8, padB = 28 } = opts;
    const series = opts.series || [
      { key: 'popP', label: '总体占比', color: C.pop },
      { key: 'sampleP', label: '样本占比', color: C.sample },
    ];
    const h = padT + rows.length * (barH * series.length + gapGroup) + padB;
    const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${h}`, role: 'img' });
    const maxV = Math.max(...rows.flatMap(r => series.map(s => r[s.key] || 0)), 0.001);
    const plotW = width - padL - padR;

    // 网格
    const ticks = niceTicks(maxV);
    for (const t of ticks) {
      const x = padL + (t / maxV) * plotW;
      chart.appendChild(svg('line', { x1: x, y1: padT, x2: x, y2: h - padB, class: 'grid-line' }));
      const tx = svg('text', { x, y: h - padB + 15, 'text-anchor': 'middle', class: 'axis-text' });
      tx.textContent = fmtPct(t, 0);
      chart.appendChild(tx);
    }

    rows.forEach((r, ri) => {
      const y0 = padT + ri * (barH * series.length + gapGroup);
      const label = svg('text', { x: padL - 8, y: y0 + barH * series.length / 2 + 4, 'text-anchor': 'end', class: 'axis-text' });
      label.textContent = r.key === '__NA__' ? '（缺失）' : r.key;
      chart.appendChild(label);
      series.forEach((s, si) => {
        const v = r[s.key] || 0;
        const bw = Math.max(0, (v / maxV) * plotW);
        const y = y0 + si * barH;
        const rect = svg('rect', {
          x: padL, y: y + 2, width: Math.max(bw, v > 0 ? 2 : 0), height: barH - 4,
          rx: si === series.length - 1 ? 4 : 0, ry: 4, fill: s.color, class: 'bar',
        });
        if (si === 0) rect.setAttribute('rx', 0); // 基线侧方角
        rect.addEventListener('mousemove', e => showTip(e, r.key === '__NA__' ? '缺失值' : r.key,
          series.map(ss => ({ color: ss.color, label: ss.label, value: fmtPct(r[ss.key], 2) }))));
        rect.addEventListener('mouseleave', hideTip);
        chart.appendChild(rect);
        const vt = svg('text', { x: padL + bw + 6, y: y + barH / 2 + 4, class: 'axis-text' });
        vt.textContent = fmtPct(v, 1);
        chart.appendChild(vt);
      });
    });
    // 图例
    const legend = el('div', 'legend');
    for (const s of series) {
      const item = el('span', 'item');
      item.appendChild(Object.assign(document.createElement('span'), { className: 'swatch', style: `background:${s.color}` }));
      item.appendChild(el('span', null, s.label));
      legend.appendChild(item);
    }
    container.appendChild(legend);
    container.appendChild(chart);
  }

  // ================================================================
  // 图 2：SMD 发散条形（偏差方向与幅度，0 基线）
  // ================================================================
  function smdDiverging(container, rows, opts = {}) {
    const { width = 640, rowH = 30, padL = 92, padR = 24, padT = 8, padB = 30 } = opts;
    const maxAbs = Math.max(0.05, ...rows.map(r => Math.abs(r.smd || 0)));
    const h = padT + rows.length * rowH + padB;
    const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${h}`, role: 'img' });
    const x0 = padL + (width - padL - padR) / 2;
    const half = (width - padL - padR) / 2;
    const xFor = v => x0 + (v / maxAbs) * half;

    // 0 基线 + 阈值线 |SMD|=0.1
    chart.appendChild(svg('line', { x1: x0, y1: padT, x2: x0, y2: h - padB, class: 'axis-line' }));
    for (const t of [0.1, -0.1]) {
      const x = xFor(t);
      chart.appendChild(svg('line', { x1: x, y1: padT, x2: x, y2: h - padB, class: 'grid-line', 'stroke-dasharray': 'none' }));
    }
    const warnL = svg('text', { x: xFor(0.1) + 4, y: padT + 10, class: 'axis-text' });
    warnL.textContent = '|SMD|=0.1 偏差警戒线';
    chart.appendChild(warnL);

    rows.forEach((r, i) => {
      const y = padT + i * rowH;
      const lab = svg('text', { x: padL - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'axis-text' });
      lab.textContent = r.key === '__NA__' ? '（缺失）' : r.key;
      chart.appendChild(lab);
      const v = r.smd || 0;
      const bx = v >= 0 ? x0 : xFor(v);
      const bw = Math.abs(xFor(v) - x0);
      const color = Math.abs(v) >= 0.1 ? C.critical : Math.abs(v) >= 0.05 ? C.warning : C.corrected;
      const rect = svg('rect', { x: bx, y: y + 5, width: Math.max(bw, 1.5), height: rowH - 10, rx: 4, fill: color, class: 'bar' });
      rect.addEventListener('mousemove', e => showTip(e, r.key, [
        { color, label: 'SMD', value: fmtSigned(v, 3) },
        { label: '比例差', value: fmtSigned(r.diffPct, 4) },
        { label: '相对比', value: r.relRatio == null ? '—' : fmtNum(r.relRatio, 2) + '×' },
      ]));
      rect.addEventListener('mouseleave', hideTip);
      chart.appendChild(rect);
      const vt = svg('text', { x: xFor(v) + (v >= 0 ? 6 : -6), y: y + rowH / 2 + 4, 'text-anchor': v >= 0 ? 'start' : 'end', class: 'axis-text' });
      vt.textContent = fmtSigned(v, 2);
      chart.appendChild(vt);
    });
    container.appendChild(chart);
  }

  // ================================================================
  // 图 3：多系列折线（按周占比趋势，带十字线）
  // ================================================================
  function lineChart(container, series, opts = {}) {
    const { width = 640, height = 260, padL = 52, padR = 18, padT = 14, padB = 34 } = opts;
    const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    const allV = series.flatMap(s => s.values);
    const maxV = Math.max(...allV) * 1.08, minV = opts.zeroBaseline ? 0 : Math.min(...allV) * 0.9;
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const xFor = i => padL + (series[0].values.length <= 1 ? 0 : (i / (series[0].values.length - 1)) * plotW);
    const yFor = v => padT + plotH - ((v - minV) / (maxV - minV)) * plotH;

    const ticks = niceTicks(maxV, minV);
    for (const t of ticks) {
      const y = yFor(t);
      chart.appendChild(svg('line', { x1: padL, y1: y, x2: width - padR, y2: y, class: 'grid-line' }));
      const tx = svg('text', { x: padL - 7, y: y + 4, 'text-anchor': 'end', class: 'axis-text' });
      tx.textContent = opts.tickFmt ? opts.tickFmt(t) : fmtNum(t, 2);
      chart.appendChild(tx);
    }
    const labels = opts.xLabels || [];
    labels.forEach((lb, i) => {
      const tx = svg('text', { x: xFor(i), y: height - padB + 17, 'text-anchor': 'middle', class: 'axis-text' });
      tx.textContent = lb;
      chart.appendChild(tx);
    });

    series.forEach(s => {
      const pts = s.values.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');
      chart.appendChild(svg('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      s.values.forEach((v, i) => {
        const dot = svg('circle', { cx: xFor(i), cy: yFor(v), r: 4, fill: s.color, stroke: 'var(--surface-1)', 'stroke-width': 2 });
        chart.appendChild(dot);
      });
    });

    // 十字线 + 单 tooltip 全系列
    const cross = svg('line', { y1: padT, y2: height - padB, stroke: C.axis, 'stroke-width': 1, visibility: 'hidden' });
    chart.appendChild(cross);
    const hit = svg('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
    hit.addEventListener('mousemove', e => {
      const rect = chart.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (width / rect.width);
      const idx = SBD.clamp(Math.round(((px - padL) / plotW) * (labels.length - 1)), 0, labels.length - 1);
      cross.setAttribute('x1', xFor(idx)); cross.setAttribute('x2', xFor(idx));
      cross.setAttribute('visibility', 'visible');
      showTip(e, opts.xTitle ? `${opts.xTitle} ${labels[idx]}` : labels[idx],
        series.map(s => ({ color: s.color, label: s.label, value: opts.tipFmt ? opts.tipFmt(s.values[idx]) : fmtNum(s.values[idx], 3) })));
    });
    hit.addEventListener('mouseleave', () => { hideTip(); cross.setAttribute('visibility', 'hidden'); });
    chart.appendChild(hit);

    const legend = el('div', 'legend');
    for (const s of series) {
      const item = el('span', 'item');
      const key = el('span', 'linekey'); key.style.background = s.color;
      item.appendChild(key); item.appendChild(el('span', null, s.label));
      legend.appendChild(item);
    }
    container.appendChild(legend);
    container.appendChild(chart);
  }

  // ================================================================
  // 图 4：箱线/分布对比（总体 vs 样本，四分位 + 中位数）
  // ================================================================
  function boxCompare(container, stats, opts = {}) {
    const { width = 640, height = 150, padL = 80, padR = 30 } = opts;
    const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    const allV = stats.flatMap(s => [s.q1, s.median, s.q3]);
    const minV = Math.min(...allV) * 0.95, maxV = Math.max(...allV) * 1.05;
    const xFor = v => padL + ((v - minV) / (maxV - minV)) * (width - padL - padR);
    stats.forEach((s, i) => {
      const y = 34 + i * 48;
      const lab = svg('text', { x: padL - 10, y: y + 12, 'text-anchor': 'end', class: 'axis-text' });
      lab.textContent = s.label;
      chart.appendChild(lab);
      // 须线 Q1-Q3，箱体厚度 20px（<=24 规范）
      chart.appendChild(svg('line', { x1: xFor(s.q1), y1: y + 10, x2: xFor(s.q3), y2: y + 10, stroke: s.color, 'stroke-width': 2 }));
      chart.appendChild(svg('rect', { x: xFor(s.q1), y: y, width: Math.max(2, xFor(s.q3) - xFor(s.q1)), height: 20, rx: 4, fill: s.color, opacity: 0.22, stroke: s.color, 'stroke-width': 1.5 }));
      chart.appendChild(svg('line', { x1: xFor(s.median), y1: y - 2, x2: xFor(s.median), y2: y + 22, stroke: s.color, 'stroke-width': 2.5 }));
      const hit = svg('rect', { x: padL, y: y - 8, width: width - padL - padR, height: 36, fill: 'transparent' });
      hit.addEventListener('mousemove', e => showTip(e, s.label, [
        { color: s.color, label: '中位数', value: fmtNum(s.median, 2) },
        { label: 'Q1 / Q3', value: `${fmtNum(s.q1, 2)} / ${fmtNum(s.q3, 2)}` },
        { label: '均值', value: fmtNum(s.mean, 2) },
      ]));
      hit.addEventListener('mouseleave', hideTip);
      chart.appendChild(hit);
    });
    const ticks = niceTicks(maxV, minV, 4);
    for (const t of ticks) {
      const tx = svg('text', { x: xFor(t), y: height - 6, 'text-anchor': 'middle', class: 'axis-text' });
      tx.textContent = fmtNum(t, 0);
      chart.appendChild(tx);
    }
    container.appendChild(chart);
  }

  // ================================================================
  // 图 5：权重分布直方图（诊断极端权重）
  // ================================================================
  function weightHistogram(container, weights, opts = {}) {
    const { width = 640, height = 230, padL = 50, padR = 46, padT = 12, padB = 32 } = opts;
    const sorted = weights.slice().sort((a, b) => a - b);
    const p99 = SBD.quantile(sorted, 0.99), p50 = SBD.quantile(sorted, 0.5);
    const maxV = Math.max(...weights);
    // 主区 22 个等宽箱覆盖 0–P99；右侧独立尾柱承载所有 >P99 的极端权重
    const bins = 22;
    const cutoff = p99 * 1.05;
    const counts = new Array(bins).fill(0);
    let tail = 0;
    for (const w of weights) {
      if (w > cutoff) { tail++; continue; }
      const b = Math.min(bins - 1, Math.floor((w / cutoff) * bins));
      counts[b]++;
    }
    const chart = svg('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img' });
    const plotW = width - padL - padR, plotH = height - padT - padB;
    const maxC = Math.max(...counts, tail);
    // 柱高上限 24px（条形厚度规范），上限通过缩减绘图区实现，保留相对比例
    const maxBarH = Math.min(plotH, 24);
    // 主区占 plotW 的 88%，尾柱占 12%，中间留 8px 表面间隔
    const mainW = plotW * 0.88, tailW = plotW * 0.12 - 8;
    const bw = mainW / bins;
    counts.forEach((c, i) => {
      const bh = (c / maxC) * maxBarH;
      const x = padL + i * bw, y = padT + plotH - bh;
      const rect = svg('rect', { x: x + 1, y, width: bw - 2, height: Math.max(bh, c ? 2 : 0), fill: C.sample, rx: i === bins - 1 ? 4 : 0, class: 'bar' });
      rect.addEventListener('mousemove', e => showTip(e, `权重区间 ${fmtNum((i / bins) * cutoff, 2)}–${fmtNum(((i + 1) / bins) * cutoff, 2)}`, [
        { color: C.sample, label: '记录数', value: String(c) },
      ]));
      rect.addEventListener('mouseleave', hideTip);
      chart.appendChild(rect);
    });
    // 尾柱（>P99 的极端权重，独立区间，红色警示）
    if (tail > 0) {
      const bh = (tail / maxC) * maxBarH;
      const x = padL + mainW + 8;
      const rect = svg('rect', { x, y: padT + plotH - bh, width: tailW, height: bh, fill: C.critical, rx: 4, class: 'bar' });
      rect.addEventListener('mousemove', e => showTip(e, `极端权重 > P99(${fmtNum(p99, 2)})`, [
        { color: C.critical, label: '记录数', value: String(tail) },
        { label: '全局最大', value: fmtNum(maxV, 2) },
      ]));
      rect.addEventListener('mouseleave', hideTip);
      chart.appendChild(rect);
      const tx = svg('text', { x: x + tailW / 2, y: padT + plotH - bh - 5, 'text-anchor': 'middle', class: 'axis-text' });
      tx.textContent = tail;
      chart.appendChild(tx);
      const lab = svg('text', { x: x + tailW / 2, y: height - 8, 'text-anchor': 'middle', class: 'axis-text' });
      lab.textContent = `>${fmtNum(p99, 1)} 尾部`;
      chart.appendChild(lab);
    }
    chart.appendChild(svg('line', { x1: padL, y1: padT + plotH, x2: width - padR, y2: padT + plotH, class: 'axis-line' }));
    const t1 = svg('text', { x: padL, y: height - 8, class: 'axis-text' }); t1.textContent = '0';
    const t2 = svg('text', { x: padL + mainW * 0.55, y: height - 8, class: 'axis-text' }); t2.textContent = 'P50=' + fmtNum(p50, 2);
    const t3 = svg('text', { x: padL + mainW - 30, y: height - 8, class: 'axis-text' }); t3.textContent = 'P99=' + fmtNum(p99, 2);
    chart.appendChild(t1, t2, t3);
    container.appendChild(chart);
  }

  // ---------- 表格视图（图表的无障碍双胞胎） ----------
  function tableToggle(card, buildTable) {
    const toggle = el('div', 'view-toggle');
    const bChart = el('button', 'btn', '图表');
    const bTable = el('button', 'btn', '表格');
    bChart.setAttribute('aria-pressed', 'true');
    const chartView = el('div', 'chart-view');
    const tableView = el('div', 'native-table');
    toggle.append(bChart, bTable);
    card.querySelector('.card-head').appendChild(toggle);
    card.appendChild(chartView);
    card.appendChild(tableView);
    buildTable(tableView);
    bChart.onclick = () => { chartView.classList.remove('hide'); tableView.classList.remove('show'); bChart.setAttribute('aria-pressed', 'true'); bTable.setAttribute('aria-pressed', 'false'); };
    bTable.onclick = () => { chartView.classList.add('hide'); tableView.classList.add('show'); bTable.setAttribute('aria-pressed', 'true'); bChart.setAttribute('aria-pressed', 'false'); };
    return chartView;
  }
  function makeTable(container, headers, rows) {
    const wrap = el('div', 'table-wrap');
    const t = el('table');
    const thead = el('thead'); const trh = el('tr');
    headers.forEach(h => { const th = el('th', h.numeric ? 'num' : null, h.label); trh.appendChild(th); });
    thead.appendChild(trh); t.appendChild(thead);
    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      r.forEach((cell, i) => {
        const td = el('td', headers[i].numeric ? 'num' : null);
        if (cell && typeof cell === 'object') {
          if (cell.color) { const mk = el('span', 'mk'); mk.style.background = cell.color; td.appendChild(mk); }
          td.appendChild(document.createTextNode(cell.text));
        } else td.textContent = cell == null ? '—' : String(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    t.appendChild(tbody); wrap.appendChild(t); container.appendChild(wrap);
  }

  window.SBD_UI = {
    el, svg, showTip, hideTip, makeTable, tableToggle,
    groupedBar, smdDiverging, lineChart, boxCompare, weightHistogram,
    fmtPct, fmtNum, fmtSigned, fmtMoney, estimandFmt, C,
  };
})();
