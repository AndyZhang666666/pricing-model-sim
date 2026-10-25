// 定价机制模拟器的核心。
//
// ── 统一口径（全项目最重要的一件事）────────────────────────────────
// 三种机制必须在同一个刻度上比较，否则比出来的东西没有意义。这个刻度是：
//
//   revUnit(k) = 一个**新获取的用户**在自己生命周期第 k 个月贡献的收入（已扣平台抽成）
//
// 所有派生指标都从这一个序列长出来：
//   第 m 月累计 ARPU   = Σ_{k=1..m} revUnit(k)          ← 与 CAC 同轴，直接可比
//   12 月 LTV          = Σ_{k=1..12} revUnit(k) / (1+r)^(k-1)
//   回本月份           = 首个累计（折现）ARPU ≥ CAC 的月份
//   第 m 月总收入       = 当月新增用户数 × Σ_{k=1..m} revUnit(k)
//   第 m 月末存量       = 当月新增用户数 × Σ_{k=1..m} S_k
//
// 注意 ARPU 的分母是「当月新增用户」，不是「当月活跃存量」。这是刻意的：
// 只有 cohort 口径的每用户收入才和 CAC 可比。除以活跃存量的那个叫「单位存量
// 变现效率」（stockArpu），也一并算出来，但不用它算回本。
// 这个取舍写在 docs/DECISIONS.md，它是全项目第二容易被搞错的地方。

import {
  fitCurve,
  monthlySurvival,
  subscriberSurvival,
  rateAtMonth,
  DAYS_PER_MONTH,
} from "./retention.js";

export const MECHANISMS = ["unlock", "subscription", "hybrid"];

export const MECHANISM_LABELS = {
  unlock: "单次解锁",
  subscription: "包月订阅",
  hybrid: "混合（免费→解锁→订阅）",
};

export const DEFAULT_PARAMS = {
  common: {
    newUsersPerMonth: 30000,
    cac: 8, // 获客成本，元
    platformCut: 0.3, // 渠道/平台抽成
    discountMonthly: 0, // 月度折现率
  },

  // 单次解锁：按集卖
  unlock: {
    pricePerUnlock: 2.5, // 单集价格，元
    unlocksPerPayerMonth: 10, // 付费用户月均解锁集数
    payerShare: 0.32, // 活跃用户中会付费解锁的比例（首月）
    payerDecay: 0.9, // 付费意愿随月龄衰减：第 k 月 = 首月 × decay^(k-1)
    freeEpisodes: 3, // 免费集数（白嫖期）
    episodesPerMonth: 25, // 活跃用户月均消费集数（含免费），用于把"集"折算成"月"
  },

  // 包月订阅
  subscription: {
    monthlyPrice: 28, // 月费，元
    trialDays: 7, // 免费试用天数
    trialOptIn: 0.5, // 活跃用户中开始试用的比例
    trialToPaid: 0.5, // 试用结束后的付费转化率
  },

  // 混合：免费 → 单次解锁 → 满 X 次推荐订阅
  hybrid: {
    unlockThreshold: 5, // 累计解锁满多少集开始推订阅
    switchRate: 0.25, // 达到门槛后每月转向订阅的比例
    // 切换摩擦：被推订阅的人里，有一部分会因为"又要预扣一笔"而直接弃用。
    // 这一项是让混合机制**可能输**的关键——没有它，混合在数学上恒等于
    // 「解锁收入 + 订阅增量」，永远不可能低于纯解锁，三种机制的对比就退化成两选一。
    switchChurn: 0.35, // 被推荐订阅时，直接流失的比例
  },
};

