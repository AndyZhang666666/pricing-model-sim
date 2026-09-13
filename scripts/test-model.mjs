// 校验 1/3：对照手算值，确认模型在极端情况下给出人脑能验证的答案。
//
// 设计原则：每一组都必须是「不看代码、只在纸上算就能得出预期值」的情形。
// 凡是需要跑一遍程序才知道对不对的检查，都是在自欺欺人。
//
// 用法：npm run test-model      → results/model-check.json

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mergeParams,
  buildContext,
  simulateMechanism,
} from "../lib/model.js";
import { fitCurve, monthlySurvival, rateAtMonth } from "../lib/retention.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const cases = [];

function check(name, expected, actual, tolerance, note) {
  const pass = Math.abs(expected - actual) <= tolerance;
  cases.push({
    name,
    expected,
    actual,
    tolerance,
    pass,
    note,
  });
  return pass;
}

function checkEq(name, expected, actual, note) {
  const pass = expected === actual;
  cases.push({ name, expected, actual, tolerance: 0, pass, note });
  return pass;
}

// ── 曲线 1：零流失（留存恒为 100%）──────────────────────────────────
// 这是最重要的一条基准：所有系数都被摘掉，只剩下定价本身。
const flatAnchors = [
  { day: 1, retention: 1 },
  { day: 7, retention: 1 },
  { day: 30, retention: 1 },
  { day: 90, retention: 1 },
  { day: 180, retention: 1 },
];

const flatCurve = fitCurve(flatAnchors);
check(
  "零流失曲线：任意月的月初在册比例都是 1",
  1,
  rateAtMonth(flatCurve, 7),
  1e-9,
  "r(d) = 1 × d^0，斜率 OLS 应为 0",
);

const flatCtx = buildContext({ anchors: flatAnchors, alpha: 1 }, 12);
check(
  "零流失曲线：12 个月生存数组全为 1",
  12,
  flatCtx.S.reduce((a, b) => a + b, 0),
  1e-9,
  "S_k ≡ 1",
);

// ── 场景 A：零流失 + 全额付费 + 无抽成，只有订阅 ──────────────────────
// 手算：月费 10，抽成 0，试用 0 天，全员开始试用且必转化。
// 一个用户每个月都在付费 → 12 个月 LTV = 10 × 12 = 120。
// 这是任务书里点名的那个用例。
const pureSubParams = mergeParams({
  common: { cac: 0, platformCut: 0, discountMonthly: 0, newUsersPerMonth: 1000 },
  subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 1, trialToPaid: 1 },
});
const pureSubCtx = buildContext({ anchors: flatAnchors, alpha: 1 }, 12);
const pureSub = simulateMechanism("subscription", pureSubCtx, pureSubParams);
check(
  "零流失 + 全员付费 + 无抽成 + 月费 10 → 12 月 LTV = 120",
  120,
  pureSub.summary.ltv12,
  1e-9,
  "Σ_{k=1..12} 10 = 120",
);
checkEq(
  "同上 → 回本月份为 null（CAC = 0）",
  null,
  pureSub.summary.paybackMonth,
  "CAC 为 0 时首月即回本，但约定 CAC ≤ 0 记为 null（无需回本）",
);

// ── 场景 B：零流失 + 只有一半人付费，订阅 ────────────────────────────
// 手算：月费 10，起点折损 0.5 → 每月 5，12 个月 = 60。
const halfSub = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0 },
    subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 1, trialToPaid: 0.5 },
  }),
);
check(
  "零流失 + 50% 转化 + 月费 10 → 12 月 LTV = 60",
  60,
  halfSub.summary.ltv12,
  1e-9,
  "10 × 0.5 × 12 = 60",
);

// ── 场景 C：平台抽成 30%，订阅 ───────────────────────────────────────
// 手算：10 × 0.5 × 0.7 × 12 = 42。
const cutSub = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0.3, discountMonthly: 0 },
    subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 1, trialToPaid: 0.5 },
  }),
);
check(
  "抽成 30% → 12 月 LTV = 42",
  42,
  cutSub.summary.ltv12,
  1e-9,
  "60 × 0.7 = 42",
);

