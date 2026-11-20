// 分析编排：运行完整诊断 + 三个修正版本 + 估计量跨版本比较 + 敏感性
// 输出纯 JSON 结构，Node 落盘或浏览器直接消费
(function (root, factory) {
  const lib = factory(
    typeof require === 'function' ? require('./lib/util.js') : root.SBD,
    typeof require === 'function' ? require('./lib/diagnostics.js') : root.SBD,
    typeof require === 'function' ? require('./lib/corrections.js') : root.SBD
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (typeof window !== 'undefined') window.SBD = Object.assign(window.SBD || {}, lib);
})(typeof self !== 'undefined' ? self : this, function (U, D, C) {
  'use strict';

  const CAT_DIMS = ['region', 'channel', 'segment', 'isWeekend'];
  const NUM_DIMS = ['amount', 'duration', 'hour', 'items'];
  const STRATA = ['region', 'channel'];
  const IPF_DIMS = ['region', 'channel', 'segment', 'isWeekend'];

  // 四个核心估计量（业务 KPI）
  const ESTIMANDS = [
    { key: 'duration_mean', label: '平均履约时长（分钟）', field: 'duration', stat: 'mean', lowerBetter: true },
    { key: 'ontime_rate', label: '准时率（≤45 分钟）', field: 'onTime', stat: 'mean', fmt: 'pct' },
    { key: 'amount_median', label: '订单金额中位数（元）', field: 'amount', stat: 'median', fmt: 'money' },
    { key: 'sat_mean', label: '平均满意度（1–5）', field: 'satisfaction', stat: 'mean', allowImputed: true },
  ];

  function estimate(rows, weightKey, est, opts = {}) {
    let data = rows;
    if (est.field === 'satisfaction') {
      if (opts.useImputed) {
        data = rows.map(r => ({ ...r, satisfaction: r.satisfaction != null ? r.satisfaction : r.satisfaction_imp }));
      } else {
        data = rows.filter(r => r.satisfaction != null);
      }
    }
    const pairs = data
      .map(r => ({ v: r[est.field], w: weightKey ? (r[weightKey] ?? 1) : 1 }))
      .filter(d => d.v != null && !Number.isNaN(d.v));
    if (!pairs.length) return { value: null, n: 0 };
    let value;
    if (est.stat === 'mean') {
      value = weightKey
        ? U.weightedMean(pairs.map(d => d.v), pairs.map(d => d.w))
        : U.mean(pairs.map(d => d.v));
    } else {
      value = weightKey
        ? U.weightedQuantile(pairs, 0.5)
        : U.median(pairs.map(d => d.v));
    }
    // 加权均值的标准误（夹心近似，用设计效应缩放）
    let se = null;
    if (est.stat === 'mean' && pairs.length > 1) {
      const m = value;
      const w = pairs.map(d => d.w), v = pairs.map(d => d.v);
      const sw = w.reduce((a, b) => a + b, 0);
      const sw2 = w.reduce((a, b) => a + b * b, 0);
      const varw = U.weightedVariance(v, w, m);
      const neff = sw2 > 0 ? (sw * sw) / sw2 : pairs.length;
      se = Math.sqrt(varw / Math.max(1, neff));
    }
    return { value: U.round(value, 3), se: se == null ? null : U.round(se, 4), n: pairs.length };
  }

  function run(dataset) {
    const { population: pop, sample, sampleRaw, supplement, meta } = dataset;

    // ---------- V0 原样本（不可变基线）----------
    const v0 = {
      version: 'V0', label: '原样本（未修正）',
      rows: sample, weightKey: null, immutable: true,
    };

    // ---------- 覆盖率 ----------
    const cov = D.coverage(pop, sample, ['region', 'channel', 'segment', 'isWeekend']);
    const joint = D.jointCoverage(pop, sample, STRATA);

    // ---------- 偏差证据 ----------
    const bias = {
      categorical: CAT_DIMS.map(dim => D.categoricalBias(pop, sample, dim,
        dim === 'isWeekend' ? { order: ['false', 'true'] } : {})),
      numeric: NUM_DIMS.map(dim => D.numericBias(pop, sample, dim)),
    };

    // 时间维度单独：按周的样本/总体占比趋势
    const weeklyTrend = weeklyCoverage(pop, sample);

    // ---------- V1 加权 ----------
    const v1 = C.v1Weighting(pop, sample, IPF_DIMS);
    // ---------- V2 分层 ----------
    const v2 = C.v2Stratification(pop, sample, STRATA, { minCell: 30 });
    // ---------- V3 缺失 + 回补 ----------
    const v3 = C.v3MissingAndSupplement(pop, sample, supplement,
      { M: 5, truthRows: sampleRaw });

    // ---------- 修正后偏差证据（各版本独立计算）----------
    const postBias = {
      V1: {
        categorical: CAT_DIMS.map(dim => D.categoricalBias(pop, v1.weights, dim,
          dim === 'isWeekend' ? { order: ['false', 'true'], weightKey: 'w_weight' } : { weightKey: 'w_weight' })),
        numeric: NUM_DIMS.map(dim => D.numericBias(pop, v1.weights, dim, { weightKey: 'w_weight' })),
      },
      V1_trim: {
        categorical: CAT_DIMS.map(dim => D.categoricalBias(pop, v1.weightsTrimmed, dim,
          dim === 'isWeekend' ? { order: ['false', 'true'], weightKey: 'w_weight_trim' } : { weightKey: 'w_weight_trim' })),
      },
      V2: {
        categorical: CAT_DIMS.map(dim => D.categoricalBias(pop, v2.weights, dim,
          dim === 'isWeekend' ? { order: ['false', 'true'], weightKey: 'w_strata' } : { weightKey: 'w_strata' })),
        numeric: NUM_DIMS.map(dim => D.numericBias(pop, v2.weights, dim, { weightKey: 'w_strata' })),
      },
      V2s: {
        categorical: CAT_DIMS.map(dim => D.categoricalBias(pop, v2.weightsShrink, dim,
          dim === 'isWeekend' ? { order: ['false', 'true'], weightKey: 'w_strata_shrink' } : { weightKey: 'w_strata_shrink' })),
        numeric: NUM_DIMS.map(dim => D.numericBias(pop, v2.weightsShrink, dim, { weightKey: 'w_strata_shrink' })),
      },
      V3: {
        categorical: CAT_DIMS.map(dim => D.categoricalBias(pop, v3.combinedSample, dim,
          dim === 'isWeekend' ? { order: ['false', 'true'], weightKey: 'w_comb' } : { weightKey: 'w_comb' })),
        numeric: NUM_DIMS.map(dim => D.numericBias(pop, v3.combinedSample, dim, { weightKey: 'w_comb' })),
      },
    };

    // ---------- 估计量跨版本比较（敏感性主表）----------
    const versions = [
      { id: 'V0', label: '原样本', rows: v0.rows, weightKey: null },
      { id: 'V1', label: '加权·IPF', rows: v1.weights, weightKey: 'w_weight' },
      { id: 'V1t', label: '加权·截断', rows: v1.weightsTrimmed, weightKey: 'w_weight_trim' },
      { id: 'V2', label: '分层·边缘折叠', rows: v2.weights, weightKey: 'w_strata' },
      { id: 'V2s', label: '分层·薄层收缩', rows: v2.weightsShrink, weightKey: 'w_strata_shrink' },
      { id: 'V3cc', label: '回补·完整案例', rows: v3.combinedSample.filter(r => r.satisfaction != null), weightKey: 'w_comb' },
      { id: 'V3mi', label: '回补·多重插补', rows: v3.combinedSample.map(r => ({ ...r, satisfaction: r.satisfaction != null ? r.satisfaction : r.satisfaction_imp })), weightKey: 'w_comb' },
      { id: 'V3ns', label: '回补剔除敏感性', rows: v3.noSupplementSample, weightKey: 'w_comb' },
      { id: 'POP', label: '总体真值', rows: pop, weightKey: null },
    ];

    const estimandTable = ESTIMANDS.map(est => {
      const row = { key: est.key, label: est.label, fmt: est.fmt, lowerBetter: est.lowerBetter, versions: {} };
      for (const ver of versions) {
        const opts = { useImputed: ver.id === 'V3mi' };
        row.versions[ver.id] = estimate(ver.rows, ver.weightKey, est, opts);
      }
      // 相对总体的偏差（百分点 / 相对百分比）
      const truth = row.versions.POP.value;
      for (const ver of versions) {
        const e = row.versions[ver.id];
        if (e.value != null && truth != null) {
          e.bias = U.round(e.value - truth, 4);
          e.relBias = U.round((e.value - truth) / truth, 5);
        }
      }
      return row;
    });

    // ---------- 权重极端化敏感性（V1 不同截断水平）----------
    const trimSensitivity = trimSweep(pop, v1.weights, 'w_weight', ESTIMANDS, estimate);

    // ---------- 版本血缘（证明不覆盖）----------
    const lineage = [
      { id: 'V0', desc: '原始抽样记录，只读基线，任何修正不修改此数组', n: sample.length },
      { id: 'V1', desc: '深拷贝样本 + 新列 w_weight；截断变体另存 w_weight_trim', n: v1.weights.length },
      { id: 'V2', desc: '深拷贝样本 + 新列 w_strata + strataStatus；空层显式标记', n: v2.weights.length },
      { id: 'V3', desc: '插补值写入新列 satisfaction_imp，原 satisfaction 列保留 null；回补记录以 isSupplement 标记并入', n: v3.combinedSample.length },
    ];

    return {
      meta,
      generatedAt: dataset.meta.generatedAt,
      coverage: cov,
      jointCoverage: joint,
      bias,
      weeklyTrend,
      corrections: { V1: stripRows(v1), V2: stripRows(v2), V3: stripRows(v3) },
      postBias,
      estimandTable,
      trimSensitivity,
      lineage,
      // 行级数据供看板交互（体积可控：约 2k 行）
      rows: {
        sample,
        v1: v1.weights,
        v2: v2.weights,
        v2shrink: v2.weightsShrink,
        v3combined: v3.combinedSample,
        supplement,
      },
      populationSummary: summarizePop(pop),
    };
  }

  function stripRows(v) {
    // 摘要对象（不含大行数组的副本由 rows 区统一承载）
    const clone = { ...v };
    return clone;
  }

  function weeklyCoverage(pop, sample) {
    const out = [];
    for (let wk = 1; wk <= 12; wk++) {
      const p = pop.filter(r => r.week === wk);
      const s = sample.filter(r => r.week === wk);
      out.push({
        week: wk,
        popShare: U.round(p.length / pop.length, 5),
        sampleShare: U.round(s.length / sample.length, 5),
        popN: p.length, sampleN: s.length,
      });
    }
    return out;
  }

  function trimSweep(pop, rows, key, estimands, estimateFn) {
    const wd = D.weightDiagnostics(rows, key);
    const levels = [
      { tag: '不截断', hi: Infinity },
      { tag: 'P99', hi: wd.p99 },
      { tag: 'P95', hi: percentile(rows.map(r => r[key]), 0.95) },
      { tag: 'P90', hi: percentile(rows.map(r => r[key]), 0.90) },
      { tag: '2×中位数', hi: 2 * wd.p50 },
    ];
    return levels.map(lvl => {
      const trimmed = D.trimWeights(rows, key, lvl.hi, 0);
      const diag = D.weightDiagnostics(trimmed, key);
      const est = {};
      for (const e of estimands) {
        est[e.key] = estimateFn(trimmed, key, e, {});
      }
      return {
        tag: lvl.tag, hi: Number.isFinite(lvl.hi) ? U.round(lvl.hi, 2) : null,
        neff: diag.neff, neffRatio: diag.neffRatio, max: diag.max, cv: diag.cv,
        nTrimmed: trimmed.filter(r => r.trimmed).length,
        estimands: est,
      };
    });
  }

  function percentile(arr, p) {
    const s = arr.slice().sort((a, b) => a - b);
    return U.quantile(s, p);
  }

  function summarizePop(pop) {
    return {
      n: pop.length,
      durationMean: U.round(U.mean(pop.map(r => r.duration)), 2),
      ontimeRate: U.round(U.mean(pop.map(r => r.onTime)), 4),
      amountMedian: U.round(U.median(pop.map(r => r.amount)), 2),
      satisfactionMean: U.round(U.mean(pop.map(r => r.satisfaction)), 3),
    };
  }

  return { run, ESTIMANDS, estimate, CAT_DIMS, NUM_DIMS, STRATA };
});
