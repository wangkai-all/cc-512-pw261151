// 偏差诊断引擎：覆盖率 + 偏差证据（分类 SMD/卡方，连续 SMD/K-S）+ 权重诊断
(function (root, factory) {
  const lib = factory(
    typeof require === 'function' ? require('./util.js') : root.SBD
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (typeof window !== 'undefined') window.SBD = Object.assign(window.SBD || {}, lib);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  const NA = '__NA__';

  // ---------- 覆盖率 ----------
  // 每个维度：总体格子、样本命中、覆盖率 = 命中格子/总格子；以及加权前后样本占比对照
  function coverage(pop, sample, dims) {
    const out = {};
    for (const dim of dims) {
      const popKeys = new Set(pop.map(r => keyOf(r[dim])).filter(k => k !== NA));
      const sampKeys = new Set(sample.map(r => keyOf(r[dim])).filter(k => k !== NA));
      const cells = Array.from(popKeys).sort().map(k => ({
        cell: k,
        inPopulation: true,
        inSample: sampKeys.has(k),
        sampleN: sample.filter(r => keyOf(r[dim]) === k).length,
      }));
      const missingCells = cells.filter(c => !c.inSample).map(c => c.cell);
      out[dim] = {
        populationCells: popKeys.size,
        coveredCells: cells.filter(c => c.inSample).length,
        cellCoverage: popKeys.size ? cells.filter(c => c.inSample).length / popKeys.size : 0,
        missingCells,
        cells,
      };
    }
    // 联合层覆盖（用于分层修正的空层检测）
    return out;
  }

  function keyOf(v) {
    if (v === null || v === undefined) return NA;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  function jointStratumKey(row, strata) {
    return strata.map(s => keyOf(row[s])).join('|');
  }

  // 联合层覆盖率与空层
  function jointCoverage(pop, sample, strata) {
    const popMap = new Map();
    for (const r of pop) {
      const k = jointStratumKey(r, strata);
      popMap.set(k, (popMap.get(k) || 0) + 1);
    }
    const sampMap = new Map();
    for (const r of sample) {
      const k = jointStratumKey(r, strata);
      sampMap.set(k, (sampMap.get(k) || 0) + 1);
    }
    const rows = Array.from(popMap.entries()).map(([k, nPop]) => ({
      stratum: k,
      nPop,
      nSample: sampMap.get(k) || 0,
      empty: !sampMap.has(k),
    })).sort((a, b) => a.nSample - b.nSample);
    return {
      nStrata: rows.length,
      emptyStrata: rows.filter(r => r.empty),
      coverage: rows.filter(r => !r.empty).length / rows.length,
      rows,
    };
  }

  // ---------- 分类变量偏差 ----------
  function categoricalBias(pop, sample, dim, options = {}) {
    const order = options.order;
    const weightKey = options.weightKey; // 样本加权时传入
    const popDist = U.proportions(pop, dim, order);
    const sampDist = weightKey
      ? U.weightedProportions(sample, dim, weightKey, popDist.map(d => d.key))
      : U.proportions(sample, dim, popDist.map(d => d.key));

    const rows = popDist.map((p, i) => {
      const s = sampDist[i];
      const pp = p.p, sp = s.p;
      // 比例差（百分点）与相对比
      const diff = sp - pp;
      const relRatio = pp > 0 ? sp / pp : NaN;
      // 单类 SMD（双样本比例差 / 合并 SD）
      const pooled = (pp * (1 - pp) + sp * (1 - sp)) / 2;
      const smd = pooled > 0 ? diff / Math.sqrt(pooled) : 0;
      return {
        key: p.key,
        popP: pp, popN: p.n,
        sampleP: sp, sampleN: s.n != null ? s.n : null, sampleW: s.w != null ? U.round(s.w, 2) : null,
        diffPct: diff, relRatio: U.round(relRatio, 3), smd: U.round(smd, 4),
        absSmd: Math.abs(U.round(smd, 4)),
      };
    });

    // 卡方齐性检验（期望频数 >=5 的格子才计入，并报告折叠情况）
    const nS = weightKey ? sample.length : sample.length;
    let chi = 0, df = 0, folded = 0;
    for (const r of rows) {
      const expected = r.popP * nS;
      if (expected < 5 || r.popP === 0) { folded++; continue; }
      const observed = r.sampleP * nS;
      chi += (observed - expected) ** 2 / expected;
      df += 1;
    }
    df = Math.max(0, df - 1);
    const pValue = df > 0 ? U.chiSqTail(chi, df) : NaN;

    return {
      dim,
      rows,
      maxAbsSmd: Math.max(...rows.map(r => r.absSmd)),
      chiSq: U.round(chi, 3), df, pValue: U.round(pValue, 5),
      foldedCells: folded,
      hasMissing: rows.some(r => r.key === NA),
    };
  }

  // ---------- 连续变量偏差 ----------
  function numericBias(pop, sample, dim, options = {}) {
    const weightKey = options.weightKey;
    const popVals = pop.map(r => r[dim]).filter(v => v != null && !Number.isNaN(v));
    const sampPairs = sample
      .filter(r => r[dim] != null && !Number.isNaN(r[dim]))
      .map(r => ({ v: r[dim], w: weightKey ? (r[weightKey] ?? 1) : 1 }));
    const sampVals = sampPairs.map(d => d.v);

    const popMean = U.mean(popVals);
    const popVar = U.variance(popVals, popMean);
    const sampMean = weightKey
      ? U.weightedMean(sampPairs.map(d => d.v), sampPairs.map(d => d.w))
      : U.mean(sampVals);
    const sampVar = weightKey
      ? U.weightedVariance(sampPairs.map(d => d.v), sampPairs.map(d => d.w), sampMean)
      : U.variance(sampVals, sampMean);

    const pooledSd = Math.sqrt((popVar + sampVar) / 2);
    const smd = pooledSd > 0 ? (sampMean - popMean) / pooledSd : 0;

    // 两独立样本 K-S 统计量（加权样本用加权 ECDF）
    const ks = ksStat(popVals, sampPairs, weightKey);

    const popSorted = popVals.slice().sort((a, b) => a - b);
    const sampSorted = sampVals.slice().sort((a, b) => a - b);
    return {
      dim,
      popMean: U.round(popMean, 3),
      sampleMean: U.round(sampMean, 3),
      popMedian: U.round(U.median(popVals), 3),
      sampleMedian: weightKey
        ? U.round(U.weightedQuantile(sampPairs, 0.5), 3)
        : U.round(U.median(sampVals), 3),
      popQ1: U.round(U.quantile(popSorted, 0.25), 2),
      popQ3: U.round(U.quantile(popSorted, 0.75), 2),
      sampleQ1: weightKey
        ? U.round(U.weightedQuantile(sampPairs, 0.25), 2)
        : U.round(U.quantile(sampSorted, 0.25), 2),
      sampleQ3: weightKey
        ? U.round(U.weightedQuantile(sampPairs, 0.75), 2)
        : U.round(U.quantile(sampSorted, 0.75), 2),
      smd: U.round(smd, 4),
      absSmd: Math.abs(U.round(smd, 4)),
      ksD: U.round(ks.d, 4),
      ksP: U.round(ks.p, 5),
      nMissing: sample.length - sampVals.length,
      missingRate: U.round((sample.length - sampVals.length) / sample.length, 4),
    };
  }

  function ecdf(vals) {
    const s = vals.slice().sort((a, b) => a - b);
    return x => {
      let lo = 0, hi = s.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] <= x) lo = mid + 1; else hi = mid; }
      return lo / s.length;
    };
  }

  function weightedEcdf(pairs) {
    const s = pairs.slice().sort((a, b) => a.v - b.v);
    const total = s.reduce((a, b) => a + b.w, 0);
    return x => {
      let acc = 0;
      for (const d of s) { if (d.v <= x) acc += d.w; else break; }
      return acc / total;
    };
  }

  function ksStat(popVals, sampPairs, weighted) {
    const f1 = ecdf(popVals);
    const f2 = weighted ? weightedEcdf(sampPairs) : ecdf(sampPairs.map(d => d.v));
    const grid = Array.from(new Set(popVals.concat(sampPairs.map(d => d.v)))).sort((a, b) => a - b);
    let dMax = 0;
    for (const x of grid) dMax = Math.max(dMax, Math.abs(f1(x) - f2(x)));
    const n1 = popVals.length, n2 = sampPairs.length;
    // 渐近 p 值（Lilliefors 风格正态近似）
    const en = Math.sqrt(n1 * n2 / (n1 + n2));
    const lam = (en + 0.12 + 0.11 / en) * dMax;
    const p = U.clamp(2 * sumKs(lam), 0, 1); // Kolmogorov 渐近级数
    return { d: dMax, p };
  }

  function sumKs(lam) {
    let s = 0;
    for (let k = 1; k <= 100; k++) {
      s += (-1) ** (k - 1) * Math.exp(-2 * lam * lam * k * k);
    }
    return s;
  }

  // ---------- 权重诊断 ----------
  function weightDiagnostics(rows, weightKey) {
    const ws = rows
      .map(r => r[weightKey])
      .filter(w => typeof w === 'number' && Number.isFinite(w) && w >= 0);
    const n = ws.length;
    if (!ws.length) return null;
    const m = U.mean(ws);
    const v = U.variance(ws, m);
    const sd = Math.sqrt(v);
    const sorted = ws.slice().sort((a, b) => a - b);
    const q1 = U.quantile(sorted, 0.25), q3 = U.quantile(sorted, 0.75), med = U.quantile(sorted, 0.5);
    const iqr = q3 - q1;
    const upperFence = q3 + 1.5 * iqr;
    const max = sorted[sorted.length - 1], min = sorted[0];
    const outliers = ws.filter(w => w > upperFence);
    const zeros = ws.filter(w => w === 0).length;
    // 有效样本量 Kish：Neff = (Σw)² / Σw²
    const sw = ws.reduce((a, b) => a + b, 0);
    const sw2 = ws.reduce((a, b) => a + b * b, 0);
    const neff = sw2 > 0 ? (sw * sw) / sw2 : 0;
    // 设计效应
    const deff = neff > 0 ? n / neff : NaN;
    // 截断建议（1%/99% 分位）
    const p1 = U.quantile(sorted, 0.01), p99 = U.quantile(sorted, 0.99);
    return {
      n, mean: U.round(m, 3), sd: U.round(sd, 3), cv: U.round(sd / m, 4),
      min: U.round(min, 3), max: U.round(max, 3),
      p1: U.round(p1, 3), p50: U.round(med, 3), p99: U.round(p99, 3),
      maxToMedian: U.round(max / med, 2),
      outlierFence: U.round(upperFence, 2),
      nOutliers: outliers.length,
      outlierRate: U.round(outliers.length / n, 4),
      zeroWeights: zeros,
      neff: U.round(neff, 1),
      neffRatio: U.round(neff / n, 4),
      deff: U.round(deff, 3),
      suggestTrimHi: U.round(p99, 3),
    };
  }

  // 权重截断（返回新数组，不修改入参；原始值保留在 <key>_raw 列）
  function trimWeights(rows, weightKey, hi, lo = 0) {
    return rows.map(r => {
      const w = r[weightKey];
      if (w == null) return { ...r };
      const tw = U.clamp(w, lo, hi);
      const changed = tw !== w;
      return { ...r, [weightKey + '_raw']: w, [weightKey]: tw, trimmed: changed };
    });
  }

  return {
    coverage, jointCoverage, jointStratumKey, keyOf, NA,
    categoricalBias, numericBias,
    weightDiagnostics, trimWeights,
  };
});
