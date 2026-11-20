// 构建：生成合成数据 -> 运行完整分析 -> 落盘 data/ 与 dashboard/ 可直接加载的 JS
// 用法: node scripts/build-data.js
'use strict';
const fs = require('fs');
const path = require('path');
const gen = require('../src/lib/generate.js');
const analysis = require('../src/analysis.js');

const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');
const dashDir = path.join(root, 'dashboard');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(dashDir, { recursive: true });

console.log('1) 生成合成数据…');
const dataset = gen.generate(20261120);
console.log(`   总体 ${dataset.population.length} 行 / 样本 ${dataset.sample.length} 行 / 回补 ${dataset.supplement.length} 行`);

// CSV 导出（供表格视图与外部核对）
function toCsv(rows, columns) {
  const head = columns.join(',');
  const body = rows.map(r => columns.map(c => {
    const v = r[c];
    if (v === null || v === undefined) return '';
    return typeof v === 'string' && v.includes(',') ? `"${v}"` : v;
  }).join(',')).join('\n');
  return head + '\n' + body;
}
const popCols = ['id', 'week', 'dow', 'isWeekend', 'hour', 'region', 'channel', 'segment', 'amount', 'items', 'duration', 'satisfaction', 'onTime'];
fs.writeFileSync(path.join(dataDir, 'population.csv'), toCsv(dataset.population, popCols));
const sampCols = [...popCols, 'inclProb', 'designWeight', 'satisfactionMiss', 'regionMiss'];
fs.writeFileSync(path.join(dataDir, 'sample.csv'), toCsv(dataset.sample, sampCols));
fs.writeFileSync(path.join(dataDir, 'supplement.csv'), toCsv(dataset.supplement, [...popCols, 'source', 'inclProb', 'designWeight']));

console.log('2) 运行诊断与修正分析…');
const result = analysis.run(dataset);

// 完整结果（Node/测试/审计用，保留全部行级副本）
fs.writeFileSync(path.join(dataDir, 'analysis-result.json'), JSON.stringify(result));

// 看板数据包：剔除 corrections 内重复的行数组（行数据统一由 rows 区承载），
// 且看板只保留实际渲染用到的行级集合（V2/V2s 仅消费聚合结果），
// 体积控制在 ~2MB；完整行级副本见 data/analysis-result.json
const dashPayload = JSON.parse(JSON.stringify(result));
const ROW_KEYS = new Set(['weights', 'weightsTrimmed', 'weightsShrink', 'imputedSample', 'completeCase',
  'combinedSample', 'noSupplementSample']);
for (const v of Object.values(dashPayload.corrections)) {
  for (const k of ROW_KEYS) if (k in v) v[k] = `__ROWS__${k}`;
}
delete dashPayload.rows.v2;
delete dashPayload.rows.v2shrink;
fs.writeFileSync(
  path.join(dashDir, 'data.js'),
  '// 自动生成，勿手改。构建: node scripts/build-data.js\n' +
  '// 行级数据统一在 rows 区；corrections 中同名键为占位，完整副本见 data/analysis-result.json\n' +
  'window.SBD_DATA = ' + JSON.stringify(dashPayload) + ';\n'
);
// 轻量元数据
fs.writeFileSync(path.join(dataDir, 'dataset-meta.json'), JSON.stringify(dataset.meta, null, 2));

console.log('3) 关键结果速览:');
for (const t of result.estimandTable) {
  const v0 = t.versions.V0.value, pop = t.versions.POP.value, v1 = t.versions.V1.value, v3 = t.versions.V3mi.value;
  console.log(`   ${t.label}: 总体=${pop} 原样本=${v0} 加权=${v1} 回补MI=${v3}`);
}
console.log(`   联合层空层数: ${result.jointCoverage.emptyStrata.length}/${result.jointCoverage.nStrata}`);
console.log(`   V1 权重 Neff=${result.corrections.V1.weightDiag.neff}, 离群=${result.corrections.V1.weightDiag.nOutliers}`);
console.log('完成。');
