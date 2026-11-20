// 确定性伪随机数与统计原语 —— 浏览器 / Node 双运行（UMD 风格）
(function (root, factory) {
  const lib = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (typeof window !== 'undefined') window.SBD = Object.assign(window.SBD || {}, lib);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 确定性 RNG ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 正态分布（Box–Muller）
  function randn(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function choice(rng, items, probs) {
    const r = rng();
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      acc += probs[i];
      if (r < acc) return items[i];
    }
    return items[items.length - 1];
  }

  function mean(x) {
    if (!x.length) return NaN;
    let s = 0;
    for (const v of x) s += v;
    return s / x.length;
  }

  function weightedMean(x, w) {
    let s = 0, sw = 0;
    for (let i = 0; i < x.length; i++) { s += x[i] * w[i]; sw += w[i]; }
    return sw === 0 ? NaN : s / sw;
  }

  function variance(x, m) {
    if (x.length < 2) return NaN;
    if (m === undefined) m = mean(x);
    let s = 0;
    for (const v of x) s += (v - m) * (v - m);
    return s / (x.length - 1);
  }

  function weightedVariance(x, w, m) {
    let sw = 0, sw2 = 0, s = 0;
    for (let i = 0; i < x.length; i++) { sw += w[i]; sw2 += w[i] * w[i]; }
    if (m === undefined) m = weightedMean(x, w);
    for (let i = 0; i < x.length; i++) s += w[i] * (x[i] - m) * (x[i] - m);
    // 可靠性加权方差（无偏修正因子 sw / (sw - sum w² / sw)）
    const denom = sw - sw2 / sw;
    return denom <= 0 ? NaN : (s / sw) * (sw / denom);
  }

  // 最近秩分位数（阈值型用途更稳健：P99 取第 ceil(0.99n) 秩，
  // 极少数极端值不会把阈值拉到极端值本身）
  function quantile(sorted, p) {
    if (!sorted.length) return NaN;
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1;
    return sorted[rank];
  }

  function median(x) {
    const s = x.slice().sort((a, b) => a - b);
    return quantile(s, 0.5);
  }

  // 标准正态 CDF（Abramowitz & Stegun 7.1.26）
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  // 双尾 p 值（正态近似）
  function twoTailedP(z) { return 2 * (1 - normCdf(Math.abs(z))); }

  // 卡方上尾概率（自由度整数，用正则化下伽马；df 小则用 Wilson–Hilferty 兜底）
  function chiSqTail(x, df) {
    if (x <= 0) return 1;
    // Wilson–Hilferty 近似，转标准正态
    const t = Math.cbrt(x / df);
    const z = (t - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
    return 1 - normCdf(z);
  }

  // ---------- 分布工具 ----------
  function normKey(v) {
    if (v === null || v === undefined) return '__NA__';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
  }

  function counts(rows, key, order) {
    const c = new Map();
    for (const r of rows) {
      const k = normKey(r[key]);
      c.set(k, (c.get(k) || 0) + 1);
    }
    const keys = order ? order.map(normKey) : Array.from(c.keys());
    return keys.map(k => ({ key: k, n: c.get(k) || 0 }));
  }

  function proportions(rows, key, order) {
    const cs = counts(rows, key, order);
    const total = cs.reduce((a, b) => a + b.n, 0) || 1;
    return cs.map(d => ({ key: d.key, n: d.n, p: d.n / total }));
  }

  // 加权比例（权重缺失视为 1）
  function weightedProportions(rows, key, weightKey, order) {
    const m = new Map();
    let total = 0;
    for (const r of rows) {
      const k = normKey(r[key]);
      const w = r[weightKey] == null ? 1 : r[weightKey];
      m.set(k, (m.get(k) || 0) + w);
      total += w;
    }
    const keys = order ? order.map(normKey) : Array.from(m.keys());
    return keys.map(k => ({ key: k, w: m.get(k) || 0, p: (m.get(k) || 0) / (total || 1) }));
  }

  // 加权分位数（输入需为 [ {v, w} ]，权重非负）
  function weightedQuantile(pairs, p) {
    const s = pairs.filter(d => d.v != null && !Number.isNaN(d.v)).sort((a, b) => a.v - b.v);
    const total = s.reduce((a, b) => a + b.w, 0);
    if (total <= 0) return NaN;
    const target = p * total;
    let acc = 0;
    for (const d of s) {
      acc += d.w;
      if (acc >= target) return d.v;
    }
    return s[s.length - 1].v;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function round(v, d = 4) {
    if (v == null || Number.isNaN(v)) return v;
    const f = 10 ** d;
    return Math.round(v * f) / f;
  }

  return {
    mulberry32, randn, choice,
    mean, weightedMean, variance, weightedVariance,
    quantile, median, weightedQuantile,
    normCdf, twoTailedP, chiSqTail,
    counts, proportions, weightedProportions,
    clamp, round,
  };
});
