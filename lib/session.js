import {
  DEFAULT_PARAMS,
  mergeParams,
  simulateAll,
  MODEL_VERSION,
} from "./model.js";
import { ANCHOR_DAYS } from "./retention.js";
export const DRAFT_KEY = "pricing-model:assumptions:v1";
export function decodeDraft(raw) {
  try {
    if (!raw || raw.length > 16000) return null;
    const d = JSON.parse(raw);
    if (
      d.version !== 1 ||
      !d.params ||
      !d.retention ||
      (d.retention.name !== undefined &&
        (typeof d.retention.name !== "string" || d.retention.name.length > 160))
    )
      return null;
    const p = mergeParams(d.params),
      params = Object.fromEntries(
        Object.entries(DEFAULT_PARAMS).map(([g, fields]) => [
          g,
          Object.fromEntries(Object.keys(fields).map((k) => [k, p[g][k]])),
        ]),
      );
    const retention = {
      name: d.retention.name ?? "案例假设",
      alpha: d.retention.alpha,
      anchors: d.retention.anchors.map((a) => ({
        day: a.day,
        retention: a.retention,
      })),
    };
    if (
      retention.alpha < 0.2 ||
      retention.alpha > 1 ||
      retention.anchors.length !== 5 ||
      retention.anchors.some((a, i) => a.day !== ANCHOR_DAYS[i])
    )
      return null;
    const bounds = {
      common: {
        newUsersPerMonth: [1000, 200000],
        cac: [0, 40],
        platformCut: [0, 1],
        discountMonthly: [0, 0.05],
      },
      unlock: {
        pricePerUnlock: [0, 10],
        unlocksPerPayerMonth: [0, 40],
        payerShare: [0, 1],
        payerDecay: [0.5, 1],
        freeEpisodes: [0, 30],
      },
      subscription: {
        monthlyPrice: [0, 80],
        trialDays: [0, 30],
        trialOptIn: [0, 1],
        trialToPaid: [0, 1],
      },
      hybrid: {
        unlockThreshold: [0, 20],
        switchRate: [0, 1],
        switchChurn: [0, 1],
      },
    };
    for (const [g, fields] of Object.entries(bounds))
      for (const [k, [lo, hi]] of Object.entries(fields))
        if (params[g][k] < lo || params[g][k] > hi) return null;
    simulateAll(retention, params);
    return { retention, params };
  } catch {
    return null;
  }
}
export function comparisonSnapshot(retention, sim) {
  if (!sim.results || sim.error) throw Error("没有有效比较可以导出。");
  return {
    schemaVersion: 1,
    kind: "pricing-assumption-comparison",
    modelVersion: MODEL_VERSION,
    retention,
    params: sim.params,
    curve: {
      model: sim.ctx.curve.model,
      formula: sim.ctx.curve.formula,
      anchors: sim.ctx.curve.anchors,
    },
    results: sim.results,
    verdict: sim.verdict,
    limits: [
      "合成或用户输入假设，不是实测收益或最优定价建议。",
      "按每名新增用户归一化，渠道收入尚未扣除履约、研发等成本。",
      "混合机制月末切换，次月开始订阅收费。",
      "价格变化不会自动改变转化率和留存，弹性与选择效应尚未校准。",
      "敏感性扫描一次覆盖一个字段，其余保持当前值；边界只是模型条件下的切换。",
    ],
  };
}