// ── 场景 D：折现率 10%/月，订阅 ──────────────────────────────────────
// 手算：Σ_{k=0..11} 10 / 1.1^k = 10 × (1 − 1.1^-12) / (1 − 1/1.1)
const r = 0.1;
const annuity = Array.from({ length: 12 }, (_, k) => 1 / Math.pow(1 + r, k)).reduce((a, b) => a + b, 0);
const discSub = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: r },
    subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 1, trialToPaid: 1 },
  }),
);
check(
  "折现率 10%/月 → 12 月 LTV = 10 × 年金因子",
  10 * annuity,
  discSub.summary.ltv12,
  1e-9,
  `年金因子 = ${annuity.toFixed(6)}`,
);

// ── 场景 E：单次解锁，零流失，无白嫖期 ────────────────────────────────
// 手算：单集 1 元，付费率 100%，月均解锁 3 集，无抽成，免费 0 集。
// 每月收入 3 元 × 12 个月 = 36。decay = 1 保证付费意愿不衰减。
const pureUnlock = simulateMechanism(
  "unlock",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0 },
    unlock: {
      pricePerUnlock: 1,
      unlocksPerPayerMonth: 3,
      payerShare: 1,
      payerDecay: 1,
      freeEpisodes: 0,
      episodesPerMonth: 25,
    },
  }),
);
check(
  "零流失 + 全员付费 + 月解锁 3 集 × ¥1 → 12 月 LTV = 36",
  36,
  pureUnlock.summary.ltv12,
  1e-9,
  "3 × 12 = 36",
);

// ── 场景 F：单次解锁 + 免费 25 集（折算成整 1 个月白嫖期）─────────────
// 手算：episodesPerMonth = 25，freeEpisodes = 25 → freeBlock = 1 个月。
// 第 1 个月 window = 0，第 2~12 个月 window = 1 → 11 个月 × 3 = 33。
const unlockFree1 = simulateMechanism(
  "unlock",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0 },
    unlock: {
      pricePerUnlock: 1,
      unlocksPerPayerMonth: 3,
      payerShare: 1,
      payerDecay: 1,
      freeEpisodes: 25,
      episodesPerMonth: 25,
    },
  }),
);
check(
  "免费 25 集（=1 个月白嫖期）→ 只有 11 个月有收入，LTV = 33",
  33,
  unlockFree1.summary.ltv12,
  1e-9,
  "第 1 月 window = 0，2~12 月 window = 1",
);

// ── 场景 G：回本月份的手算 ───────────────────────────────────────────
// 零流失、无抽成、订阅月费 10、全员付费、CAC = 25。
// 累计收入：10, 20, 30 → 首次 ≥ 25 是第 3 个月。
const paybackSub = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 25, platformCut: 0, discountMonthly: 0 },
    subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 1, trialToPaid: 1 },
  }),
);
checkEq(
  "零流失 + 月费 10 + CAC 25 → 回本月份 = 3",
  3,
  paybackSub.summary.paybackMonth,
  "累计 10 / 20 / 30，第 3 个月首次越过 25",
);
check(
  "同上 → LTV/CAC = 120 / 25 = 4.8",
  4.8,
  paybackSub.summary.ltvCac,
  1e-9,
  "120 ÷ 25",
);

