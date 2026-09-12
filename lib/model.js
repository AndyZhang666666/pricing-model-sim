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
    newUsersPerMonth: 10000,
    cac: 18, // 获客成本，元
    platformCut: 0.3, // 渠道/平台抽成
    discountMonthly: 0, // 月度折现率
  },

  // 单次解锁：按集卖
  unlock: {
    pricePerUnlock: 1.2, // 单集价格，元
    unlocksPerPayerMonth: 4.5, // 付费用户月均解锁集数
    payerShare: 0.32, // 活跃用户中会付费解锁的比例（首月）
    payerDecay: 0.88, // 付费意愿随月龄衰减：第 k 月 = 首月 × decay^(k-1)
    freeEpisodes: 3, // 免费集数（白嫖期）
    episodesPerMonth: 25, // 活跃用户月均消费集数（含免费），用于把"集"折算成"月"
  },

  // 包月订阅
  subscription: {
    monthlyPrice: 28, // 月费，元
    trialDays: 7, // 免费试用天数
    trialOptIn: 0.55, // 活跃用户中开始试用的比例
    trialToPaid: 0.35, // 试用结束后的付费转化率
  },

  // 混合：免费 → 单次解锁 → 满 X 次推荐订阅
  hybrid: {
    unlockThreshold: 6, // 累计解锁满多少集开始推订阅
    switchRate: 0.18, // 达到门槛后每月转向订阅的比例
  },
};