export const DEFAULT_RETENTION = {
  name: "自定义",
  alpha: 0.85, // 订阅人群相对大盘的粘性指数，见 retention.js subscriberSurvival
  anchors: [
    { day: 1, retention: 0.42 },
    { day: 7, retention: 0.24 },
    { day: 30, retention: 0.12 },
    { day: 90, retention: 0.06 },
    { day: 180, retention: 0.035 },
  ],
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const MODEL_VERSION = "conserved-cohort-v2-2026-10-25";
export function validateParams(params) {
  const ranges = {
    common: {
      newUsersPerMonth: [0, 1e9],
      cac: [0, 1e6],
      platformCut: [0, 1],
      discountMonthly: [0, 1],
    },
    unlock: {
      pricePerUnlock: [0, 1e6],
      unlocksPerPayerMonth: [0, 10000],
      payerShare: [0, 1],
      payerDecay: [0, 1],
      freeEpisodes: [0, 10000],
      episodesPerMonth: [1, 10000],
    },
    subscription: {
      monthlyPrice: [0, 1e6],
      trialDays: [0, 365],
      trialOptIn: [0, 1],
      trialToPaid: [0, 1],
    },
    hybrid: {
      unlockThreshold: [0, 10000],
      switchRate: [0, 1],
      switchChurn: [0, 1],
    },
  };
  for (const [g, fields] of Object.entries(ranges))
    for (const [k, [lo, hi]] of Object.entries(fields))
      if (
        !Number.isFinite(params?.[g]?.[k]) ||
        params[g][k] < lo ||
        params[g][k] > hi
      )
        throw Error(`${g}.${k} 须为 ${lo}–${hi} 的有限数值。`);
}
/** 扫描只覆盖指定字段，其余沿用当前假设，而非退回默认值。 */
export function overrideParams(base, delta) {
  return mergeParams(
    Object.fromEntries(
      Object.keys(DEFAULT_PARAMS).map((g) => [
        g,
        { ...base[g], ...(delta[g] || {}) },
      ]),
    ),
  );
}

/** 把参数对象补全默认值，允许调用方只传想改的那几项。 */
export function mergeParams(overrides = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    out[key] = {
      ...DEFAULT_PARAMS[key],
      ...((overrides && overrides[key]) || {}),
    };
  }
  return out;
}

/**
 * 免费集数 → 白嫖期折算成「月」。
 * 假设活跃用户每月消费 episodesPerMonth 集（含免费），所以 N 集免费 ≈ N/episodesPerMonth 个月。
 * 上限 2 个月：给再多免费集数也不会让白嫖期无限拉长（愿意掏钱的人早晚会掏）。
 * 这是假设不是观测，出处标注见 docs/ASSUMPTIONS.md。
 */
export function freeBlockMonths(unlockParams) {
  const eps = Math.max(1, Number(unlockParams.episodesPerMonth) || 1);
  return Math.min(2, (Number(unlockParams.freeEpisodes) || 0) / eps);
}

/** 曲线 + 两种生存数组，UI 和脚本共用同一份。 */
export function buildContext(retention, horizon = 12) {
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 120)
    throw Error("月度周期须为 1–120 的整数。");
  const curve = fitCurve(retention.anchors);
  const S = monthlySurvival(curve, horizon);
  const Ssub = subscriberSurvival(S, retention.alpha ?? 0.85);
  return { curve, S, Ssub, horizon, retention };
}

// ── 机制 1：单次解锁 ────────────────────────────────────────────────
function runUnlock(ctx, params) {
  const u = params.unlock;
  const keep = 1 - params.common.platformCut;
  const freeBlock = freeBlockMonths(u);

  const revUnit = [];
  let expectedUnlocks = 0;
  let expectedPaidMonths = 0;

  for (let k = 1; k <= ctx.horizon; k++) {
    const stock = ctx.S[k - 1];
    // 付费意愿同时受两件事影响：人还在（stock），以及新用户比老用户更愿意掏钱（decay）
    const payers = stock * u.payerShare * Math.pow(u.payerDecay, k - 1);
    // 白嫖期内解锁收入按比例折算：freeBlock = 0.5 意味着第 1 个月只有半个月的付费窗口
    const window = clamp(k - freeBlock, 0, 1);
    const unlocks = payers * u.unlocksPerPayerMonth * window;

    expectedUnlocks += unlocks;
    if (unlocks > 0) expectedPaidMonths += payers * window; // 每名新增用户的付费窗口期望
    revUnit.push(unlocks * u.pricePerUnlock * keep);
  }

  return { revUnit, metrics: { expectedUnlocks, expectedPaidMonths } };
}

