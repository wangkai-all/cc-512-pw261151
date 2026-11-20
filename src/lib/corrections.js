// 修正引擎：V1 加权（IPF 校准+截断）、V2 分层（事后分层+空层保护）、V3 缺失回补
// 铁律：每个版本都返回独立快照（深拷贝 + 独立权重列），绝不修改/覆盖原样本 V0
(function (root, factory) {
  const lib = factory(
    typeof require === 'function' ? require('./util.js') : root.SBD,
    typeof require === 'function' ? require('./diagnostics.js') : root.SBD
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (typeof window !== 'undefined') window.SBD = Object.assign(window.SBD || {}, lib);
})(typeof self !== 'undefined' ? self : this, function (U, D) {
  'use strict';

  const NA = D.NA;

  function clone(rows) { return rows.map(r => ({ ...r })); }

  function marginTargets(pop, dim) {
    const dist = U.proportions(pop, dim);
    const m = new Map();
    for (const d of dist) m.set(d.key, d.p);
    return m;
  }

  // ============================================================
  // V1 加权修正：以设计权重为初值，对 地区×渠道×客群×周末 做 IPF（raking）校准，
  // 使加权边际与总体一致；再做 1%/99% 截断的敏感性变体
  // ============================================================
  // 校准目标：总体已知值上的条件分布（缺失组不参与校准时，目标必须同口径，
  // 否则可校准子总体与总体目标的质量不一致会导致 raking 永不收敛）
  function conditionalTargets(pop, dim) {
    const known = pop.filter(r => D.keyOf(r[dim]) !== NA);
    const dist = U.proportions(known, dim);
    return new Map(dist.map(d => [d.key, d.p]));
  }

  function v1Weighting(pop, sampleRaw, dims, opts = {}) {
    const maxIter = opts.maxIter || 200;
    const tol = opts.tol || 1e-6;
    const sample = clone(sampleRaw);
    const targets = dims.map(dim => conditionalTargets(pop, dim));
    const w0 = sample.map(r => (r.designWeight != null ? r.designWeight : 1));
    let w = w0.slice();
    const trace = [];
    let converged = false;

    for (let iter = 0; iter < maxIter; iter++) {
      let maxAdj = 0;
      for (let di = 0; di < dims.length; di++) {
        const dim = dims[di], tgt = targets[di];
        // 当前加权边际——仅在该维度已知值的记录内部归一化（NA 组排除，与目标同口径）
        const cur = new Map();
        let sw = 0;
        for (let i = 0; i < sample.length; i++) {
          const k = D.keyOf(sample[i][dim]);
          if (k === NA) continue;
          cur.set(k, (cur.get(k) || 0) + w[i]);
          sw += w[i];
        }
        for (const [k, t] of tgt) {
          const have = (cur.get(k) || 0) / sw;
          const factor = have > 0 ? t / have : 1;
          if (!Number.isFinite(factor)) continue;
          maxAdj = Math.max(maxAdj, Math.abs(Math.log(factor)));
          for (let i = 0; i < sample.length; i++) {
            if (D.keyOf(sample[i][dim]) === k) w[i] *= factor;
          }
        }
      }
      // 归一化回样本量尺度（保持 Σw = n）
      const sum = w.reduce((a, b) => a + b, 0);
      w = w.map(x => (x * sample.length) / sum);
      trace.push(U.round(maxAdj, 6));
      if (maxAdj < tol) { converged = true; break; }
    }

    for (let i = 0; i < sample.length; i++) sample[i].w_weight = U.round(w[i], 4);

    // 截断敏感性变体（独立快照）
    const wd = D.weightDiagnostics(sample, 'w_weight');
    const trimmed = clone(sample).map((r, i) => {
      const tw = U.clamp(r.w_weight, wd.p1, wd.p99);
      r.w_weight_trim = U.round(tw, 4);
      return r;
    });

    return {
      version: 'V1',
      label: '加权修正（IPF 校准）',
      method: 'iterative proportional fitting / raking',
      dims,
      converged,
      iterations: trace.length,
      convergenceTrace: trace.slice(0, 12),
      weights: sample,                 // 未截断权重快照
      weightsTrimmed: trimmed,         // 截断权重快照（独立列）
      weightDiag: wd,
      trimDiag: D.weightDiagnostics(trimmed.map(r => ({ ...r, _t: r.w_weight_trim })), '_t'),
    };
  }

  // ============================================================
  // V2 分层修正：事后分层（地区×渠道 联合层），含空层/薄层保护
  // 空层不静默：显式标记、回退到边缘层、并输出未覆盖证据
  // ============================================================
  function v2Stratification(pop, sampleRaw, strata, opts = {}) {
    const minCell = opts.minCell || 30;
    const sample = clone(sampleRaw);

    // 总体各层规模与目标占比
    const popCount = new Map();
    for (const r of pop) {
      const k = D.jointStratumKey(r, strata);
      popCount.set(k, (popCount.get(k) || 0) + 1);
    }
    const N = pop.length;
    // 边缘层（地区、渠道）用于空层回退
    const regionTarget = marginTargets(pop, strata[0]);
    const channelTarget = marginTargets(pop, strata[1]);

    // 样本各层规模
    const sampCount = new Map();
    for (const r of sample) {
      const k = D.jointStratumKey(r, strata);
      sampCount.set(k, (sampCount.get(k) || 0) + 1);
    }

    const emptyStrata = [], thinStrata = [], foldedStrata = [];
    const cellInfo = new Map();
    for (const [k, nPop] of popCount) {
      const nSamp = sampCount.get(k) || 0;
      const target = nPop / N;
      // 每记录权重 = 目标占比 / 实际占比（空层不可识别，回退边缘层）
      let unitWeight, status = 'ok', fallback = null;
      if (nSamp === 0) {
        emptyStrata.push(k);
        status = 'empty';
        const [region] = k.split('|');
        fallback = 'region-margin';
        // 该层没有记录可赋权；记录边缘目标供看板展示未覆盖证据
        unitWeight = (regionTarget.get(region) || 1 / popCount.size);
      } else if (nSamp < minCell) {
        thinStrata.push({ stratum: k, nSample: nSamp, nPop });
        status = 'thin-folded';
        const [region] = k.split('|');
        fallback = 'region-margin';
        foldedStrata.push(k);
        // 薄层折叠：用地区边缘目标替代联合层目标
        const regionMargin = regionTarget.get(region) || 1 / popCount.size;
        unitWeight = regionMargin / (nSamp / sample.length);
      } else {
        unitWeight = target / (nSamp / sample.length);
      }
      cellInfo.set(k, {
        stratum: k, nPop, nSample: nSamp, target: U.round(target, 5),
        unitWeight: U.round(unitWeight, 4), status, fallback,
      });
    }

    for (const r of sample) {
      const k = D.jointStratumKey(r, strata);
      const info = cellInfo.get(k);
      if (!info) {
        // 样本落在总体不存在的层（防御性分支）
        r.w_strata = 1;
        r.strataStatus = 'unknown-cell';
        continue;
      }
      r.w_strata = U.round(info.unitWeight, 4);
      r.strataStatus = info.status;
    }
    // 归一化使 Σw = n
    const sw = sample.reduce((a, r) => a + r.w_strata, 0);
    for (const r of sample) r.w_strata = U.round(r.w_strata * sample.length / sw, 4);

    // 敏感性变体：薄层不折叠到边缘（边缘折叠会过度放大稀有渠道，扭曲渠道边际），
    // 改为向中性权重 1 收缩——同一快照上的独立列 w_strata_shrink，原列保留
    const shrink = clone(sample);
    for (const r of shrink) {
      r.w_strata_shrink = (r.strataStatus === 'thin-folded' || r.strataStatus === 'unknown-cell')
        ? 1 : r.w_strata;
    }
    const sw2 = shrink.reduce((a, r) => a + r.w_strata_shrink, 0);
    for (const r of shrink) r.w_strata_shrink = U.round(r.w_strata_shrink * shrink.length / sw2, 4);

    return {
      version: 'V2',
      label: '分层修正（事后分层）',
      method: 'post-stratification on ' + strata.join(' × '),
      strata,
      minCell,
      nCells: cellInfo.size,
      emptyStrata,
      thinStrata,
      foldedStrata,
      cells: Array.from(cellInfo.values()).sort((a, b) => a.nSample - b.nSample),
      weights: sample,
      weightsShrink: shrink, // 薄层收缩敏感性快照（独立列）
      weightDiag: D.weightDiagnostics(sample, 'w_strata'),
      weightDiagShrink: D.weightDiagnostics(shrink, 'w_strata_shrink'),
      warnings: emptyStrata.map(k => `空层 ${k}：样本零命中，已回退到地区边缘权重，该层估计不可识别`),
    };
  }

  // ============================================================
  // V3 缺失处理 + 回补：
  //  3a 缺失诊断与多重插补（满意度，按渠道×地区单元均值+噪声，M=5 取合并）
  //  3b 回补记录并入（校准权重重算），回补数据独立标记、可整组剔除做敏感性
  // ============================================================
  function v3MissingAndSupplement(pop, sampleRaw, supplement, opts = {}) {
    const M = opts.M || 5;
    const seed = opts.seed || 7;
    const rng = U.mulberry32(seed);
    const sample = clone(sampleRaw);
    const truthRows = opts.truthRows || null; // 生成器保留的缺失前真值（仅用于 MNAR 验证）

    // ---- 3a 缺失诊断 ----
    const miss = missingDiagnostics(sample, truthRows);

    // 插补单元：channel × region（缺失地区归入 __NA__ 单元）
    const cellValues = new Map();
    for (const r of sample) {
      if (r.satisfaction == null) continue;
      const k = D.keyOf(r.channel) + '|' + D.keyOf(r.region);
      if (!cellValues.has(k)) cellValues.set(k, []);
      cellValues.get(k).push(r.satisfaction);
    }
    const cellStat = new Map();
    for (const [k, vals] of cellValues) {
      const m = U.mean(vals);
      cellStat.set(k, { mean: m, sd: Math.sqrt(U.variance(vals, m)), n: vals.length });
    }
    const globalMean = U.mean(sample.filter(r => r.satisfaction != null).map(r => r.satisfaction));

    // M 次插补 → 每次的均值，最后按 Rubin 规则合并
    const impMeans = [], impVars = [];
    const imputedRows = clone(sample);
    const imputeTrace = [];
    for (let mIdx = 0; mIdx < M; mIdx++) {
      const vals = [];
      for (const r of imputedRows) {
        if (r.satisfaction != null) { vals.push(r.satisfaction); continue; }
        const k = D.keyOf(r.channel) + '|' + D.keyOf(r.region);
        let st = cellStat.get(k);
        let fb = null;
        if (!st || st.n < 5) { st = { mean: globalMean, sd: 0.8 }; fb = 'global'; }
        let iv = st.mean + (st.sd || 0.8) * U.randn(rng);
        iv = U.clamp(Math.round(iv * 2) / 2, 1, 5);
        vals.push(iv);
        if (mIdx === 0) { r.satisfaction_imp = iv; r.imputeFallback = fb; }
      }
      impMeans.push(U.mean(vals));
      impVars.push(U.variance(vals, impMeans[mIdx]) / vals.length);
    }
    // Rubin 规则
    const miMean = U.mean(impMeans);
    const within = U.mean(impVars);
    const between = U.variance(impMeans, miMean);
    const miVar = within + (1 + 1 / M) * between;

    // 完整案例（listwise）对照——独立快照，不删除原行
    const completeCase = sample.filter(r => r.satisfaction != null).map(r => ({ ...r }));

    // ---- 3b 回补数据并入 ----
    const supp = clone(supplement);
    for (const r of supp) { r.isSupplement = 1; }
    const combined = clone(sample).map(r => ({ ...r, isSupplement: 0 })).concat(supp);

    // 回补并入后重做事后分层校准（地区×渠道），让回补格子的边际对齐总体
    const calibrated = recalibrateCombined(pop, combined, ['region', 'channel']);

    // 敏感性：剔除回补、仅校准样本
    const noSupp = calibrated.filter(r => !r.isSupplement);

    return {
      version: 'V3',
      label: '缺失处理与回补',
      method: `multiple imputation (M=${M}, Rubin) + targeted supplement with recalibration`,
      missing: miss,
      imputation: {
        M,
        miMean: U.round(miMean, 4),
        miSe: U.round(Math.sqrt(miVar), 4),
        betweenImpVar: U.round(between, 6),
        impMeans: impMeans.map(v => U.round(v, 4)),
        nImputed: sample.filter(r => r.satisfaction == null).length,
        fallbackGlobal: imputedRows.filter(r => r.imputeFallback === 'global').length,
      },
      imputedSample: imputedRows,        // 含 satisfaction_imp，原值列保留（null）
      completeCase,                      // 完整案例对照快照
      combinedSample: calibrated,        // 样本+回补，重校准权重 w_comb
      noSupplementSample: noSupp,        // 剔除回补的敏感性快照
      supplementN: supp.length,
      weightDiagCombined: D.weightDiagnostics(calibrated, 'w_comb'),
    };
  }

  function missingDiagnostics(sample, truthRows) {
    const dims = ['satisfaction', 'region'];
    const out = {};
    for (const dim of dims) {
      const nMiss = sample.filter(r => r[dim] == null).length;
      out[dim] = {
        nMissing: nMiss,
        missingRate: U.round(nMiss / sample.length, 4),
      };
    }
    // 满意度缺失与渠道的关联（MAR 证据）
    const byChannel = {};
    for (const ch of ['App', '小程序', '网页', '电话']) {
      const sub = sample.filter(r => r.channel === ch);
      const miss = sub.filter(r => r.satisfaction == null).length;
      byChannel[ch] = { n: sub.length, missing: miss, rate: sub.length ? U.round(miss / sub.length, 4) : 0 };
    }
    // MNAR 证据：用生成器保留的缺失前真值，比较"缺失组 vs 观测组"的真实满意度
    let mnarEvidence = null;
    if (truthRows && truthRows.length === sample.length) {
      const missTrue = [], obsTrue = [];
      for (let i = 0; i < sample.length; i++) {
        if (sample[i].satisfaction == null) missTrue.push(truthRows[i].satisfaction);
        else obsTrue.push(truthRows[i].satisfaction);
      }
      if (missTrue.length && obsTrue.length) {
        const m1 = U.mean(missTrue), m0 = U.mean(obsTrue);
        const v1 = U.variance(missTrue, m1), v0 = U.variance(obsTrue, m0);
        const se = Math.sqrt(v1 / missTrue.length + v0 / obsTrue.length);
        const z = se > 0 ? (m1 - m0) / se : 0;
        mnarEvidence = {
          missingGroupTrueMean: U.round(m1, 3),
          observedGroupTrueMean: U.round(m0, 3),
          gap: U.round(m1 - m0, 3),
          z: U.round(z, 3),
          p: U.round(U.twoTailedP(z), 5),
          nMissing: missTrue.length,
        };
      }
    }
    return { ...out, byChannel, mnarEvidence };
  }

  // 对合并样本做 IPF 校准（两维），输出 w_comb
  function recalibrateCombined(pop, rows, dims) {
    const out = clone(rows);
    const targets = dims.map(d => conditionalTargets(pop, d));
    let w = out.map(() => 1);
    for (let iter = 0; iter < 200; iter++) {
      let maxAdj = 0;
      for (let di = 0; di < dims.length; di++) {
        const dim = dims[di], tgt = targets[di];
        const cur = new Map();
        let sw = 0;
        for (let i = 0; i < out.length; i++) {
          const k = D.keyOf(out[i][dim]);
          if (k === NA) continue; // 与条件目标同口径：NA 不计入归一化
          cur.set(k, (cur.get(k) || 0) + w[i]);
          sw += w[i];
        }
        for (const [k, t] of tgt) {
          const have = (cur.get(k) || 0) / sw;
          if (have <= 0) continue;
          const f = t / have;
          maxAdj = Math.max(maxAdj, Math.abs(Math.log(f)));
          for (let i = 0; i < out.length; i++) {
            if (D.keyOf(out[i][dim]) === k) w[i] *= f;
          }
        }
      }
      const sum = w.reduce((a, b) => a + b, 0);
      w = w.map(x => x * out.length / sum);
      if (maxAdj < 1e-5) break;
    }
    for (let i = 0; i < out.length; i++) out[i].w_comb = U.round(w[i], 4);
    return out;
  }

  return { v1Weighting, v2Stratification, v3MissingAndSupplement, clone };
});