export const DEFAULT_RETENTION = {
  name: "自定义",
  alpha: 0.6, // 订阅人群相对大盘的粘性指数，见 retention.js subscriberSurvival
  anchors: [
    { day: 1, retention: 0.42 },
    { day: 7, retention: 0.24 },
    { day: 30, retention: 0.12 },
    { day: 90, retention: 0.06 },
    { day: 180, retention: 0.035 },
  ],
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 把参数对象补全默认值，允许调用方只传想改的那几项。 */
export function mergeParams(overrides = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    out[key] = { ...DEFAULT_PARAMS[key], ...((overrides && overrides[key]) || {}) };
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
  const curve = fitCurve(retention.anchors);
  const S = monthlySurvival(curve, horizon);
  const Ssub = subscriberSurvival(S, retention.alpha ?? 0.6);
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
    if (unlocks > 0) expectedPaidMonths += window; // 有付费窗口的月数，按比例计
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
//   免费态   k ≤ freeBlock        收入 0
//   解锁态   从 freeBlock 之后开始，每月解锁 unlocksPerPayerMonth 集
//   订阅态   累计解锁 ≥ unlockThreshold 后，每月有 switchRate 比例的解锁用户转入订阅
// 转入订阅不再走试用期——他们用累计解锁已经证明了付费意愿，再给试用是白送。
function runHybrid(ctx, params) {
  const u = params.unlock;
  const s = params.subscription;
  const h = params.hybrid;
  const keep = 1 - params.common.platformCut;
  const freeBlock = freeBlockMonths(u);

  const revUnit = [];
  const switchCohorts = []; // 已转入订阅的批次：{ age, size }
  let switchedShare = 0; // 累计转走的人占潜在付费盘子的比例
  let cumUnlocks = 0; // 该 cohort 人均累计解锁集数
  let unlockRevenue = 0;
  let subRevenue = 0;

  for (let k = 1; k <= ctx.horizon; k++) {
    const stock = ctx.S[k - 1];
    const window = clamp(k - freeBlock, 0, 1);

    // 仍在解锁态的人：本来会付费的比例 × 还没转走的比例
    const potential = stock * u.payerShare * Math.pow(u.payerDecay, k - 1);
    const pool = Math.max(0, potential * (1 - switchedShare));

    const unlocksNow = pool * u.unlocksPerPayerMonth * window;
    cumUnlocks += unlocksNow;
    const unlockRev = unlocksNow * u.pricePerUnlock * keep;
    unlockRevenue += unlockRev;
    let revenue = unlockRev;

    // 达到门槛后逐月分流到订阅
    if (cumUnlocks >= h.unlockThreshold && pool > 0) {
      const moved = pool * clamp(h.switchRate, 0, 1);
      switchedShare = clamp(switchedShare + clamp(h.switchRate, 0, 1) * (1 - switchedShare), 0, 1);
      switchCohorts.push({ age: k, size: moved });
    }

    // 订阅池：每个转入批次按订阅人群生存曲线衰减（转入当月 subAge = 0 → 生存率 1）
    for (const c of switchCohorts) {
      const subAge = k - c.age;
      const survival = ctx.Ssub[Math.min(subAge, ctx.Ssub.length - 1)];
      const rev = c.size * survival * s.monthlyPrice * keep;
      subRevenue += rev;
      revenue += rev;
    }

    revUnit.push(revenue);
  }

  return {
    revUnit,
    metrics: {
      expectedUnlocks: keep > 0 ? unlockRevenue / (u.pricePerUnlock * keep) : 0,
      expectedPaidMonths: keep > 0 ? subRevenue / (s.monthlyPrice * keep) : 0,
      unlockRevenue,
      subRevenue,
    },
  };
}

const RUNNERS = { unlock: runUnlock, subscription: runSubscription, hybrid: runHybrid };

/**
 * 跑一种机制，返回逐月序列 + 汇总。
 *
 * @param {'unlock'|'subscription'|'hybrid'} kind
 * @param {object} ctx    buildContext 的输出
 * @param {object} params mergeParams 的输出
 */
export function simulateMechanism(kind, ctx, params) {
  const run = RUNNERS[kind];
  if (!run) throw new Error(`未知机制：${kind}`);

  const { revUnit, metrics } = run(ctx, params);
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

    monthly.push({
      month: m,
      revenue,
      cumRevenue,
      stock,
      arpu,
      stockArpu: stock > 0 ? revenue / stock : 0,
      ltvCac: common.cac > 0 ? arpu / common.cac : null,
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
    unlockRevenue: metrics.unlockRevenue ?? (kind === "unlock" ? arpu12 : undefined),
    subRevenue: metrics.subRevenue,
  };

  return { revUnit, monthly, summary };
}

/** 一次跑完三种机制。 */
export function simulateAll(retention, paramOverrides = {}) {
  const params = mergeParams(paramOverrides);
  const ctx = buildContext(retention, 12);
  const results = {};
  for (const kind of MECHANISMS) {
    results[kind] = simulateMechanism(kind, ctx, params);
  }
  return { ctx, params, results, verdict: buildVerdict(ctx, params, results) };
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
  const ranked = MECHANISMS
    .map((k) => results[k].summary)
    .sort((a, b) => b.ltv12 - a.ltv12);

  const winner = ranked[0];
  const runnerUp = ranked[1];
  const keep = 1 - params.common.platformCut;

  // 谁从第几个月开始领先：比较赢家与第二名的逐月累计 ARPU
  let crossoverMonth = null;
  const wMonthly = results[winner.kind].monthly;
  const rMonthly = results[runnerUp.kind].monthly;
  for (let i = 1; i < wMonthly.length; i++) {
    if (wMonthly[i].arpu > rMonthly[i].arpu && wMonthly[i - 1].arpu <= rMonthly[i - 1].arpu) {
      crossoverMonth = wMonthly[i].month;
      break;
    }
  }

  const d30 = rateAtMonth(ctx.curve, 2); // S_2 = r(30)
  const subPaidMonths = Math.round(results.subscription.summary.expectedPaidMonths * 10) / 10;
  const subValue = subPaidMonths * params.subscription.monthlyPrice * keep;
  const unlockCount = Math.round(results.unlock.summary.expectedUnlocks * 10) / 10;
  const unlockValue = unlockCount * params.unlock.pricePerUnlock * keep;

  const margin = runnerUp.ltv12 > 0 ? (winner.ltv12 / runnerUp.ltv12 - 1) * 100 : 0;
  const alpha = ctx.retention.alpha ?? 0.6;

  let reason;
  if (winner.kind === "subscription") {
    reason =
      `订阅人群比大盘粘（粘性指数 α = ${alpha}），12 个月内期望付费 ${subPaidMonths} 个月，` +
      `折 ¥${subValue.toFixed(1)}；同样这批人走单次解锁只贡献 ¥${unlockValue.toFixed(1)}。` +
      `在 D30 = ${(d30 * 100).toFixed(1)}% 这条曲线上，订阅的续费把长尾接住了，解锁的付费意愿到后面衰减太快。`;
  } else if (winner.kind === "unlock") {
    reason =
      `这条曲线 D30 只有 ${(d30 * 100).toFixed(1)}%，订阅者没付几个月就流失了：` +
      `12 个月内期望付费仅 ${subPaidMonths} 个月（¥${subValue.toFixed(1)}），` +
      `而单次解锁在流失前就能收到 ${unlockCount} 集，折 ¥${unlockValue.toFixed(1)}。` +
      `留存撑不起订阅，先按集收钱更划算。`;
  } else {
    reason =
      `混合的优势来自分层：低意愿用户按集付费（12 个月累计 ${unlockCount} 集），` +
      `高意愿用户在累计解锁满 ${params.hybrid.unlockThreshold} 集后被分流到订阅，` +
      `期望付费 ${subPaidMonths} 个月。单押一边都会漏掉另一边的钱。`;
  }

  const crossoverText = crossoverMonth
    ? `${winner.label}在第 ${crossoverMonth} 个月开始反超${runnerUp.label}`
    : `${winner.label}从第 1 个月起就一路领先${runnerUp.label}`;

  return {
    winner: winner.kind,
    winnerLabel: winner.label,
    runnerUp: runnerUp.kind,
    runnerUpLabel: runnerUp.label,
    coverage: crossoverText,
    crossoverMonth,
    margin,
    reason,
    d30,
    numbers: { subPaidMonths, subValue, unlockCount, unlockValue, winnerLtv: winner.ltv12, runnerUpLtv: runnerUp.ltv12 },
  };
}