// ── 机制 2：包月订阅 ────────────────────────────────────────────────
function runSubscription(ctx, params) {
  const s = params.subscription;
  const keep = 1 - params.common.platformCut;
  const trialMonths = s.trialDays / DAYS_PER_MONTH;

  const revUnit = [];
  let expectedUnlocks = 0;
  let expectedPaidMonths = 0;

  for (let k = 1; k <= ctx.horizon; k++) {
    // 本月可计费比例：试用期跨月，所以按小数切分（trial = 7 天 → 第 1 个月计 76.7%）
    const billable = clamp(k - trialMonths, 0, 1);
    if (billable <= 0) {
      revUnit.push(0);
      continue;
    }
    // 第几个「付费月」（0-based），用来查订阅人群生存曲线
    const paidIndex = Math.max(0, Math.ceil(k - trialMonths) - 1);
    const survival = ctx.Ssub[Math.min(paidIndex, ctx.Ssub.length - 1)];
    const paying = s.trialOptIn * s.trialToPaid * survival;

    expectedPaidMonths += paying * billable;
    revUnit.push(paying * s.monthlyPrice * keep * billable);
  }

  return { revUnit, metrics: { expectedUnlocks, expectedPaidMonths } };
}

// ── 机制 3：混合（免费 → 单次解锁 → 满 X 次推荐订阅）─────────────────
//
// 这是唯一有真状态机的机制，状态转移只在这里：
//   免费态   k ≤ freeBlock                          收入 0
//   解锁态   从 freeBlock 之后开始，每月解锁 unlocksPerPayerMonth 集
//   订阅态   该 cohort 的**人均**累计解锁 ≥ unlockThreshold 后，
//            每月有 switchRate 比例的解锁用户转入订阅
//
// 这里最容易写错的一点（第一版就写错了）：门槛判断必须用「单个用户的累计解锁集数」，
// 不能用「整个 cohort 的解锁总数」——后者的量纲是人数×集数，量级比阈值大四个数量级，
// 于是所有人第 2 个月就"达标"、或者永远不达标，混合机制静默退化成纯解锁。
//
// 建模假设：转入订阅不再经过试用期；这不是已验证的转化行为。
function runHybrid(ctx, params) {
  const u = params.unlock;
  const s = params.subscription;
  const h = params.hybrid;
  const keep = 1 - params.common.platformCut;
  const freeBlock = freeBlockMonths(u);
  const switchRate = clamp(h.switchRate, 0, 1);
  const switchChurn = clamp(h.switchChurn ?? 0, 0, 1);

  const revUnit = [];
  const switchCohorts = []; // 已转入订阅的批次：{ age, size }
  let remainingUnlockFraction = 1; // 初始解锁人群中尚未分流的条件份额，不是全体新增用户份额
  let cumUnlocksPerUser = 0; // 人均累计解锁集数 ← 门槛判据
  let unlockRevenue = 0;
  let subRevenue = 0;
  let churnedBySwitch = 0;
  let expectedUnlocks = 0,
    expectedPaidMonths = 0,
    movedToSubscription = 0;
  const trace = [];

  for (let k = 1; k <= ctx.horizon; k++) {
    const stock = ctx.S[k - 1];
    const window = clamp(k - freeBlock, 0, 1);

    // 仍在解锁态的人：本来会付费的比例 × 还没离开的比例
    const potential = stock * u.payerShare * Math.pow(u.payerDecay, k - 1);
    const pool = Math.max(0, potential * remainingUnlockFraction);

    // 人均解锁量按付费用户口径累计（pool 里的人每月各解锁 unlocksPerPayerMonth × window 集）
    const unlocksNow = pool * u.unlocksPerPayerMonth * window;
    expectedUnlocks += unlocksNow;
    cumUnlocksPerUser += u.unlocksPerPayerMonth * window;

    const unlockRev = unlocksNow * u.pricePerUnlock * keep;
    unlockRevenue += unlockRev;
    let revenue = unlockRev;

    // 达到门槛后逐月分流到订阅
    let moved = 0,
      churned = 0,
      reached = 0;
    if (
      cumUnlocksPerUser >= h.unlockThreshold &&
      pool > 0 &&
      window > 0 &&
      u.unlocksPerPayerMonth > 0
    ) {
      // 本月离开解锁态的人 = 被推订阅的人，其中一部分转成订阅、一部分直接流失。
      // 两边均从剩余条件份额扣除，已离开的用户不会在后续月份重新出现。
      reached = pool * switchRate;
      moved = reached * (1 - switchChurn);
      churned = reached * switchChurn;
      remainingUnlockFraction *= 1 - switchRate;
      if (moved > 0) switchCohorts.push({ age: k, size: moved });
      churnedBySwitch += churned;
      movedToSubscription += moved;
    }

    // 订阅池：每个转入批次从次月开始按订阅人群生存曲线衰减。
    let subPayers = 0;
    for (const c of switchCohorts) {
      const subAge = k - c.age;
      // 月末切换，下月才开始计订阅；避免同一个月既全额解锁又全额收订阅。
      if (subAge <= 0) continue;
      const survival = ctx.Ssub[Math.min(subAge - 1, ctx.Ssub.length - 1)];
      const rev = c.size * survival * s.monthlyPrice * keep;
      subPayers += c.size * survival;
      expectedPaidMonths += c.size * survival;
      subRevenue += rev;
      revenue += rev;
    }

    revUnit.push(revenue);
    trace.push({
      month: k,
      potential,
      unlockPool: pool,
      unlocks: unlocksNow,
      reached,
      moved,
      churned,
      remainingUnlockFraction,
      subPayers,
      netRevenue: revenue,
    });
  }

  return {
    revUnit,
    metrics: {
      expectedUnlocks,
      expectedPaidMonths,
      unlockRevenue,
      subRevenue,
      churnedBySwitch,
      movedToSubscription,
    },
    trace,
  };
}

