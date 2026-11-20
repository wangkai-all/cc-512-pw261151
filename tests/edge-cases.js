// 边界验证：空分层、权重异常、回补数据 —— 纯 Node 断言，零依赖
// 用法: node tests/edge-cases.js
'use strict';
const assert = require('assert');
const U = require('../src/lib/util.js');
const D = require('../src/lib/diagnostics.js');
const C = require('../src/lib/corrections.js');
const gen = require('../src/lib/generate.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// ---------- 构造夹具 ----------
function fixture() {
  // 总体含 3 地区 × 2 渠道 = 6 层
  const pop = [];
  let id = 0;
  for (const region of ['R1', 'R2', 'R3']) {
    for (const channel of ['C1', 'C2']) {
      for (let i = 0; i < 600; i++) {
        pop.push({
          id: 'F' + (id++), region, channel,
          amount: region === 'R1' ? 50 : region === 'R2' ? 100 : 200,
          duration: 30 + (channel === 'C2' ? 10 : 0) + (region === 'R3' ? 8 : 0),
          satisfaction: 3.5, onTime: 1, isWeekend: false, segment: '活跃',
        });
      }
    }
  }
  // 样本：R3×C2 层完全为空（空分层）；R2×C2 只有 2 条（薄层）
  const sample = [];
  const push = (region, channel, n) => {
    for (let i = 0; i < n; i++) {
      sample.push({
        id: 'S' + sample.length, region, channel,
        amount: region === 'R1' ? 50 : 100,
        duration: 30 + (channel === 'C2' ? 10 : 0),
        satisfaction: i % 7 === 0 ? null : 4, onTime: 1,
        isWeekend: false, segment: '活跃', designWeight: 1,
      });
    }
  };
  push('R1', 'C1', 200); push('R1', 'C2', 120);
  push('R2', 'C1', 80); push('R2', 'C2', 2);   // 薄层
  // R3 两层完全缺失
  return { pop, sample };
}

console.log('一、空分层（empty stratum）验证');
{
  const { pop, sample } = fixture();
  const joint = D.jointCoverage(pop, sample, ['region', 'channel']);

  test('联合层总数正确（3×2=6）', () => assert.strictEqual(joint.nStrata, 6));
  test('检出空层 R3|C1 与 R3|C2', () => {
    const names = joint.emptyStrata.map(d => d.stratum);
    assert(names.includes('R3|C1') && names.includes('R3|C2'), '实际: ' + names);
  });
  test('覆盖率 = 4/6', () => assert.strictEqual(joint.coverage, 4 / 6));

  const v2 = C.v2Stratification(pop, sample, ['region', 'channel'], { minCell: 30 });
  test('V2 显式报告空层，不静默丢弃', () => assert(v2.emptyStrata.length >= 2));
  test('V2 输出告警文案', () => assert(v2.warnings.some(w => w.includes('空层'))));
  test('薄层 R2|C2 被折叠标记', () => {
    const thin = v2.thinStrata.find(t => t.stratum === 'R2|C2');
    assert(thin && thin.nSample === 2);
  });
  test('V2 所有样本行仍被赋权（空层不影响在样记录）', () => {
    assert(v2.weights.every(r => Number.isFinite(r.w_strata) && r.w_strata > 0));
  });
  test('V2 权重总和等于样本量（归一化）', () => {
    const sw = v2.weights.reduce((a, r) => a + r.w_strata, 0);
    assert(Math.abs(sw - sample.length) < 0.01, 'Σw=' + sw);
  });
  test('V2 薄层收缩变体是独立快照与独立列', () => {
    assert(Array.isArray(v2.weightsShrink) && v2.weightsShrink.length === v2.weights.length);
    assert(typeof v2.weightsShrink[0].w_strata_shrink === 'number');
    assert(v2.weights[0].w_strata_shrink === undefined); // 原快照无此列
    // 收缩变体中所有薄层使用同一个归一化尺度（收缩前均为中性权重 1）
    const thin = v2.weightsShrink.filter(r => r.strataStatus === 'thin-folded');
    assert(thin.length > 0);
    const scale = thin[0].w_strata_shrink;
    assert(thin.every(r => Math.abs(r.w_strata_shrink - scale) < 1e-9));
    const sw = v2.weightsShrink.reduce((a, r) => a + r.w_strata_shrink, 0);
    assert(Math.abs(sw - sample.length) < 0.01);
  });

  // 极端：样本完全为空
  test('空样本不抛异常，覆盖率为 0', () => {
    const j = D.jointCoverage(pop, [], ['region', 'channel']);
    assert.strictEqual(j.coverage, 0);
    assert.strictEqual(j.emptyStrata.length, 6);
  });

  // 极端：单条样本
  test('单条样本分层不崩，权重有限', () => {
    const one = C.v2Stratification(pop, [sample[0]], ['region', 'channel'], { minCell: 30 });
    assert(Number.isFinite(one.weights[0].w_strata));
  });
}

console.log('二、权重异常验证');
{
  const rows = [];
  // 500 条正常权重（5 条极端值占比 <1%，P99 稳定落在正常值区）+ 5 条极端权重 + 2 条零权重
  for (let i = 0; i < 500; i++) rows.push({ id: i, w: 1 + 0.05 * (i % 5), x: 10 + i });
  for (let i = 500; i < 505; i++) rows.push({ id: i, w: 80, x: 10 });
  for (let i = 505; i < 507; i++) rows.push({ id: i, w: 0, x: 10 });

  const diag = D.weightDiagnostics(rows, 'w');
  test('诊断出零权重记录', () => assert.strictEqual(diag.zeroWeights, 2));
  test('诊断出 IQR 离群权重', () => assert(diag.nOutliers >= 5, '实际 ' + diag.nOutliers));
  test('Neff 显著小于 n', () => assert(diag.neff < rows.length));
  test('NeffRatio 在 (0,1]', () => assert(diag.neffRatio > 0 && diag.neffRatio <= 1));
  test('给出 P99 截断建议且远低于极端值', () => {
    assert(diag.suggestTrimHi > 0 && diag.suggestTrimHi <= diag.p99 + 1e-9);
    assert(diag.p99 < 80, 'P99=' + diag.p99);
  });

  const trimmed = D.trimWeights(rows, 'w', diag.p99);
  test('截断后无权重超过 P99', () => assert(trimmed.every(r => r.w <= diag.p99 + 1e-9)));
  test('截断保留原始权重于 _raw 列（不覆盖）', () => {
    const hit = trimmed.find(r => r.trimmed);
    assert(hit && hit.w_raw === 80 && hit.w !== 80);
  });
  test('截断不修改输入数组', () => {
    const orig = rows.find(r => r.w === 80);
    assert(orig && orig.w_raw === undefined);
  });

  // 全零权重防御
  test('全零/全无效权重返回 Neff=0 而不崩', () => {
    const d = D.weightDiagnostics([{ w: 0 }, { w: 0 }], 'w');
    assert.strictEqual(d.neff, 0);
  });
  // 负权重/NaN 过滤（n 只统计有效权重）
  test('NaN 与负权重被排除', () => {
    const d = D.weightDiagnostics([{ w: 1 }, { w: NaN }, { w: -3 }], 'w');
    assert.strictEqual(d.n, 1);
  });

  // V1 收敛性与极端权重（真实数据）
  const dataset = gen.generate(20261120);
  const v1 = C.v1Weighting(dataset.population, dataset.sample,
    ['region', 'channel', 'segment', 'isWeekend']);
  test('IPF 校准收敛', () => assert(v1.converged));
  test('IPF 后已知类别边际偏差接近归零（最大 |SMD| < 0.03；NA 口径残差除外）', () => {
    const D2 = D;
    for (const dim of ['region', 'channel', 'segment', 'isWeekend']) {
      const b = D2.categoricalBias(dataset.population, v1.weights, dim, { weightKey: 'w_weight' });
      const knownMax = Math.max(...b.rows.filter(r => r.key !== '__NA__').map(r => r.absSmd));
      assert(knownMax < 0.03, dim + ' SMD=' + knownMax);
    }
  });
  test('截断变体是独立快照（列名不同，原列保留）', () => {
    assert(v1.weights[0].w_weight_trim === undefined);
    assert(typeof v1.weightsTrimmed[0].w_weight_trim === 'number');
    assert(typeof v1.weightsTrimmed[0].w_weight === 'number');
  });
}

console.log('三、回补数据验证');
{
  const dataset = gen.generate(20261120);
  const v3 = C.v3MissingAndSupplement(dataset.population, dataset.sample,
    dataset.supplement, { M: 5, truthRows: dataset.sampleRaw });

  test('回补记录被显式标记 isSupplement=1', () => {
    const supp = v3.combinedSample.filter(r => r.isSupplement === 1);
    assert.strictEqual(supp.length, dataset.supplement.length);
  });
  test('原样本记录 isSupplement=0', () => {
    assert(v3.combinedSample.filter(r => r.isSupplement === 0).length === dataset.sample.length);
  });
  test('回补无满意度缺失', () => {
    const supp = v3.combinedSample.filter(r => r.isSupplement === 1);
    assert(supp.every(r => r.satisfaction != null));
  });
  test('合并样本量 = 原样本 + 回补', () => {
    assert.strictEqual(v3.combinedSample.length, dataset.sample.length + dataset.supplement.length);
  });
  test('剔除回补的敏感性快照行数 = 原样本量', () => {
    assert.strictEqual(v3.noSupplementSample.length, dataset.sample.length);
  });
  test('回补定向命中低覆盖格子（西北/东北/西南 × 电话/网页）', () => {
    const ok = dataset.supplement.every(r =>
      ['西北', '东北', '西南'].includes(r.region) &&
      ['电话', '网页'].includes(r.channel) &&
      r.isWeekend === false);
    assert(ok);
  });
  test('回补不与原样本重复（popIndex 不重叠）', () => {
    const a = new Set(dataset.sample.map(r => r.popIndex));
    assert(dataset.supplement.every(r => !a.has(r.popIndex)));
  });

  // 缺失处理
  test('MNAR 证据：缺失组真实满意度显著更低 (p<0.05)', () => {
    const e = v3.missing.mnarEvidence;
    assert(e && e.p < 0.05 && e.gap < 0, JSON.stringify(e));
  });
  test('插补写入新列 satisfaction_imp，原列保持 null（不覆盖）', () => {
    const imputed = v3.imputedSample.filter(r => r.satisfaction === null);
    assert(imputed.length > 0);
    assert(imputed.every(r => typeof r.satisfaction_imp === 'number'));
  });
  test('插补值在合法域 [1,5] 且为 0.5 粒度', () => {
    for (const r of v3.imputedSample) {
      if (r.satisfaction_imp != null) {
        assert(r.satisfaction_imp >= 1 && r.satisfaction_imp <= 5);
        assert(Math.abs(r.satisfaction_imp * 2 - Math.round(r.satisfaction_imp * 2)) < 1e-9);
      }
    }
  });
  test('完整案例快照不删除原数组的行', () => {
    assert(v3.imputedSample.length === dataset.sample.length);
    assert(v3.completeCase.length < dataset.sample.length);
  });
  test('Rubin 合并：M 次插补均值有限且 SE 为正', () => {
    assert(Number.isFinite(v3.imputation.miMean));
    assert(v3.imputation.miSe > 0);
    assert.strictEqual(v3.imputation.impMeans.length, 5);
  });

  // 极端：回补为空
  test('空回补列表不崩，combined 仍等于样本', () => {
    const empty = C.v3MissingAndSupplement(dataset.population, dataset.sample, [], { M: 3 });
    assert.strictEqual(empty.combinedSample.length, dataset.sample.length);
  });
  // 极端：全部缺失
  test('满意度 100% 缺失时回退全局插补不崩', () => {
    const allMiss = dataset.sample.slice(0, 50).map(r => ({ ...r, satisfaction: null }));
    const out = C.v3MissingAndSupplement(dataset.population, allMiss, [], { M: 3 });
    assert(out.imputedSample.every(r => typeof r.satisfaction_imp === 'number'));
  });
}

console.log('四、原样本不可变（不覆盖铁律）');
{
  const dataset = gen.generate(20261120);
  const before = JSON.stringify(dataset.sample.map(r => ({ s: r.satisfaction, w: r.designWeight })));
  const v1 = C.v1Weighting(dataset.population, dataset.sample, ['region', 'channel']);
  const v2 = C.v2Stratification(dataset.population, dataset.sample, ['region', 'channel']);
  const v3 = C.v3MissingAndSupplement(dataset.population, dataset.sample, dataset.supplement, {});
  const after = JSON.stringify(dataset.sample.map(r => ({ s: r.satisfaction, w: r.designWeight })));
  test('三个修正全部运行后，原样本数组内容逐字段不变', () => assert.strictEqual(before, after));
  test('原样本上不存在修正产生的新列', () => {
    assert(dataset.sample.every(r =>
      r.w_weight === undefined && r.w_strata === undefined &&
      r.w_comb === undefined && r.satisfaction_imp === undefined));
  });
  test('各版本权重列相互独立', () => {
    assert('w_weight' in v1.weights[0]);
    assert('w_strata' in v2.weights[0]);
    assert('w_comb' in v3.combinedSample[0]);
    assert(v1.weights[0].w_strata === undefined);
  });
}

console.log('\n' + (process.exitCode ? '存在失败用例' : `全部通过：${passed} 项断言`));
