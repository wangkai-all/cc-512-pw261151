// 合成数据生成器：总体（48,000 单配送订单）+ 有偏抽样（2,000，含缺失）+ 回补记录
// 偏差机制：周末/高峰时段、一线城市、App 渠道、高价值客户被过度抽中；满意度为 MNAR 缺失
(function (root, factory) {
  const lib = factory(
    typeof require === 'function' ? require('../lib/util.js') : root.SBD
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (typeof window !== 'undefined') window.SBD = Object.assign(window.SBD || {}, lib);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  const REGIONS = ['华东', '华南', '华北', '华中', '西南', '西北', '东北'];
  const CHANNELS = ['App', '小程序', '网页', '电话'];
  const SEGMENTS = ['新客', '活跃', '沉睡', '会员'];
  const WEEKS = 12;

  // ---- 总体边际结构（概率，和为 1）----
  const REGION_P = [0.24, 0.18, 0.17, 0.14, 0.11, 0.08, 0.08];
  const CHANNEL_P = [0.42, 0.30, 0.18, 0.10];
  const SEGMENT_P = [0.30, 0.34, 0.21, 0.15];

  function buildPopulation(seed, N = 48000) {
    const rng = U.mulberry32(seed);
    const rows = [];
    for (let i = 0; i < N; i++) {
      const id = 'P' + String(i + 1).padStart(6, '0');
      const region = U.choice(rng, REGIONS, REGION_P);
      const channel = U.choice(rng, CHANNELS, CHANNEL_P);
      const segment = U.choice(rng, SEGMENTS, SEGMENT_P);

      // 时间：week 1..12，周末概率 2/7，小时以晚高峰为中心
      const week = 1 + Math.floor(rng() * WEEKS);
      const dow = 1 + Math.floor(rng() * 7); // 1=周一 … 7=周日
      const isWeekend = dow >= 6;
      let hour = Math.round(12 + 7 * U.randn(rng) + (isWeekend ? 1.5 : 0));
      hour = U.clamp(hour, 6, 23);

      // 关键属性：订单金额（对数正态，分群基线不同）
      const segBase = { 新客: 4.0, 活跃: 4.35, 沉睡: 3.85, 会员: 4.7 }[segment];
      const amount = Math.round(Math.exp(segBase + 0.45 * U.randn(rng)));
      const items = Math.max(1, Math.round(2.2 + 1.4 * U.randn(rng) + amount / 120));

      // 结果变量：履约时长（分钟），由结构项+噪声决定——总体真实均值由此自然产生
      const regionEff = { 华东: -2, 华南: 0, 华北: 1, 华中: 2, 西南: 4, 西北: 6, 东北: 3 }[region];
      const channelEff = { App: -1.5, 小程序: 0, 网页: 2.5, 电话: 4 }[channel];
      const weekendEff = isWeekend ? 5 : 0;
      const peakEff = (hour >= 17 && hour <= 21) ? 3.5 : 0;
      const segEff = { 新客: 1.5, 活跃: 0, 沉睡: 2.5, 会员: -1 }[segment];
      let duration = 32 + regionEff + channelEff + weekendEff + peakEff + segEff
        + 0.02 * (amount - 100) + 5.5 * U.randn(rng);
      duration = Math.max(12, Math.round(duration));

      // 满意度（1–5）：与履约时长负相关；总体阶段先不制造缺失
      let sat = 4.6 - 0.022 * duration + 0.55 * U.randn(rng)
        + (segment === '会员' ? 0.15 : 0);
      sat = U.clamp(Math.round(sat * 2) / 2, 1, 5);

      // 准时标志（<=45 分钟）
      const onTime = duration <= 45 ? 1 : 0;

      rows.push({
        id, week, dow, isWeekend, hour, region, channel, segment,
        amount, items, duration, satisfaction: sat, onTime,
      });
    }
    return rows;
  }

  // ---- 有偏抽样：对总体按入样概率 PPS 抽取，返回样本 + 设计权重 + 回补池 ----
  function drawBiasedSample(pop, seed, nSample = 2000) {
    const rng = U.mulberry32(seed);
    const regionBias = { 华东: 2.2, 华南: 1.6, 华北: 1.2, 华中: 0.8, 西南: 0.55, 西北: 0.35, 东北: 0.5 };
    const channelBias = { App: 2.4, 小程序: 1.1, 网页: 0.55, 电话: 0.25 };
    const segmentBias = { 新客: 0.8, 活跃: 1.3, 沉睡: 0.45, 会员: 1.8 };

    // 每条总体记录的入样倾向分
    const scores = pop.map(r => {
      let s = regionBias[r.region] * channelBias[r.channel] * segmentBias[r.segment];
      s *= r.isWeekend ? 1.9 : 0.75;                 // 时间偏差：周末过抽
      s *= (r.hour >= 17 && r.hour <= 21) ? 1.6 : 0.8;
      s *= U.clamp(r.amount / 90, 0.3, 3.2);         // 高金额过抽
      return s;
    });
    const sumScore = scores.reduce((a, b) => a + b, 0);
    // PPS 系统抽样：按累计得分放置 n 个等距抽样点，落在哪个单元即中选（允许重复中选）
    const step = sumScore / nSample;
    let start = rng() * step;
    const picked = [];
    let acc = 0, cursor = 0;
    for (let i = 0; i < pop.length; i++) {
      const lo = acc, hi = acc + scores[i];
      // 跳过落在当前单元之前的抽样点
      while (cursor < nSample && start + cursor * step < lo) cursor++;
      // 所有落在 [lo, hi) 内的抽样点都归入单元 i
      while (cursor < nSample && start + cursor * step < hi) {
        picked.push(i);
        cursor++;
      }
      acc = hi;
      if (picked.length >= nSample) break;
    }
    // 理论入样概率 ≈ n * score / sumScore（截断防止极端权重）
    const sample = [];
    const seen = new Set();
    for (const i of picked) {
      const r = pop[i];
      const piRaw = (nSample * scores[i]) / sumScore;
      const pi = U.clamp(piRaw, 0.002, 0.95);
      const row = { ...r, popIndex: i, inclProb: U.round(pi, 5), designWeight: U.round(1 / pi, 3), replicate: 0 };
      if (seen.has(i)) row.replicate = 1;
      seen.add(i);
      sample.push(row);
    }

    // ---- 缺失机制（MNAR）：满意度缺失随满意度本值降低而升高，并叠加渠道/地区效应 ----
    const missChannel = { App: 0.06, 小程序: 0.10, 网页: 0.16, 电话: 0.24 };
    const missRegion = { 西北: 1.6, 西南: 1.4, 东北: 1.3 };
    for (const r of sample) {
      const lowSat = r.satisfaction <= 3 ? 2.4 : 1;
      const p = U.clamp(0.05 * lowSat * (missRegion[r.region] || 1) * missChannel[r.channel] / 0.06, 0.01, 0.6);
      r.satisfactionMiss = rng() < p ? 1 : 0;
      // 地区也有少量 MCAR 式缺失（数据管道问题）
      r.regionMiss = rng() < 0.03 ? 1 : 0;
    }
    // 物化缺失（深拷贝避免污染总体）
    const observed = sample.map(r => ({
      ...r,
      satisfaction: r.satisfactionMiss ? null : r.satisfaction,
      region: r.regionMiss ? null : r.region,
    }));

    // ---- 回补数据：定向补采低覆盖格子（西北/东北 + 电话/网页 + 工作日 + 沉睡/新客）----
    const supplement = buildSupplement(pop, new Set(picked), rng, 90);
    return { sample: observed, sampleRaw: sample, supplement };
  }

  function buildSupplement(pop, pickedSet, rng, n) {
    const eligible = pop
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) =>
        !pickedSet.has(i) &&
        ['西北', '东北', '西南'].includes(r.region) &&
        ['电话', '网页'].includes(r.channel) &&
        !r.isWeekend);
    // 洗牌取前 n
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
    return eligible.slice(0, n).map(({ r }) => ({
      ...r,
      source: 'supplement',
      // 回补记录的入样概率按定向格子的抽样比例给出（小、非零）
      inclProb: U.round(0.012 + 0.006 * rng(), 5),
      designWeight: 0, // 占位，正式分析中由校准层重新计算
    })).map(r => {
      r.designWeight = U.round(1 / r.inclProb, 3);
      // 回补数据采集流程更严格：满意度无缺失；地区无缺失
      r.satisfactionMiss = 0;
      r.regionMiss = 0;
      return r;
    });
  }

  function generate(seed = 20261120) {
    const population = buildPopulation(seed, 48000);
    const { sample, sampleRaw, supplement } = drawBiasedSample(population, seed + 1, 2000);
    return {
      meta: {
        generatedAt: '2026-11-20',
        seed,
        dims: { region: REGIONS, channel: CHANNELS, segment: SEGMENTS, weeks: WEEKS },
        populationN: population.length,
        sampleN: sample.length,
        supplementN: supplement.length,
      },
      population,
      sample,
      sampleRaw, // 含缺失前的真实值，仅供缺失机制验证（看板不展示个体）
      supplement,
    };
  }

  return { generate, REGIONS, CHANNELS, SEGMENTS };
});