// ── 场景 H：总收入守恒（每批用户 × 月份数）──────────────────────────
// 零流失、无抽成、订阅月费 10、全员付费、每月新增 1000 人。
// 12 个月累计总收入 = 1000 × 10 × (12 + 11 + ... + 1) = 1000 × 10 × 78 = 780,000。
// 换个角度看：第 m 月单月收入 = 1000 × 10 × m，求和即 1000 × 10 × 78。
const revSub = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0, newUsersPerMonth: 1000 },
    subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 1, trialToPaid: 1 },
  }),
);
check(
  "每月新增 1000 人 + 月费 10 + 全员付费 → 12 月累计收入 = 780,000",
  1000 * 10 * ((12 * 13) / 2),
  revSub.summary.cumRevenue12,
  1e-6,
  "1000 × 10 × (1+2+…+12) = 1000 × 10 × 78",
);
check(
  "同上 → 第 12 个月单月收入 = 1000 × 10 × 12 = 120,000",
  1000 * 10 * 12,
  revSub.monthly[11].revenue,
  1e-6,
  "单月收入与累计收入相差一个数量级，字段名已区分",
);
check(
  "同上 → 第 12 月存量 = 1000 × 12 = 12,000",
  12000,
  revSub.summary.stock12,
  1e-6,
  "零流失，12 个批次全在",
);

// ── 场景 I：幂律曲线的 D30 拟合要能对上锚点 ──────────────────────────
// 手工构造一条严格的幂律曲线 r(d) = 0.5 · d^(-0.5)：
//   D1 = 0.5, D7 = 0.5/√7 = 0.18898, D30 = 0.5/√30 = 0.09129
// 拟合强制穿过 D1，斜率用 OLS 反推，应当在锚点处几乎无误差。
const exactPowerAnchors = [1, 7, 30, 90, 180].map((day) => ({
  day,
  retention: 0.5 * Math.pow(day, -0.5),
}));
const exactPowerCurve = fitCurve(exactPowerAnchors);
check(
  "严格幂律锚点 → 拟合斜率回到 −0.5",
  -0.5,
  -exactPowerCurve.power,
  1e-6,
  "r(d) = 0.5·d^−0.5 的 OLS 斜率应精确还原",
);
check(
  "严格幂律锚点 → 拟合 RMSE ≈ 0",
  0,
  exactPowerCurve.rmse,
  1e-6,
  "锚点本身在曲线上，残差为 0",
);

// ── 场景 J：混合机制在退化参数下应等于单次解锁 ────────────────────────
// switchRate = 0 表示没人转向订阅 → 混合退化成纯解锁，两者 LTV 必须完全相等。
// 这是一条很重要的自洽性检查：状态机写错的话这里会露馅。
const hybridSeed = mergeParams({
  common: { cac: 0, platformCut: 0, discountMonthly: 0 },
  unlock: {
    pricePerUnlock: 1,
    unlocksPerPayerMonth: 3,
    payerShare: 1,
    payerDecay: 1,
    freeEpisodes: 0,
    episodesPerMonth: 25,
  },
  subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 1, trialToPaid: 1 },
  hybrid: { unlockThreshold: 6, switchRate: 0 },
});
const hybridZero = simulateMechanism("hybrid", pureSubCtx, hybridSeed);
check(
  "混合机制 switchRate = 0 → 与纯解锁 LTV 完全相等（36）",
  36,
  hybridZero.summary.ltv12,
  1e-9,
  "状态机退化检查：没人转订阅时两条路径必须重合",
);

// ── 场景 K：混合机制在 switchRate = 1 时收入不低于纯解锁 ───────────────
// 全部转向订阅（月费 10 远高于单集 1 元）→ 收入应当显著更高。
const hybridFull = simulateMechanism(
  "hybrid",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0 },
    unlock: {
      pricePerUnlock: 1,
      unlocksPerPayerMonth: 3,
      payerShare: 1,
      payerDecay: 1,
      freeEpisodes: 0,
      episodesPerMonth: 25,
    },
    subscription: { monthlyPrice: 110, trialDays: 0, trialOptIn: 1, trialToPaid: 1 },
    hybrid: { unlockThreshold: 1, switchRate: 1 },
  }),
);
check(
  "混合机制 switchRate = 1 → LTV 高于纯解锁的 36",
  true,
  hybridFull.summary.ltv12 > 36,
  0,
  `实际 ${hybridFull.summary.ltv12.toFixed(4)}，月费 110 高于单集 1 元，转订阅后必然更赚`,
);

