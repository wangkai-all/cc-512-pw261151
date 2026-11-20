// 看板主应用：组装六大板块，过滤器一处生效、所有视图同步重渲染
(function () {
  'use strict';
  const DATA = window.SBD_DATA;
  const UI = window.SBD_UI;
  const { el, makeTable, tableToggle, groupedBar, smdDiverging, lineChart, boxCompare,
    weightHistogram, fmtPct, fmtNum, fmtSigned, fmtMoney, estimandFmt, C } = UI;

  const state = { dim: 'region', numDim: 'amount', estimand: 'duration_mean' };
  const app = document.getElementById('app');

  document.getElementById('footN').textContent =
    `总体 ${DATA.meta.populationN.toLocaleString()} 单 · 样本 ${DATA.meta.sampleN.toLocaleString()} 单 · 回补 ${DATA.meta.supplementN} 单`;
  document.getElementById('scopeNote').textContent =
    `全局过滤器同时作用于下方全部图表与表格 · 种子 ${DATA.meta.seed}`;

  // ---------- 小工具 ----------
  function card(title, hint) {
    const c = el('div', 'card');
    const head = el('div', 'card-head');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;';
    head.appendChild(el('h3', null, title));
    c.appendChild(head);
    if (hint) c.appendChild(el('p', 'hint', hint));
    return c;
  }
  function section(title, desc) {
    const s = el('section');
    const head = el('div', 'section-head');
    head.appendChild(el('h2', null, title));
    if (desc) head.appendChild(el('span', 'desc', desc));
    s.appendChild(head);
    app.appendChild(s);
    return s;
  }
  function smdBadge(v) {
    const a = Math.abs(v);
    if (a >= 0.1) return el('span', 'badge critical', '显著偏差 ≥0.1');
    if (a >= 0.05) return el('span', 'badge warning', '轻度偏差 0.05–0.1');
    return el('span', 'badge good', '可接受 <0.05');
  }
  function pBadge(p) {
    if (p == null) return el('span', 'badge neutral', '不适用');
    if (p < 0.001) return el('span', 'badge critical', 'p<0.001 拒绝齐性');
    if (p < 0.05) return el('span', 'badge warning', 'p<0.05');
    return el('span', 'badge good', 'p≥0.05');
  }

  // ================================================================
  // 板块 0：KPI 概览
  // ================================================================
  function renderKpis() {
    const sec = section('概览', '一眼看清样本规模、偏差面、权重代价与缺失情况');
    const grid = el('div', 'grid k4');
    const v1diag = DATA.corrections.V1.weightDiag;
    const miss = DATA.corrections.V3.missing.satisfaction;
    const maxSmd = Math.max(...DATA.bias.categorical.map(d => d.maxAbsSmd),
      ...DATA.bias.numeric.map(d => d.absSmd));
    const kpis = [
      { label: '样本 / 总体', value: DATA.meta.sampleN.toLocaleString(), meta: `总体 ${DATA.meta.populationN.toLocaleString()} 单 · 抽样比 ${fmtPct(DATA.meta.sampleN / DATA.meta.populationN, 2)}` },
      { label: '最大标准化偏差 |SMD|', value: fmtNum(maxSmd, 3), meta: '跨时间/地区/渠道/属性的最大偏差', badge: smdBadge(maxSmd) },
      { label: '加权有效样本量 Neff', value: fmtNum(v1diag.neff, 0), meta: `名义 ${v1diag.n} · 设计效应 Deff=${v1diag.deff} · 仅保留 ${fmtPct(v1diag.neffRatio, 1)}`, badge: el('span', 'badge warning', '权重极端化') },
      { label: '满意度缺失 / 地区缺失', value: fmtPct(miss.missingRate, 1), meta: `${miss.nMissing} 单满意度缺失 · ${DATA.corrections.V3.missing.region.nMissing} 单地区缺失（MNAR）`, badge: el('span', 'badge critical', '需缺失处理') },
    ];
    for (const k of kpis) {
      const c = el('div', 'card stat');
      c.appendChild(el('span', 'label', k.label));
      c.appendChild(el('span', 'value', k.value));
      c.appendChild(el('span', 'meta', k.meta));
      if (k.badge) c.appendChild(k.badge);
      grid.appendChild(c);
    }
    sec.appendChild(grid);
  }

  // ================================================================
  // 板块 1：覆盖率
  // ================================================================
  function renderCoverage() {
    const sec = section('① 覆盖率', '每个维度的格子在样本中是否出现；联合层空层是分层修正的直接威胁');
    const grid = el('div', 'grid k4');
    const dimName = { region: '地区', channel: '渠道', segment: '客群', isWeekend: '周末' };
    for (const [dim, cv] of Object.entries(DATA.coverage)) {
      const c = el('div', 'card stat');
      c.appendChild(el('span', 'label', `${dimName[dim]}维度格子覆盖`));
      c.appendChild(el('span', 'value', fmtPct(cv.cellCoverage, 0)));
      c.appendChild(el('span', 'meta', `${cv.coveredCells}/${cv.populationCells} 个类别命中`));
      c.appendChild(cv.missingCells.length
        ? el('span', 'badge critical', `空类别: ${cv.missingCells.join('、')}`)
        : el('span', 'badge good', '无缺失类别'));
      grid.appendChild(c);
    }
    sec.appendChild(grid);

    // 联合层
    const jc = DATA.jointCoverage;
    const call = el('div', jc.emptyStrata.length ? 'callout critical' : 'callout good');
    const icon = el('span', 'icon', jc.emptyStrata.length ? '⚠️' : '✅');
    const body = el('div');
    body.appendChild(el('strong', null, `联合层（地区 × 渠道）覆盖：${jc.coverage === 1 ? '全覆盖' : fmtPct(jc.coverage, 1)}，${jc.emptyStrata.length} 个空层 / 共 ${jc.nStrata} 层`));
    if (jc.emptyStrata.length) {
      const ul = el('ul');
      for (const e of jc.emptyStrata) {
        const li = el('li');
        li.textContent = `空层 ${e.stratum}：总体有 ${e.nPop.toLocaleString()} 单，样本零命中 — 该层无法从样本直接估计，V2 已回退到地区边缘权重并标记为不可识别`;
        ul.appendChild(li);
      }
      body.appendChild(ul);
    }
    call.append(icon, body);
    sec.appendChild(call);

    // 按周趋势（时间维度覆盖）
    const trendCard = card('时间覆盖：12 周内总体 vs 样本的周占比', '十字线悬停查看每周双系列数值；样本在周末过抽、周间波动更大');
    const tv = tableToggle(trendCard, tbl => makeTable(tbl,
      [{ label: '周次' }, { label: '总体占比', numeric: true }, { label: '样本占比', numeric: true }, { label: '差异（百分点）', numeric: true }],
      DATA.weeklyTrend.map(w => [`第${w.week}周`, fmtPct(w.popShare, 2), fmtPct(w.sampleShare, 2),
        fmtSigned((w.sampleShare - w.popShare) * 100, 2) + ' pp'])));
    lineChart(tv, [
      { label: '总体周占比', color: C.pop, values: DATA.weeklyTrend.map(w => w.popShare) },
      { label: '样本周占比', color: C.sample, values: DATA.weeklyTrend.map(w => w.sampleShare) },
    ], {
      xLabels: DATA.weeklyTrend.map(w => 'W' + w.week), xTitle: '第',
      tickFmt: v => fmtPct(v, 0), tipFmt: v => fmtPct(v, 2),
    });
    sec.appendChild(trendCard);

    // 联合层明细表
    const cellCard = card('联合层明细表（按样本量升序，空层与薄层排在最前）');
    const thin = new Set(DATA.corrections.V2.thinStrata.map(t => t.stratum));
    tableToggle(cellCard, tbl => makeTable(tbl,
      [{ label: '联合层' }, { label: '总体单量', numeric: true }, { label: '样本量', numeric: true },
      { label: '目标占比', numeric: true }, { label: '状态' }],
      jc.rows.map(r => [r.stratum, r.nPop.toLocaleString(), r.nSample,
        fmtPct(r.nPop / DATA.meta.populationN, 2),
        r.empty ? { text: '空层（已回退）', color: C.critical }
          : thin.has(r.stratum) ? { text: '薄层（已折叠）', color: C.warning }
            : { text: '正常', color: C.corrected }])));
    const tv2 = cellCard.querySelector('.chart-view');
    // 用水平条形表达 nSample / nPop 的稀薄程度
    const maxPop = Math.max(...jc.rows.map(r => r.nPop));
    const wsvg = UI.svg('svg', { class: 'chart', viewBox: `0 0 640 ${jc.rows.length * 26 + 20}`, role: 'img' });
    jc.rows.forEach((r, i) => {
      const y = 10 + i * 26;
      const t = UI.svg('text', { x: 0, y: y + 13, class: 'axis-text' }); t.textContent = r.stratum;
      const wPop = (r.nPop / maxPop) * 300;
      wsvg.appendChild(UI.svg('rect', { x: 130, y: y + 4, width: wPop, height: 9, rx: 4, fill: C.pop, opacity: 0.35 }));
      const wSamp = Math.max(1.5, (r.nSample / Math.max(...jc.rows.map(x => x.nSample))) * 180);
      const col = r.empty ? C.critical : thin.has(r.stratum) ? C.warning : C.sample;
      const rect = UI.svg('rect', { x: 440, y: y + 2, width: Math.min(wSamp, 180), height: 13, rx: 4, fill: col });
      rect.addEventListener('mousemove', e => UI.showTip(e, r.stratum, [
        { color: C.pop, label: '总体', value: r.nPop.toLocaleString() },
        { color: col, label: '样本', value: String(r.nSample) },
      ]));
      rect.addEventListener('mouseleave', UI.hideTip);
      wsvg.appendChild(rect);
      const nt = UI.svg('text', { x: 440 + Math.min(wSamp, 180) + 6, y: y + 13, class: 'axis-text' });
      nt.textContent = r.nSample;
      wsvg.appendChild(nt);
    });
    tv2.appendChild(wsvg);
    sec.appendChild(cellCard);
  }

  // ================================================================
  // 板块 2：偏差证据
  // ================================================================
  function renderBias() {
    const sec = section('② 偏差证据', 'SMD（标准化均值差）、卡方齐性检验、K-S 分布检验 — 修正前的原始证据');
    const cat = DATA.bias.categorical.find(d => d.dim === state.dim);

    // 证据摘要 callout
    const call = el('div', 'callout warning');
    const cb = el('div');
    cb.appendChild(el('strong', null, `${dimLabel(state.dim)}维度：最大 |SMD|=${fmtNum(cat.maxAbsSmd, 3)}，卡方 χ²=${fmtNum(cat.chiSq, 2)}（df=${cat.df}）`));
    const ul = el('ul');
    cat.rows.filter(r => r.absSmd >= 0.1).slice(0, 5).forEach(r => {
      const li = el('li');
      li.textContent = `${r.key === '__NA__' ? '缺失' : r.key}：总体占比 ${fmtPct(r.popP, 1)} vs 样本 ${fmtPct(r.sampleP, 1)}，SMD=${fmtSigned(r.smd, 3)}，相对比 ${fmtNum(r.relRatio, 2)}×`;
      ul.appendChild(li);
    });
    cb.appendChild(ul);
    call.append(el('span', 'icon', '📊'), cb);
    sec.appendChild(call);

    const g = el('div', 'grid k2');
    // 分组条形
    const c1 = card(`${dimLabel(state.dim)}：总体 vs 样本占比对照`);
    const tv1 = tableToggle(c1, tbl => makeTable(tbl,
      [{ label: '类别' }, { label: '总体占比', numeric: true }, { label: '样本占比', numeric: true },
      { label: '比例差', numeric: true }, { label: 'SMD', numeric: true }, { label: '检验' }],
      cat.rows.map(r => [r.key === '__NA__' ? '缺失' : r.key, fmtPct(r.popP, 2), fmtPct(r.sampleP, 2),
        fmtSigned(r.diffPct, 4), fmtSigned(r.smd, 3), smdBadge(r.absSmd).textContent])));
    groupedBar(tv1, cat.rows);
    g.appendChild(c1);

    // SMD 发散
    const c2 = card(`${dimLabel(state.dim)}：SMD 发散图（负=样本不足，正=样本过度）`, '|SMD|≥0.1 为显著偏差警戒线，红色标记');
    const tv2 = tableToggle(c2, tbl => makeTable(tbl,
      [{ label: '类别' }, { label: 'SMD', numeric: true }, { label: '相对比', numeric: true }, { label: '判定' }],
      cat.rows.map(r => [r.key, fmtSigned(r.smd, 3), fmtNum(r.relRatio, 2) + '×', smdBadge(r.absSmd).textContent])));
    smdDiverging(tv2, cat.rows);
    g.appendChild(c2);
    sec.appendChild(g);

    // 连续变量
    const nb = DATA.bias.numeric.find(d => d.dim === state.numDim);
    const g2 = el('div', 'grid k2');
    const c3 = card(`${numLabel(state.numDim)}：分布对比（四分位距 + 中位数）`, `SMD=${fmtSigned(nb.smd, 3)} · K-S D=${fmtNum(nb.ksD, 3)}（p=${nb.ksP}）· 样本缺失率 ${fmtPct(nb.missingRate, 1)}`);
    const tv3 = tableToggle(c3, tbl => makeTable(tbl,
      [{ label: '统计量' }, { label: '总体' }, { label: '样本' }, { label: '差异' }],
      [
        ['均值', fmtNum(nb.popMean, 2), fmtNum(nb.sampleMean, 2), fmtSigned(nb.sampleMean - nb.popMean, 2)],
        ['中位数', fmtNum(nb.popMedian, 2), fmtNum(nb.sampleMedian, 2), fmtSigned(nb.sampleMedian - nb.popMedian, 2)],
        ['Q1', fmtNum(nb.popQ1, 2), fmtNum(nb.sampleQ1, 2), ''],
        ['Q3', fmtNum(nb.popQ3, 2), fmtNum(nb.sampleQ3, 2), ''],
      ]));
    boxCompare(tv3, [
      { label: '总体', q1: nb.popQ1, median: nb.popMedian, q3: nb.popQ3, mean: nb.popMean, color: C.pop },
      { label: '样本', q1: nb.sampleQ1, median: nb.sampleMedian, q3: nb.sampleQ3, mean: nb.sampleMean, color: C.sample },
    ]);
    g2.appendChild(c3);

    // 全部维度 SMD 汇总
    const c4 = card('全维度偏差汇总（分类 SMD + 连续 SMD/K-S）');
    const rows = [
      ...DATA.bias.categorical.map(d => ({ dim: dimLabel(d.dim), smd: d.maxAbsSmd, test: `χ² p=${d.pValue == null ? '—' : fmtNum(d.pValue, 4)}`, kind: '分类' })),
      ...DATA.bias.numeric.map(d => ({ dim: numLabel(d.dim), smd: d.absSmd, test: `K-S p=${fmtNum(d.ksP, 4)}`, kind: '连续' })),
    ].sort((a, b) => b.smd - a.smd);
    tableToggle(c4, tbl => makeTable(tbl,
      [{ label: '维度' }, { label: '类型' }, { label: '最大 |SMD|', numeric: true }, { label: '分布检验' }, { label: '判定' }],
      rows.map(r => [r.dim, r.kind, fmtNum(r.smd, 3), r.test, smdBadge(r.smd).textContent])));
    const tv4 = c4.querySelector('.chart-view');
    const hsvg = UI.svg('svg', { class: 'chart', viewBox: `0 0 640 ${rows.length * 30 + 10}`, role: 'img' });
    const maxS = Math.max(0.12, ...rows.map(r => r.smd));
    rows.forEach((r, i) => {
      const y = 8 + i * 30;
      const t = UI.svg('text', { x: 0, y: y + 15, class: 'axis-text' }); t.textContent = r.dim;
      const w = (r.smd / maxS) * 420;
      const col = r.smd >= 0.1 ? C.critical : r.smd >= 0.05 ? C.warning : C.corrected;
      const rect = UI.svg('rect', { x: 96, y: y + 4, width: Math.max(w, 2), height: 18, rx: 4, fill: col });
      rect.addEventListener('mousemove', e => UI.showTip(e, r.dim, [{ color: col, label: '|SMD|', value: fmtNum(r.smd, 3) }, { label: r.test }]));
      rect.addEventListener('mouseleave', UI.hideTip);
      hsvg.appendChild(rect);
      const vt = UI.svg('text', { x: 96 + w + 6, y: y + 17, class: 'axis-text' }); vt.textContent = fmtNum(r.smd, 3);
      hsvg.appendChild(vt);
    });
    tv4.appendChild(hsvg);
    g2.appendChild(c4);
    sec.appendChild(g2);
  }

  // ================================================================
  // 板块 3：修正方案（三个独立版本）
  // ================================================================
  function renderCorrections() {
    const sec = section('③ 修正方案', '三种修正各自生成独立版本与独立权重列，原样本 V0 永不被修改或覆盖');

    // 版本血缘
    const lineageCard = card('版本血缘（只读 V0 → 三个独立修正快照）');
    const lg = el('div', 'lineage');
    DATA.lineage.forEach((v, i) => {
      const node = el('div', 'node');
      node.appendChild(el('div', 'vid', v.id + ' · ' + v.desc.split('，')[0].replace(/^.*?：/, '').replace(/^原始抽样记录.*$/, '原样本（只读基线）').replace(/^深拷贝样本.*$/, v.id === 'V1' ? '加权修正' : v.id === 'V2' ? '分层修正' : '缺失与回补')));
      node.appendChild(el('div', 'vdesc', v.desc));
      node.appendChild(el('div', 'vn', `行数 ${v.n.toLocaleString()}`));
      lg.appendChild(node);
      if (i < DATA.lineage.length - 1) lg.appendChild(el('div', 'arrow', '→'));
    });
    lineageCard.appendChild(lg);
    sec.appendChild(lineageCard);

    // ---- V1 加权 ----
    const v1 = DATA.corrections.V1;
    const s1 = section('V1 · 加权修正（IPF / Raking 校准）',
      `以设计权重为初值，迭代校准地区×渠道×客群×周末四个边际到总体；${v1.iterations} 轮${v1.converged ? '收敛' : '未收敛'}。缺失组按条件分布中性处理`);
    const g1 = el('div', 'grid k3');
    const diag1 = v1.weightDiag;
    const wdCards = [
      ['有效样本量 Neff', fmtNum(diag1.neff, 0), `名义 ${diag1.n}，利用率 ${fmtPct(diag1.neffRatio, 1)}`],
      ['权重 CV / 设计效应', fmtNum(diag1.cv, 2), `Deff=${diag1.deff}，变异越大代价越高`],
      ['极端权重（IQR 离群）', `${diag1.nOutliers} 单`, `占 ${fmtPct(diag1.outlierRate, 1)}，最大/中位=${diag1.maxToMedian}×`],
    ];
    wdCards.forEach(([l, v, m], i) => {
      const c = el('div', 'card stat');
      c.appendChild(el('span', 'label', l));
      c.appendChild(el('span', 'value', v));
      c.appendChild(el('span', 'meta', m));
      if (i === 2) c.appendChild(el('span', 'badge warning', '建议截断'));
      g1.appendChild(c);
    });
    s1.appendChild(g1);
    const hc = card('V1 权重分布直方图（红色尾柱为超过 P99 的极端权重）', `P50=${fmtNum(diag1.p50, 2)}，P99=${fmtNum(diag1.p99, 2)}，最大=${fmtNum(diag1.max, 2)}；零权重 ${diag1.zeroWeights} 单`);
    const tvh = tableToggle(hc, tbl => makeTable(tbl,
      [{ label: '诊断项' }, { label: '数值', numeric: true }],
      [['最小 / 最大', `${fmtNum(diag1.min, 2)} / ${fmtNum(diag1.max, 2)}`],
      ['P1 / P50 / P99', `${fmtNum(diag1.p1, 2)} / ${fmtNum(diag1.p50, 2)} / ${fmtNum(diag1.p99, 2)}`],
      ['IQR 离群数', String(diag1.nOutliers)], ['Neff', fmtNum(diag1.neff, 1)], ['Deff', String(diag1.deff)]].map(r => [r[0], r[1]])));
    weightHistogram(tvh, DATA.rows.v1.map(r => r.w_weight));
    s1.appendChild(hc);
    // 校准前后边际
    const beforeCat = DATA.bias.categorical.find(d => d.dim === state.dim);
    const afterCat = DATA.postBias.V1.categorical.find(d => d.dim === state.dim);
    const cc = card(`${dimLabel(state.dim)}：IPF 校准后边际对齐情况（最大 |SMD| 从 ${fmtNum(beforeCat.maxAbsSmd, 3)} 降到 ${fmtNum(afterCat.maxAbsSmd, 3)}）`);
    const tvc = tableToggle(cc, tbl => makeTable(tbl,
      [{ label: '类别' }, { label: '总体', numeric: true }, { label: '校准前样本', numeric: true }, { label: '校准后加权', numeric: true }],
      afterCat.rows.map(r => {
        const b = beforeCat.rows.find(x => x.key === r.key);
        return [r.key, fmtPct(r.popP, 2), b ? fmtPct(b.sampleP, 2) : '—', fmtPct(r.sampleP, 2)];
      })));
    groupedBar(tvc, afterCat.rows, {
      series: [
        { key: 'popP', label: '总体占比', color: C.pop },
        { key: 'sampleP', label: 'V1 加权占比', color: C.corrected },
      ],
    });
    s1.appendChild(cc);

    // ---- V2 分层 ----
    const v2 = DATA.corrections.V2;
    const s2 = section('V2 · 分层修正（事后分层 Post-stratification）',
      `分层维度 ${v2.strata.join(' × ')}，薄层阈值 n<${v2.minCell}；空层显式标记并回退边缘层，绝不静默丢弃`);
    const call2 = el('div', 'callout critical');
    const b2 = el('div');
    b2.appendChild(el('strong', null, `空层 ${v2.emptyStrata.length} 个 · 薄层折叠 ${v2.foldedStrata.length} 个 · 共 ${v2.cells.length} 层`));
    const ul2 = el('ul');
    v2.warnings.forEach(w => ul2.appendChild(el('li', null, w)));
    v2.thinStrata.slice(0, 4).forEach(t => {
      const li = el('li');
      li.textContent = `薄层 ${t.stratum}：样本仅 ${t.nSample} 单 / 总体 ${t.nPop.toLocaleString()} 单，已折叠到地区边缘权重`;
      ul2.appendChild(li);
    });
    b2.appendChild(ul2);
    call2.append(el('span', 'icon', '🧱'), b2);
    s2.appendChild(call2);
    const c2lim = card('V2 的方案局限与薄层策略敏感性（重要）', '分层只覆盖地区×渠道两维，未进入分层的客群、周末、金额偏差不会被自动纠正；且薄层如何处理会实质改变结果');
    const foldSmd = DATA.postBias.V2.categorical.map(d => ({ dim: d.dim, smd: d.maxAbsSmd }));
    const shrinkSmd = DATA.postBias.V2s.categorical.map(d => ({ dim: d.dim, smd: d.maxAbsSmd }));
    const limUl = el('ul');
    [
      '边缘折叠（默认 V2）：薄层回退地区边缘权重，稀有渠道被过度放大——本数据中渠道 |SMD| 从修正前 0.54 反而升至 ' + fmtNum(foldSmd.find(d => d.dim === 'channel').smd, 2),
      '薄层收缩（V2s 敏感性）：n<' + v2.minCell + ' 的层保持中性权重 1，渠道 |SMD| 降到 ' + fmtNum(shrinkSmd.find(d => d.dim === 'channel').smd, 2) + '，但地区校正力度相应减弱',
      '两个版本并列保留（独立权重列 w_strata / w_strata_shrink），由分析者按可识别性与稳健性权衡，看板不替读者选边',
    ].forEach(x => limUl.appendChild(el('li', null, x)));
    c2lim.appendChild(limUl);
    tableToggle(c2lim, tbl => makeTable(tbl,
      [{ label: '维度' }, { label: '修正前 V0 |SMD|', numeric: true },
      { label: 'V2 边缘折叠', numeric: true }, { label: 'V2s 薄层收缩', numeric: true }],
      foldSmd.map(f => {
        const v0 = DATA.bias.categorical.find(d => d.dim === f.dim).maxAbsSmd;
        const vs = shrinkSmd.find(d => d.dim === f.dim).smd;
        return [dimLabel(f.dim), fmtNum(v0, 3), fmtNum(f.smd, 3), fmtNum(vs, 3)];
      })));
    s2.appendChild(c2lim);
    const v2cellCard = card('V2 分层权重表（空层/薄层置顶，含状态与回退标记）');
    tableToggle(v2cellCard, tbl => makeTable(tbl,
      [{ label: '层' }, { label: '总体量', numeric: true }, { label: '样本量', numeric: true },
      { label: '目标占比', numeric: true }, { label: '单位权重', numeric: true }, { label: '状态' }],
      v2.cells.map(c => [c.stratum, c.nPop.toLocaleString(), c.nSample, fmtPct(c.target, 2),
        fmtNum(c.unitWeight, 2),
        c.status === 'empty' ? { text: '空层·边缘回退', color: C.critical }
          : c.status === 'thin-folded' ? { text: '薄层·折叠', color: C.warning }
            : { text: '正常', color: C.corrected }])));
    s2.appendChild(v2cellCard);

    // ---- V3 缺失与回补 ----
    const v3 = DATA.corrections.V3;
    const s3 = section('V3 · 缺失处理与定向回补',
      `满意度 MNAR 缺失：M=${v3.imputation.M} 次多重插补 + Rubin 合并；定向回补 ${v3.supplementN} 单低覆盖格子记录并重校准`);
    const g3 = el('div', 'grid k3');
    const mnar = v3.missing.mnarEvidence;
    const mc = [
      ['MNAR 证据：缺失组真实满意度', fmtNum(mnar.missingGroupTrueMean, 2), `观测组 ${fmtNum(mnar.observedGroupTrueMean, 2)}，gap=${fmtNum(mnar.gap, 2)}，p=${fmtNum(mnar.p, 4)}`, 'critical'],
      ['Rubin 合并插补均值', fmtNum(v3.imputation.miMean, 3), `SE=${fmtNum(v3.imputation.miSe, 3)}，组间方差=${fmtNum(v3.imputation.betweenImpVar, 5)}`, 'good'],
      ['回补规模与命中', `${v3.supplementN} 单`, '西北/东北/西南 × 电话/网页 × 工作日，零满意度缺失', 'neutral'],
    ];
    mc.forEach(([l, v, m, tone]) => {
      const c = el('div', 'card stat');
      c.appendChild(el('span', 'label', l));
      c.appendChild(el('span', 'value', v));
      c.appendChild(el('span', 'meta', m));
      c.appendChild(el('span', 'badge ' + tone, tone === 'critical' ? '缺失非随机' : tone === 'good' ? '插补完成' : '定向回补'));
      g3.appendChild(c);
    });
    s3.appendChild(g3);

    // 缺失率按渠道
    const missCard = card('满意度缺失率按渠道（MAR/MNAR 机制证据）');
    const chRows = Object.entries(v3.missing.byChannel).map(([k, v]) => ({ key: k, rate: v.rate, n: v.n, missing: v.missing }));
    const tvm = tableToggle(missCard, tbl => makeTable(tbl,
      [{ label: '渠道' }, { label: '样本量', numeric: true }, { label: '缺失数', numeric: true }, { label: '缺失率', numeric: true }],
      chRows.map(r => [r.key, r.n, r.missing, fmtPct(r.rate, 2)])));
    (function missBar() {
      const wsvg = UI.svg('svg', { class: 'chart', viewBox: '0 0 640 180', role: 'img' });
      const maxR = Math.max(...chRows.map(r => r.rate));
      chRows.forEach((r, i) => {
        const y = 20 + i * 36;
        const t = UI.svg('text', { x: 0, y: y + 18, class: 'axis-text' }); t.textContent = r.key;
        const w = (r.rate / maxR) * 420;
        const col = r.rate >= 0.15 ? C.critical : r.rate >= 0.08 ? C.warning : C.corrected;
        const rect = UI.svg('rect', { x: 80, y: y + 4, width: Math.max(w, 2), height: 22, rx: 4, fill: col });
        rect.addEventListener('mousemove', e => UI.showTip(e, r.key, [
          { color: col, label: '缺失率', value: fmtPct(r.rate, 2) },
          { label: '缺失/总量', value: `${r.missing}/${r.n}` },
        ]));
        rect.addEventListener('mouseleave', UI.hideTip);
        wsvg.appendChild(rect);
        const vt = UI.svg('text', { x: 80 + w + 7, y: y + 20, class: 'axis-text' });
        vt.textContent = fmtPct(r.rate, 1);
        wsvg.appendChild(vt);
      });
      tvm.appendChild(wsvg);
    })();
    s3.appendChild(missCard);

    const impCard = card('多重插补的 5 次实现与完整案例对照（插补值只写入 satisfaction_imp 新列）');
    const completeCaseMean = SBD.mean(DATA.rows.v3combined
      .filter(r => r.isSupplement === 0 && r.satisfaction != null)
      .map(r => r.satisfaction));
    tableToggle(impCard, tbl => makeTable(tbl,
      [{ label: '插补实现' }, { label: '满意度均值', numeric: true }],
      v3.imputation.impMeans.map((v, i) => [`第 ${i + 1} 次`, fmtNum(v, 4)])
        .concat([['Rubin 合并', fmtNum(v3.imputation.miMean, 4)],
        ['完整案例（listwise）', fmtNum(completeCaseMean, 4)],
        ['全局回退单元数', String(v3.imputation.fallbackGlobal)]])));
    s3.appendChild(impCard);
  }

  // ================================================================
  // 板块 4：跨版本比较 + 敏感性
  // ================================================================
  function renderComparison() {
    const sec = section('④ 比较结果与敏感性', '同一估计量在 8 个版本下的取值、标准误与相对总体真值的偏差；任何版本都不替换 V0');
    const estRow = DATA.estimandTable.find(t => t.key === state.estimand);
    const verMeta = [
      ['V0', '原样本', C.sample], ['V1', '加权·IPF', C.corrected], ['V1t', '加权·截断', C.sens],
      ['V2', '分层·边缘折叠', C.pop], ['V2s', '分层·薄层收缩', C.sens], ['V3cc', '回补·完整案例', C.supp],
      ['V3mi', '回补·多重插补', C.corrected], ['V3ns', '回补剔除敏感性', C.warning], ['POP', '总体真值', C.ink2],
    ];
    const truth = estRow.versions.POP.value;

    // 偏差条形（相对真值）
    const bc = card(`「${estRow.label}」各版本估计与总体真值（${estimandFmt(estRow, truth)}）对照`);
    const tvb = tableToggle(bc, tbl => makeTable(tbl,
      [{ label: '版本' }, { label: '估计值', numeric: true }, { label: '标准误', numeric: true },
      { label: '偏差', numeric: true }, { label: '相对偏差', numeric: true }, { label: '有效 n', numeric: true }],
      verMeta.map(([id]) => {
        const e = estRow.versions[id];
        return [id, estimandFmt(estRow, e.value), e.se == null ? '—' : fmtNum(e.se, 4),
          e.bias == null ? '—' : fmtSigned(e.bias, 3), e.relBias == null ? '—' : fmtSigned(e.relBias * 100, 2) + '%',
          String(e.n)];
      })));
    (function estBar() {
      const rows = verMeta.filter(([id]) => id !== 'POP').map(([id, label, color]) => ({ id, label, color, e: estRow.versions[id] }));
      const maxAbsBias = Math.max(...rows.map(r => Math.abs(r.e.bias || 0)), 0.001);
      const h = rows.length * 34 + 30;
      const wsvg = UI.svg('svg', { class: 'chart', viewBox: `0 0 640 ${h}`, role: 'img' });
      const x0 = 150, half = 420;
      const xFor = b => x0 + (b / maxAbsBias) * half / 2;
      wsvg.appendChild(UI.svg('line', { x1: x0, y1: 12, x2: x0, y2: h - 14, class: 'axis-line' }));
      rows.forEach((r, i) => {
        const y = 16 + i * 34;
        const t = UI.svg('text', { x: 0, y: y + 17, class: 'axis-text' }); t.textContent = `${r.id} ${r.label}`;
        const b = r.e.bias || 0;
        const bx = b >= 0 ? x0 : xFor(b), bw = Math.abs(xFor(b) - x0);
        const rect = UI.svg('rect', { x: bx, y: y + 4, width: Math.max(bw, 1.5), height: 20, rx: 4, fill: r.color, opacity: 0.9 });
        rect.addEventListener('mousemove', e => UI.showTip(e, `${r.id} ${r.label}`, [
          { color: r.color, label: '估计值', value: estimandFmt(estRow, r.e.value) },
          { label: '偏差', value: fmtSigned(r.e.bias, 3) },
          { label: '相对偏差', value: fmtSigned(r.e.relBias * 100, 2) + '%' },
        ]));
        rect.addEventListener('mouseleave', UI.hideTip);
        wsvg.appendChild(rect);
        const vt = UI.svg('text', { x: (b >= 0 ? bx + bw : bx) + (b >= 0 ? 6 : -6), y: y + 18, 'text-anchor': b >= 0 ? 'start' : 'end', class: 'axis-text' });
        vt.textContent = estimandFmt(estRow, r.e.value);
        wsvg.appendChild(vt);
      });
      const zt = UI.svg('text', { x: x0, y: h - 2, 'text-anchor': 'middle', class: 'axis-text' });
      zt.textContent = '← 低估        0 = 总体真值        高估 →';
      wsvg.appendChild(zt);
      tvb.appendChild(wsvg);
    })();
    sec.appendChild(bc);

    // 全估计量 × 全版本矩阵
    const mc = card('估计量 × 版本 完整矩阵（单元格为估计值，括号为相对偏差%）');
    tableToggle(mc, tbl => {
      const headers = [{ label: '估计量 \\ 版本' }, ...verMeta.map(([id, label]) => ({ label: id + ' ' + label, numeric: true }))];
      makeTable(tbl, headers, DATA.estimandTable.map(t =>
        [t.label, ...verMeta.map(([id]) => {
          const e = t.versions[id];
          return estimandFmt(t, e.value) + (id !== 'POP' && e.relBias != null ? ` (${fmtSigned(e.relBias * 100, 1)}%)` : '');
        })]));
    });
    sec.appendChild(mc);

    // 权重截断敏感性
    const tc = card('敏感性分析①：V1 权重截断水平扫描（越激进截断，Neff 越高但偏差可能回升）');
    const ts = DATA.trimSensitivity;
    const tsv = tableToggle(tc, tbl => makeTable(tbl,
      [{ label: '截断方案' }, { label: '上限', numeric: true }, { label: '截断单数', numeric: true },
      { label: 'Neff', numeric: true }, { label: 'Neff 利用率', numeric: true },
      { label: '履约时长均值', numeric: true }, { label: '准时率', numeric: true }],
      ts.map(t => [t.tag, t.hi == null ? '∞' : fmtNum(t.hi, 2), String(t.nTrimmed),
        fmtNum(t.neff, 0), fmtPct(t.neffRatio, 1),
        fmtNum(t.estimands.duration_mean.value, 2), fmtPct(t.estimands.ontime_rate.value, 2)])));
    lineChart(tsv, [
      { label: 'Neff（右趋势，越大越稳）', color: C.corrected, values: ts.map(t => t.neff) },
      { label: '履约时长估计（分钟）', color: C.sample, values: ts.map(t => t.estimands.duration_mean.value) },
    ], {
      xLabels: ts.map(t => t.tag), tickFmt: v => fmtNum(v, 0),
      tipFmt: v => fmtNum(v, 2), height: 280,
    });
    sec.appendChild(tc);

    // 回补敏感性
    const sc = card('敏感性分析②：回补数据的贡献（并入 vs 整组剔除）', 'V3ns 为剔除全部回补记录后的同一估计流程，差异即回补的边际贡献');
    tableToggle(sc, tbl => makeTable(tbl,
      [{ label: '估计量' }, { label: '含回补 V3mi' }, { label: '剔除回补 V3ns' }, { label: '回补贡献（差值）' }, { label: '总体真值' }],
      DATA.estimandTable.map(t => {
        const a = t.versions.V3mi, b = t.versions.V3ns, p = t.versions.POP;
        return [t.label, estimandFmt(t, a.value), estimandFmt(t, b.value),
          fmtSigned(a.value - b.value, 3), estimandFmt(t, p.value)];
      })));
    sec.appendChild(sc);
  }

  // ================================================================
  // 板块 5：异常验证（测试结果摘要，对应 tests/edge-cases.js）
  // ================================================================
  function renderValidation() {
    const sec = section('⑤ 异常与边界验证', '三类危险输入的处理证据；完整自动化断言见 tests/edge-cases.js（40 项）');
    const grid = el('div', 'grid k3');
    const v2 = DATA.corrections.V2, v1 = DATA.corrections.V1, v3 = DATA.corrections.V3;
    const blocks = [
      {
        title: '空分层验证', icon: '🧱', tone: 'critical',
        lines: [
          `联合层共 ${v2.cells.length} 个，检出空层 ${v2.emptyStrata.length} 个：${v2.emptyStrata.join('、') || '无'}`,
          `薄层（n<${v2.minCell}）${v2.thinStrata.length} 个，全部折叠并保留状态标记`,
          '空层不静默：输出告警 + 回退地区边缘权重 + 标注"不可识别"',
          '边界用例：空样本覆盖率=0、单条样本不崩（测试覆盖）',
        ],
      },
      {
        title: '权重异常验证', icon: '⚖️', tone: 'warning',
        lines: [
          `IQR 离群权重 ${v1.weightDiag.nOutliers} 单（${fmtPct(v1.weightDiag.outlierRate, 1)}），最大/中位=${v1.weightDiag.maxToMedian}×`,
          `Neff=${fmtNum(v1.weightDiag.neff, 0)}（利用率 ${fmtPct(v1.weightDiag.neffRatio, 1)}），Deff=${v1.weightDiag.deff}`,
          '零权重、NaN、负权重被显式排除并计数；截断保留 _raw 原值列不覆盖',
          '截断敏感性：不截断 / P99 / P95 / P90 / 2×中位数 五档独立快照',
        ],
      },
      {
        title: '回补数据验证', icon: '🧩', tone: 'good',
        lines: [
          `${v3.supplementN} 单回补全部 isSupplement 标记，与原样本 popIndex 零重叠`,
          '定向命中：西北/东北/西南 × 电话/网页 × 工作日，满意度零缺失',
          `MNAR 检验 p=${fmtNum(v3.missing.mnarEvidence.p, 4)}：缺失组真实满意度显著更低`,
          '插补值仅写入 satisfaction_imp，原列保留 null；空回补/全缺失边界均有测试',
        ],
      },
    ];
    for (const b of blocks) {
      const c = el('div', 'card');
      const head = el('h3', null, `${b.icon} ${b.title}`);
      c.appendChild(head);
      c.appendChild(el('span', 'badge ' + b.tone, b.tone === 'critical' ? '已检出并防护' : b.tone === 'warning' ? '已量化并隔离' : '已验证'));
      const ul = el('ul');
      ul.style.marginTop = '10px';
      b.lines.forEach(x => ul.appendChild(el('li', null, x)));
      c.appendChild(ul);
      grid.appendChild(c);
    }
    sec.appendChild(grid);

    const call = el('div', 'callout info');
    const bd = el('div');
    bd.appendChild(el('strong', null, '不覆盖铁律的运行时证据'));
    const ul = el('ul');
    [
      'V0 原样本数组在三个修正全部运行后逐字段不变（测试做 JSON 快照比对）',
      `V1 新列 w_weight / w_weight_trim，V2 新列 w_strata，V3 新列 w_comb 与 satisfaction_imp，互不串列`,
      '所有截断/插补/回补均产生新数组或新列，原始字段始终可回溯',
    ].forEach(x => ul.appendChild(el('li', null, x)));
    bd.appendChild(ul);
    call.append(el('span', 'icon', '🔒'), bd);
    sec.appendChild(call);
  }

  // ---------- 标签 ----------
  function dimLabel(d) { return { region: '地区', channel: '渠道', segment: '客群分层', isWeekend: '周末/工作日' }[d] || d; }
  function numLabel(d) { return { amount: '订单金额', duration: '履约时长', hour: '下单小时', items: '商品件数' }[d] || d; }

  // ---------- 全量渲染 ----------
  function renderAll() {
    app.innerHTML = '';
    renderKpis();
    renderCoverage();
    renderBias();
    renderCorrections();
    renderComparison();
    renderValidation();
  }

  // ---------- 过滤器 ----------
  document.getElementById('dimSelect').addEventListener('change', e => { state.dim = e.target.value; renderAll(); });
  document.getElementById('numSelect').addEventListener('change', e => { state.numDim = e.target.value; renderAll(); });
  document.getElementById('estimandSelect').addEventListener('change', e => { state.estimand = e.target.value; renderAll(); });

  // ---------- 主题切换 ----------
  const themeBtn = document.getElementById('themeToggle');
  themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.getAttribute('data-theme') !== 'dark';
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    themeBtn.setAttribute('aria-pressed', String(dark));
  });

  renderAll();
})();
