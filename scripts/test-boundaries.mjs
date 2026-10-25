import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PARAMS,
  DEFAULT_RETENTION,
  mergeParams,
  overrideParams,
  buildContext,
  simulateAll,
  simulateMechanism,
  MODEL_VERSION,
} from "../lib/model.js";
import { fitCurve, moveAnchor } from "../lib/retention.js";
import { decodeDraft, comparisonSnapshot } from "../lib/session.js";
const flat = {
  name: "flat",
  alpha: 1,
  anchors: [1, 7, 30, 90, 180].map((day) => ({ day, retention: 1 })),
};
const ctx = buildContext(flat);
test("全体初始付费者离开后，不再重复分流或产生解锁收入", () => {
  const p = mergeParams({
    common: { platformCut: 0 },
    unlock: {
      payerShare: 0.25,
      payerDecay: 1,
      pricePerUnlock: 1,
      unlocksPerPayerMonth: 1,
      freeEpisodes: 0,
    },
    hybrid: { switchRate: 1, switchChurn: 1, unlockThreshold: 1 },
  });
  const r = simulateMechanism("hybrid", ctx, p);
  assert.equal(r.summary.expectedUnlocks, 0.25);
  assert.equal(r.summary.churnedBySwitch, 0.25);
  assert.equal(r.trace[0].unlockPool, 0.25);
  assert.ok(
    r.trace.slice(1).every((row) => row.unlockPool === 0 && row.reached === 0),
  );
});
test("订阅从切换次月开始，不在同月双重全额计费", () => {
  const p = mergeParams({
    common: { platformCut: 0 },
    unlock: {
      payerShare: 0.25,
      payerDecay: 1,
      pricePerUnlock: 1,
      unlocksPerPayerMonth: 1,
      freeEpisodes: 0,
    },
    subscription: { monthlyPrice: 10 },
    hybrid: { switchRate: 1, switchChurn: 0, unlockThreshold: 1 },
  });
  const r = simulateMechanism("hybrid", ctx, p);
  assert.equal(r.revUnit[0], 0.25);
  assert.equal(r.revUnit[1], 2.5);
  assert.equal(r.summary.expectedPaidMonths, 2.75);
  assert.equal(r.summary.ltv12, 0.25 + 2.5 * 11);
});
test("累计切换份额不超过初始可付费人群", () => {
  for (const payerShare of [0, 0.1, 0.25, 1])
    for (const switchRate of [0, 0.2, 1])
      for (const switchChurn of [0, 0.4, 1]) {
        const r = simulateMechanism(
          "hybrid",
          ctx,
          mergeParams({
            unlock: { payerShare, payerDecay: 1, freeEpisodes: 0 },
            hybrid: { switchRate, switchChurn, unlockThreshold: 0 },
          }),
        );
        assert.ok(
          r.summary.movedToSubscription + r.summary.churnedBySwitch <=
            payerShare + 1e-12,
        );
        for (const row of r.trace)
          assert.ok(row.moved + row.churned <= row.unlockPool + 1e-12);
      }
});
test("计数不从收入反除，价格为零或抽成100%仍是有限数", () => {
  for (const overrides of [
    { unlock: { pricePerUnlock: 0 }, subscription: { monthlyPrice: 0 } },
    { common: { platformCut: 1 } },
  ]) {
    const sim = simulateAll(DEFAULT_RETENTION, overrides);
    for (const r of Object.values(sim.results)) {
      assert.equal(r.summary.ltv12, 0);
      assert.ok(Number.isFinite(r.summary.expectedUnlocks));
      assert.ok(Number.isFinite(r.summary.expectedPaidMonths));
    }
    assert.equal(sim.verdict.tie, true);
    assert.equal(sim.verdict.tiedWinners.length, 3);
    assert.match(sim.verdict.coverage, /并列/);
  }
});
test("解锁付费窗口按每名新增用户归一化", () => {
  const r = simulateMechanism(
    "unlock",
    ctx,
    mergeParams({
      unlock: { payerShare: 0.25, payerDecay: 1, freeEpisodes: 0 },
    }),
  );
  assert.equal(r.summary.expectedPaidMonths, 3);
});
test("累计折现贡献与LTV和回本使用同一序列", () => {
  const r = simulateMechanism(
    "subscription",
    ctx,
    mergeParams({
      common: { cac: 25, platformCut: 0, discountMonthly: 0.1 },
      subscription: {
        monthlyPrice: 10,
        trialDays: 0,
        trialOptIn: 1,
        trialToPaid: 1,
      },
    }),
  );
  assert.ok(Math.abs(r.monthly.at(-1).discountedArpu - r.summary.ltv12) < 1e-9);
  const first = r.monthly.find((x) => x.discountedArpu >= 25).month;
  assert.equal(first, r.summary.paybackMonth);
});
test("敏感性覆盖一个字段，保留所有其他当前参数", () => {
  const p = mergeParams({
    subscription: { trialOptIn: 0.12, trialToPaid: 0.37, trialDays: 15 },
    unlock: { pricePerUnlock: 7.2 },
  });
  const changed = overrideParams(p, { subscription: { monthlyPrice: 45 } });
  assert.equal(changed.subscription.monthlyPrice, 45);
  for (const k of ["trialOptIn", "trialToPaid", "trialDays"])
    assert.equal(changed.subscription[k], p.subscription[k]);
  assert.deepEqual(changed.unlock, p.unlock);
});
test("0%锚点保留，曲线不丢点，错误曲线明确拒绝", () => {
  const curve = fitCurve([
    { day: 1, retention: 0.5 },
    { day: 7, retention: 0 },
    { day: 30, retention: 0 },
  ]);
  assert.equal(curve.r(7), 0);
  assert.equal(curve.r(30), 0);
  assert.equal(curve.r(90), 0);
  assert.ok(curve.r(3) > 0 && curve.r(3) < 0.5);
  assert.doesNotThrow(() =>
    simulateAll({
      name: "zero",
      alpha: 1,
      anchors: [1, 7, 30].map((day) => ({ day, retention: 0 })),
    }),
  );
  for (const anchors of [
    [
      { day: 1, retention: 0.1 },
      { day: 7, retention: 0.5 },
    ],
    [
      { day: 1, retention: 0.1 },
      { day: 1, retention: 0.1 },
    ],
    [
      { day: 1, retention: NaN },
      { day: 7, retention: 0.1 },
    ],
  ])
    assert.throws(() => fitCurve(anchors));
});
test("锚点修改锁定日期并维持后续单调，支持零", () => {
  const a = moveAnchor(DEFAULT_RETENTION.anchors, 1, 0.1);
  assert.equal(a[0].retention, 0.1);
  assert.ok(a.every((x, i) => i === 0 || x.retention <= a[i - 1].retention));
  const z = moveAnchor(a, 30, 0);
  assert.ok(z.filter((x) => x.day >= 30).every((x) => x.retention === 0));
  assert.equal(
    z.find((x) => x.day === 7).retention,
    a.find((x) => x.day === 7).retention,
  );
});
test("无效金额、概率、周期和原型机制不产生输出", () => {
  for (const delta of [
    { common: { cac: -1 } },
    { unlock: { payerShare: 1.1 } },
    { subscription: { monthlyPrice: Infinity } },
    { hybrid: { switchRate: NaN } },
  ])
    assert.throws(() => simulateAll(DEFAULT_RETENTION, delta));
  assert.throws(() => buildContext(flat, 0));
  assert.throws(() => buildContext({ ...flat, alpha: 0 }));
  assert.throws(() => simulateMechanism("__proto__", ctx, mergeParams()));
});
test("草稿与导出：只存输入，恢复后重算，结果版本和状态可追溯", () => {
  const raw = JSON.stringify({
    version: 1,
    retention: DEFAULT_RETENTION,
    params: DEFAULT_PARAMS,
  });
  const d = decodeDraft(raw);
  assert.ok(d);
  assert.equal(decodeDraft("{bad"), null);
  assert.equal(
    decodeDraft(
      JSON.stringify({
        version: 2,
        retention: DEFAULT_RETENTION,
        params: DEFAULT_PARAMS,
      }),
    ),
    null,
  );
  const sim = simulateAll(d.retention, d.params),
    s = comparisonSnapshot(d.retention, sim);
  assert.equal(s.modelVersion, MODEL_VERSION);
  assert.equal(s.results.hybrid.trace.length, 12);
  assert.match(s.limits.join(" "), /次月/);
  const round = JSON.parse(JSON.stringify(s));
  assert.equal(
    round.results.hybrid.summary.ltv12,
    sim.results.hybrid.summary.ltv12,
  );
});