// ── 场景 L：monotonicity — 月费翻倍，订阅 LTV 必须翻倍 ────────────────
// 线性定价下 LTV 对月费是一阶齐次的。如果翻倍后不是精确 2 倍，说明有地方写死了价格。
const price10 = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0 },
    subscription: { monthlyPrice: 10, trialDays: 0, trialOptIn: 0.5, trialToPaid: 0.5 },
  }),
);
const price20 = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0 },
    subscription: { monthlyPrice: 20, trialDays: 0, trialOptIn: 0.5, trialToPaid: 0.5 },
  }),
);
check(
  "月费 10 → 20，订阅 LTV 精确翻倍（价格线性）",
  price10.summary.ltv12 * 2,
  price20.summary.ltv12,
  1e-9,
  `${price10.summary.ltv12.toFixed(4)} → ${price20.summary.ltv12.toFixed(4)}`,
);

// ── 场景 M：试用期 15 天 → 首月计费比例恰好 0.5 ──────────────────────
// 手算：trialMonths = 0.5，第 1 个月 billable = 0.5，无抽成、月费 10、全员付费。
// 第 1 月贡献 5，之后每月 10 → 12 月合计 5 + 10×11 = 115。
const trial15 = simulateMechanism(
  "subscription",
  pureSubCtx,
  mergeParams({
    common: { cac: 0, platformCut: 0, discountMonthly: 0 },
    subscription: { monthlyPrice: 10, trialDays: 15, trialOptIn: 1, trialToPaid: 1 },
  }),
);
check(
  "试用 15 天 → 12 月 LTV = 5 + 10 × 11 = 115",
  115,
  trial15.summary.ltv12,
  1e-9,
  "首月只计半个月费",
);

// ── 场景 N：LTV 恒 ≥ 0、且 12 月 LTV ≥ 首月收入 ──────────────────────
const defaultRun = buildContext(
  {
    anchors: [
      { day: 1, retention: 0.42 },
      { day: 7, retention: 0.24 },
      { day: 30, retention: 0.12 },
      { day: 90, retention: 0.06 },
      { day: 180, retention: 0.035 },
    ],
    alpha: 0.6,
  },
  12,
);
for (const kind of ["unlock", "subscription", "hybrid"]) {
  const sim = simulateMechanism(kind, defaultRun, mergeParams());
  const nonNeg = sim.revUnit.every((v) => v >= 0);
  cases.push({
    name: `默认参数 · ${kind} · 逐月收入非负`,
    expected: true,
    actual: nonNeg,
    tolerance: 0,
    pass: nonNeg,
    note: "价格为负或状态机出错时会漏到这里",
  });
  const monotone = sim.monthly.every((row, i) => i === 0 || row.arpu >= sim.monthly[i - 1].arpu);
  cases.push({
    name: `默认参数 · ${kind} · 累计 ARPU 单调不减`,
    expected: true,
    actual: monotone,
    tolerance: 0,
    pass: monotone,
    note: "累计量减少说明有负收入项",
  });
}

const passed = cases.filter((c) => c.pass).length;
const failed = cases.length - passed;

const out = {
  generatedBy: "scripts/test-model.mjs",
  // 只记录日期：这些产物是确定性的（没有随机数），秒级时间戳只会让每次重跑产生
  // 一行无意义的 git diff，掩盖真正的数据变化。
  generatedAt: new Date().toISOString().slice(0, 10),
  summary: { total: cases.length, passed, failed },
  cases,
};

mkdirSync(resolve(ROOT, "results"), { recursive: true });
writeFileSync(resolve(ROOT, "results/model-check.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`手算校验：${passed}/${cases.length} 通过`);
for (const c of cases.filter((x) => !x.pass)) {
  console.log(`  ✗ ${c.name}\n    预期 ${c.expected}，实际 ${c.actual}（容差 ${c.tolerance}）`);
}
if (failed > 0) {
  console.error(`\n有 ${failed} 条校验失败，模型不能提交。`);
  process.exit(1);
}