const RUNNERS = {
  unlock: runUnlock,
  subscription: runSubscription,
  hybrid: runHybrid,
};

/**
 * 跑一种机制，返回逐月序列 + 汇总。
 *
 * @param {'unlock'|'subscription'|'hybrid'} kind
 * @param {object} ctx    buildContext 的输出
 * @param {object} params mergeParams 的输出
 */
export function simulateMechanism(kind, ctx, params) {
  validateParams(params);
  if (!Object.hasOwn(RUNNERS, kind)) throw new Error(`未知机制：${kind}`);
  const run = RUNNERS[kind];

  const { revUnit, metrics, trace } = run(ctx, params);
  const { common } = params;
  const n = common.newUsersPerMonth;
  const r = common.discountMonthly;
  const keep = 1 - common.platformCut;

  const monthly = [];
  let cumRevenue = 0;

  for (let m = 1; m <= ctx.horizon; m++) {
    // 第 m 月总收入：年龄为 1..m 的所有批次各贡献一份 revUnit
    const revenue = n * revUnit.slice(0, m).reduce((a, b) => a + b, 0);
    const stock = n * ctx.S.slice(0, m).reduce((a, b) => a + b, 0);

    cumRevenue += revenue;
    const arpu = revUnit.slice(0, m).reduce((a, b) => a + b, 0);
    const discountedArpu = revUnit
      .slice(0, m)
      .reduce((a, v, i) => a + v / Math.pow(1 + r, i), 0);

    monthly.push({
      month: m,
      revenue,
      cumRevenue,
      stock,
      arpu,
      discountedArpu,
      stockArpu: stock > 0 ? revenue / stock : 0,
      ltvCac: common.cac > 0 ? discountedArpu / common.cac : null,
    });
  }

  const ltv12 = revUnit.reduce((s, v, i) => s + v / Math.pow(1 + r, i), 0);
  const arpu12 = revUnit.reduce((a, b) => a + b, 0);

  // 回本月份：累计折现收入首次 ≥ CAC 的月份。
  // CAC ≤ 0 时回本这个概念不成立（没有成本要回收），约定记为 null 而不是第 1 个月，
  // 否则 UI 上会显示「第 1 个月回本」，看起来像算出来的结论。
  let acc = 0;
  let paybackMonth = null;
  if (common.cac > 0) {
    for (let k = 0; k < revUnit.length; k++) {
      acc += revUnit[k] / Math.pow(1 + r, k);
      if (acc >= common.cac) {
        paybackMonth = k + 1;
        break;
      }
    }
  }

  const summary = {
    kind,
    label: MECHANISM_LABELS[kind],
    ltv12,
    arpu12,
    cac: common.cac,
    ltvCac: common.cac > 0 ? ltv12 / common.cac : null,
    paybackMonth,
    // 12 个月累计总收入（所有批次、所有月份加总）。注意它不等于「第 12 个月单月收入」，
    // 两者相差一个数量级，命名上刻意区分：cumRevenue12 vs monthly[].revenue。
    cumRevenue12: cumRevenue,
    stock12: monthly[monthly.length - 1].stock,
    expectedUnlocks: metrics.expectedUnlocks,
    expectedPaidMonths: metrics.expectedPaidMonths,
    unlockRevenue:
      metrics.unlockRevenue ?? (kind === "unlock" ? arpu12 : undefined),
    subRevenue: metrics.subRevenue,
    churnedBySwitch: metrics.churnedBySwitch,
    movedToSubscription: metrics.movedToSubscription,
  };

  return { revUnit, monthly, summary, ...(trace ? { trace } : {}) };
}

