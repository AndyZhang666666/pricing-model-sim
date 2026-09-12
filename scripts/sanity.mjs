// 校验 2/3：守恒检查。
//
// 思路：让三种机制在同一组「价格设为等价」的参数下跑，看收入是否收敛到同一量级。
// 不收敛说明模型有 bug —— 要么某个机制漏了抽成，要么状态机的口径和另外两个不一致。
//
// 什么叫「价格等价」：订阅月费 = 单集价格 × 月均解锁集数。
// 这样「按集付 3 集 × ¥1」和「按月付 ¥3 且每月解锁 3 集」在零流失下应当完全一样。
//
// 用法：npm run sanity      → results/sanity.json

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeParams, buildContext, simulateMechanism } from "../lib/model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const flatAnchors = [1, 7, 30, 90, 180].map((day) => ({ day, retention: 1 }));
// 零流失 + alpha 无关（生存率恒为 1），把曲线因素彻底排除，只留下定价口径。
const flatCtx = buildContext({ anchors: flatAnchors, alpha: 1 }, 12);

const checks = [];

function compare(name, a, b, relTolerance, note) {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  const rel = Math.abs(a - b) / denom;
  const pass = rel <= relTolerance;
  checks.push({
    name,
    a,
    b,
    relativeDiff: rel,
    relTolerance,
    pass,
    note,
  });
  return pass;
}

// ── 守恒 1：等价定价下，纯解锁 ≡ 纯订阅 ──────────────────────────────
// 单集 ¥1 × 月均 3 集 = 月付 ¥3。两边都不设试用、不设白嫖期、无抽成、无折现。
// 一个用户 12 个月里：解锁给 3 × 12 = 36，订阅也给 3 × 12 = 36。
const equiv = {
  common: { cac: 0, platformCut: 0, discountMonthly: 0, newUsersPerMonth: 1000 },
  unlock: {
    pricePerUnlock: 1,
    unlocksPerPayerMonth: 3,
    payerShare: 1,
    payerDecay: 1,
    freeEpisodes: 0,
    episodesPerMonth: 25,
  },
  subscription: { monthlyPrice: 3, trialDays: 0, trialOptIn: 1, trialToPaid: 1 },
  hybrid: { unlockThreshold: 6, switchRate: 0 },
};
const params = mergeParams(equiv);
const unlockRes = simulateMechanism("unlock", flatCtx, params);
const subRes = simulateMechanism("subscription", flatCtx, params);
const hybridRes = simulateMechanism("hybrid", flatCtx, params);

compare(
  "等价定价（¥1/集 × 3 集 ≡ ¥3/月）· 零流失 → 解锁与订阅 LTV 一致",
  unlockRes.summary.ltv12,
  subRes.summary.ltv12,
  1e-9,
  "两条收入路径在零流失下必须给出同一个数",
);

compare(
  "同上 → 混合（无人转订阅）与解锁一致",
  hybridRes.summary.ltv12,
  unlockRes.summary.ltv12,
  1e-9,
  "混合机制退化时应与纯解锁重合",
);

// ── 守恒 2：月度收入级联守恒 ─────────────────────────────────────────
// 第 m 月总收入 = 当月新增 × Σ_{k≤m} revUnit(k)。
// 反推：Σ_{k≤m} revUnit(k) 应当等于 monthly[m].revenue / newUsers。
// 这条是「别把批次循环写错」的防线——错一个下标这里立刻差一个 revUnit。
for (const [kind, res] of [["unlock", unlockRes], ["subscription", subRes], ["hybrid", hybridRes]]) {
  let ok = true;
  for (let i = 0; i < res.monthly.length; i++) {
    const expected = res.revUnit.slice(0, i + 1).reduce((a, b) => a + b, 0) * equiv.common.newUsersPerMonth;
    if (Math.abs(expected - res.monthly[i].revenue) > 1e-6) ok = false;
  }
  checks.push({
    name: `级联守恒 · ${kind} · 累计收入 = 新增用户数 × Σ revUnit`,
    a: res.monthly[res.monthly.length - 1].revenue,
    b: res.revUnit.reduce((a, b) => a + b, 0) * equiv.common.newUsersPerMonth,
    relativeDiff: 0,
    relTolerance: 1e-9,
    pass: ok,
    note: "批次下标写错会在这里露馅",
  });
}