/** 一次跑完三种机制。 */
export function simulateAll(retention, paramOverrides = {}) {
  const params = mergeParams(paramOverrides);
  const ctx = buildContext(retention, 12);
  const results = {};
  for (const kind of MECHANISMS) {
    results[kind] = simulateMechanism(kind, ctx, params);
  }
  return {
    modelVersion: MODEL_VERSION,
    ctx,
    params,
    results,
    verdict: buildVerdict(ctx, params, results),
  };
}

/**
 * 结论卡：从数据里推出「谁更优、从第几个月开始、为什么」。
 *
 * 刻意不写模板句。理由必须落到两个可核算的量上：
 *   订阅口径 —— 期望付费月数 × 月费
 *   解锁口径 —— 期望解锁集数 × 单集价格
 * 谁大谁小是算出来的，不是写死的。
 */
export function buildVerdict(ctx, params, results) {
  const ranked = MECHANISMS.map((k) => results[k].summary).sort(
    (a, b) => b.ltv12 - a.ltv12,
  );

  const winner = ranked[0];
  const runnerUp = ranked[1];
  const tiedWinners = ranked
    .filter((r) => Math.abs(r.ltv12 - winner.ltv12) < 1e-9)
    .map((r) => r.kind);
  const tie = tiedWinners.length > 1;
  const keep = 1 - params.common.platformCut;

  // 谁从第几个月开始领先：比较赢家与第二名的逐月累计 ARPU
  let crossoverMonth = null;
  const wMonthly = results[winner.kind].monthly;
  const rMonthly = results[runnerUp.kind].monthly;
  for (let i = 1; i < wMonthly.length; i++) {
    if (
      wMonthly[i].discountedArpu > rMonthly[i].discountedArpu &&
      wMonthly[i - 1].discountedArpu <= rMonthly[i - 1].discountedArpu
    ) {
      crossoverMonth = wMonthly[i].month;
      break;
    }
  }

  const d30 = rateAtMonth(ctx.curve, 2); // S_2 = r(30)
  const subPaidMonths =
    Math.round(results.subscription.summary.expectedPaidMonths * 10) / 10;
  const subValue =
    results.subscription.summary.expectedPaidMonths *
    params.subscription.monthlyPrice *
    keep;
  const unlockCount =
    Math.round(results.unlock.summary.expectedUnlocks * 10) / 10;
  const unlockValue =
    results.unlock.summary.expectedUnlocks *
    params.unlock.pricePerUnlock *
    keep;
  const hybridUnlockCount = Number(
    results.hybrid.summary.expectedUnlocks.toFixed(1),
  );
  const hybridPaidMonths = Number(
    results.hybrid.summary.expectedPaidMonths.toFixed(1),
  );

  const margin =
    runnerUp.ltv12 > 0
      ? (winner.ltv12 / runnerUp.ltv12 - 1) * 100
      : winner.ltv12 > 0
        ? null
        : 0;
  const alpha = ctx.retention.alpha ?? 0.85;

  let reason;
  if (winner.kind === "subscription") {
    reason =
      `订阅粘性指数按 α = ${alpha} 假设。每名新增用户在 12 个月内期望贡献订阅付费 ${subPaidMonths} 个月，` +
      `未折现渠道净收入 ¥${subValue.toFixed(1)}；纯解锁对应 ¥${unlockValue.toFixed(1)}。` +
      `这是本组价格、转化和留存假设的共同结果，不代表订阅天然更好。`;
  } else if (winner.kind === "unlock") {
    reason =
      `每名新增用户在 12 个月内期望解锁 ${unlockCount} 集，未折现渠道净收入 ¥${unlockValue.toFixed(1)}。` +
      `订阅对应 ${subPaidMonths} 个付费月、¥${subValue.toFixed(1)}。` +
      `当前排序仅在本组假设下成立，不能单独归因给留存或据此直接调价。`;
  } else {
    reason =
      `混合机制下，每名新增用户在 12 个月内期望解锁 ${hybridUnlockCount.toFixed(1)} 集、` +
      `贡献订阅付费 ${hybridPaidMonths.toFixed(1)} 个月，与下表的混合机制口径一致。` +
      `转订阅门槛为 ${params.hybrid.unlockThreshold} 集；当前优势依赖设定的转化、留存和切换摩擦，并非实测增长。`;
  }

  const allLead = wMonthly.every(
    (w, i) => w.discountedArpu > rMonthly[i].discountedArpu + 1e-9,
  );
  const sustained =
    crossoverMonth &&
    wMonthly
      .slice(crossoverMonth - 1)
      .every(
        (w, j) =>
          w.discountedArpu >
          rMonthly[crossoverMonth - 1 + j].discountedArpu + 1e-9,
      );
  const crossoverText = tie
    ? "12 个月 LTV 存在并列，不强行选唯一赢家"
    : allLead
      ? `${winner.label}在每个月的累计折现贡献都高于${runnerUp.label}`
      : sustained
        ? `${winner.label}从第 ${crossoverMonth} 月起持续超过${runnerUp.label}`
        : "逐月累计折现贡献的领先关系并非始终一致，请核对曲线";

  return {
    winner: winner.kind,
    winnerLabel: winner.label,
    runnerUp: runnerUp.kind,
    runnerUpLabel: runnerUp.label,
    coverage: crossoverText,
    crossoverMonth,
    margin,
    tie,
    tiedWinners,
    reason,
    d30,
    numbers: {
      subPaidMonths,
      subValue,
      unlockCount,
      unlockValue,
      hybridUnlockCount,
      hybridPaidMonths,
      winnerLtv: winner.ltv12,
      runnerUpLtv: runnerUp.ltv12,
    },
  };
}