// ── 守恒 3：抽成对三种机制的影响必须同比例 ───────────────────────────
// 抽成从 0 提到 30%，三种机制的 LTV 都应恰好乘 0.7。若某个机制漏乘，比例会偏。
const cutCheckParams = mergeParams({ ...equiv, common: { ...equiv.common, platformCut: 0.3 } });
const ratios = {};
for (const kind of ["unlock", "subscription", "hybrid"]) {
  const base = simulateMechanism(kind, flatCtx, params).summary.ltv12;
  const cut = simulateMechanism(kind, flatCtx, cutCheckParams).summary.ltv12;
  ratios[kind] = base === 0 ? 1 : cut / base;
  checks.push({
    name: `抽成一致性 · ${kind} · 抽成 30% 后 LTV 恰好 × 0.7`,
    a: cut / (base || 1),
    b: 0.7,
    relativeDiff: Math.abs(cut / (base || 1) - 0.7) / 0.7,
    relTolerance: 1e-9,
    pass: Math.abs(cut / base - 0.7) < 1e-9,
    note: "三种机制共用同一个 keep 系数，比例必须一致",
  });
}

// ── 守恒 4：真实曲线下三种机制的量级不出现荒谬值 ──────────────────────
// 不是要求它们相等，而是要求它们落在同一个可解释的量级内。
// 判据：任一机制的 LTV 不得超过「全员每月满额付费」的上界。
const realCtx = buildContext(
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
const realParams = mergeParams({ common: { cac: 0, platformCut: 0, discountMonthly: 0 } });
const realRows = [];
for (const kind of ["unlock", "subscription", "hybrid"]) {
  const res = simulateMechanism(kind, realCtx, realParams);
  // 上界：假设用户从第 1 个月起、每个月都付满 max(月费, 月均解锁收入)，且只按留存存活。
  const upper =
    Math.max(realParams.subscription.monthlyPrice, realParams.unlock.pricePerUnlock * realParams.unlock.unlocksPerPayerMonth) *
    realCtx.S.reduce((a, b) => a + b, 0);
  realRows.push({
    kind,
    ltv12: res.summary.ltv12,
    upperBound: upper,
    withinBound: res.summary.ltv12 <= upper + 1e-9,
  });
  checks.push({
    name: `量级上界 · ${kind} · LTV 不超过"全员满额付费"上界`,
    a: res.summary.ltv12,
    b: upper,
    relativeDiff: Math.max(0, (res.summary.ltv12 - upper) / upper),
    relTolerance: 0,
    pass: res.summary.ltv12 <= upper + 1e-9,
    note: "超过上界只可能是留存曲线或付费率被重复计入",
  });
}

// ── 守恒 5：折现必须让 LTV 单调下降 ─────────────────────────────────
const discRows = [];
for (const rate of [0, 0.05, 0.1]) {
  const res = simulateMechanism(
    "subscription",
    realCtx,
    mergeParams({ common: { cac: 0, platformCut: 0, discountMonthly: rate } }),
  );
  discRows.push({ rate, ltv12: res.summary.ltv12 });
}
const discMonotone = discRows.every((row, i) => i === 0 || row.ltv12 < discRows[i - 1].ltv12);
checks.push({
  name: "折现单调性 · 折现率 0% → 5% → 10%，LTV 严格递减",
  a: discRows[0].ltv12,
  b: discRows[discRows.length - 1].ltv12,
  relativeDiff: 0,
  relTolerance: 0,
  pass: discMonotone,
  note: `0%: ${discRows[0].ltv12.toFixed(3)} / 5%: ${discRows[1].ltv12.toFixed(3)} / 10%: ${discRows[2].ltv12.toFixed(3)}`,
});

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;

const out = {
  generatedBy: "scripts/sanity.mjs",
  generatedAt: new Date().toISOString(),
  summary: { total: checks.length, passed, failed },
  equivalencePrice: {
    pricePerUnlock: equiv.unlock.pricePerUnlock,
    unlocksPerPayerMonth: equiv.unlock.unlocksPerPayerMonth,
    impliedMonthlyPrice: equiv.unlock.pricePerUnlock * equiv.unlock.unlocksPerPayerMonth,
  },
  platformCutRatios: ratios,
  realCurveLtv: realRows,
  discountCurve: discRows,
  checks,
};

mkdirSync(resolve(ROOT, "results"), { recursive: true });
writeFileSync(resolve(ROOT, "results/sanity.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`守恒检查：${passed}/${checks.length} 通过`);
for (const c of checks.filter((x) => !x.pass)) {
  console.log(`  ✗ ${c.name}\n    a=${c.a} b=${c.b} 相对差=${(c.relativeDiff * 100).toFixed(6)}%`);
}
if (failed > 0) {
  console.error(`\n有 ${failed} 条守恒检查失败，说明模型有 bug，修好再提交。`);
  process.exit(1);
}
