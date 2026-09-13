// 校验 3/3：敏感性扫描。
//
// 回答商业化 PM 最常被追问的那个问题：「这个定价的临界点在哪」。
// 做法：对三条预设曲线，各扫一遍「月费」和「免费集数」，记录每个取值上
// 三种机制谁赢，以及「最优机制」在哪个值上发生切换。
//
// 用法：npm run sweep      → results/sweep.json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeParams, buildContext, simulateMechanism, MECHANISMS } from "../lib/model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const presets = JSON.parse(readFileSync(resolve(ROOT, "data/presets.json"), "utf8"));

// 扫描用的基准参数：与 DEFAULT_PARAMS 一致，只改被扫的那一项。
const BASE = {
  common: { newUsersPerMonth: 30000, cac: 8, platformCut: 0.3, discountMonthly: 0 },
};

// 扫描时统一的订阅人群粘性指数。与 DEFAULT_RETENTION.alpha 保持一致。
const SWEEP_ALPHA = 0.85;

// 把 base 的锚点应用到三套机制参数上（三种机制共用同一组商业参数，只有定价项不同）
function baseParams(overrides = {}) {
  return mergeParams({
    common: { ...BASE.common, ...(overrides.common || {}) },
    unlock: overrides.unlock || {},
    subscription: overrides.subscription || {},
    hybrid: overrides.hybrid || {},
  });
}

function runAll(retention, params) {
  const ctx = buildContext({ ...retention, alpha: retention.alpha ?? SWEEP_ALPHA }, 12);
  const out = {};
  for (const kind of MECHANISMS) {
    out[kind] = simulateMechanism(kind, ctx, params).summary;
  }
  return out;
}

function rank(runs) {
  return MECHANISMS.slice().sort((a, b) => runs[b].ltv12 - runs[a].ltv12);
}

function linspace(from, to, count) {
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, i) => Number((from + i * step).toPrecision(6)));
}

// ── 扫描 1：月费 ────────────────────────────────────────────────────
// 月费只影响订阅和混合，解锁不动。扫到足够高就能看出订阅什么时候反超。
function sweepMonthlyPrice(preset) {
  const values = linspace(4, 120, 30);
  const rows = values.map((price) => {
    const params = baseParams({ subscription: { monthlyPrice: price }, hybrid: {} });
    const runs = runAll(preset, params);
    const order = rank(runs);
    return {
      price,
      ltv: {
        unlock: runs.unlock.ltv12,
        subscription: runs.subscription.ltv12,
        hybrid: runs.hybrid.ltv12,
      },
      winner: order[0],
      // 次优机制，用来看切换发生时跟谁换手
      runnerUp: order[1],
    };
  });

  // 找切换点：winner 发生变化的相邻两行之间
  const switches = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].winner !== rows[i - 1].winner) {
      switches.push({
        between: [rows[i - 1].price, rows[i].price],
        from: rows[i - 1].winner,
        to: rows[i].winner,
      });
    }
  }

  // 精确二分：把切换点收敛到 ±0.5 元
  const refined = switches.map((s) => {
    let lo = s.between[0];
    let hi = s.between[1];
    const winnerAt = (p) => rank(runAll(preset, baseParams({ subscription: { monthlyPrice: p } })))[0];
    for (let iter = 0; iter < 30 && hi - lo > 0.5; iter++) {
      const mid = (lo + hi) / 2;
      if (winnerAt(mid) === s.to) hi = mid;
      else lo = mid;
    }
    return { ...s, threshold: Number(((lo + hi) / 2).toPrecision(5)) };
  });

  return { values, rows, switches: refined };
}

// ── 扫描 2：免费集数 ────────────────────────────────────────────────
// 免费集数同时影响解锁（白嫖期变长 → 解锁收入推迟）和混合（解锁段整体推后）。
// 扫它能看到「给多少免费才不算白送」。
function sweepFreeEpisodes(preset) {
  const values = linspace(0, 30, 16);
  const rows = values.map((free) => {
    const params = baseParams({ unlock: { freeEpisodes: free }, hybrid: {} });
    const runs = runAll(preset, params);
    const order = rank(runs);
    return {
      freeEpisodes: free,
      freeBlockMonths: Math.min(2, free / 25),
      ltv: {
        unlock: runs.unlock.ltv12,
        subscription: runs.subscription.ltv12,
        hybrid: runs.hybrid.ltv12,
      },
      winner: order[0],
      runnerUp: order[1],
    };
  });

  const switches = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].winner !== rows[i - 1].winner) {
      switches.push({
        between: [rows[i - 1].freeEpisodes, rows[i].freeEpisodes],
        from: rows[i - 1].winner,
        to: rows[i].winner,
      });
    }
  }

  return { values, rows, switches };
}

// ── 扫描 3：D30 留存 ────────────────────────────────────────────────
// 这是全项目最有解释力的一张图：留存低的时候解锁赢、留存高的时候订阅赢，
// 交叉点就是「该不该转订阅」的判断线。
//
// 做法：固定 D1 和 D180 不变，把 D7/D30/D90 按同一比例缩放，
// 使曲线整体上下平移而形态不变。
//
// 目标 D30 从 baseD30 的 0.4 倍扫到 D1 的 0.9 倍。范围刻意开得宽：
// 低端要能扫到「三种机制都回不了本」的区域，高端要能扫到「订阅明显反超」的区域，
// 切换点必须落在范围内部，否则敏感性页没东西可讲。
function sweepD30(preset) {
  const baseAnchors = preset.anchors;
  const d1 = baseAnchors.find((a) => a.day === 1).retention;
  const baseD30 = baseAnchors.find((a) => a.day === 30).retention;

  const values = linspace(baseD30 * 0.4, Math.min(d1 * 0.9, baseD30 * 4), 25);

  const rows = values.map((targetD30) => {
    const scale = targetD30 / baseD30;
    const anchors = baseAnchors.map((a) =>
      a.day === 1
        ? a
        : { day: a.day, retention: Math.min(d1, a.retention * scale) },
    );
    const params = baseParams();
    const runs = runAll({ ...preset, anchors }, params);
    const order = rank(runs);
    return {
      d30: targetD30,
      ltv: {
        unlock: runs.unlock.ltv12,
        subscription: runs.subscription.ltv12,
        hybrid: runs.hybrid.ltv12,
      },
      winner: order[0],
      runnerUp: order[1],
    };
  });

  const switches = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].winner !== rows[i - 1].winner) {
      switches.push({
        between: [rows[i - 1].d30, rows[i].d30],
        from: rows[i - 1].winner,
        to: rows[i].winner,
      });
    }
  }

  // 二分精确化切换点
  const refined = switches.map((s) => {
    const evalAt = (d30) => {
      const scale = d30 / baseD30;
      const anchors = baseAnchors.map((a) =>
        a.day === 1 ? a : { day: a.day, retention: Math.min(d1, a.retention * scale) },
      );
      return rank(runAll({ ...preset, anchors }, baseParams()))[0];
    };
    let lo = s.between[0];
    let hi = s.between[1];
    for (let iter = 0; iter < 30 && hi - lo > 1e-5; iter++) {
      const mid = (lo + hi) / 2;
      if (evalAt(mid) === s.to) hi = mid;
      else lo = mid;
    }
    return { ...s, threshold: Number(((lo + hi) / 2).toPrecision(6)) };
  });

  return { values, rows, switches: refined };
}

// ── 扫描 4：切换摩擦（subscription 转化率）──────────────────────────
// 这是全项目最诚实的一张图：把「订阅推荐能不能打动人」从极差扫到极好。
// 转化极差时纯解锁赢（因为订阅白搭一个推荐位、还把用户吓跑一部分），
// 转化好时订阅赢。中间那段就是「该不该上订阅」的真实决策区间。
//
// 为什么单独扫这个而不是扫 trialToPaid：trialToPaid 只影响订阅单押，
// 而真实产品里「用户对订阅的接受度」同时决定了混合机制的分流效果，
// 所以这里把它作为统一的自变量。
function sweepSubscriptionFriction(preset) {
  const values = linspace(0.08, 0.75, 20);
  const rows = values.map((conv) => {
    // 只扫试用转化率。分流率 switchRate 保持默认不动——分流率由产品设计决定
    // （推荐位放在哪、推得凶不凶），不是用户对订阅的态度决定的。刻意不联动，
    // 避免把两个不同的东西揉成一个参数。
    const runs = runAll(preset, baseParams({ subscription: { trialToPaid: conv } }));
    const order = rank(runs);
    return {
      trialToPaid: conv,
      ltv: {
        unlock: runs.unlock.ltv12,
        subscription: runs.subscription.ltv12,
        hybrid: runs.hybrid.ltv12,
      },
      winner: order[0],
      runnerUp: order[1],
    };
  });

  const switches = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].winner !== rows[i - 1].winner) {
      switches.push({
        between: [rows[i - 1].trialToPaid, rows[i].trialToPaid],
        from: rows[i - 1].winner,
        to: rows[i].winner,
      });
    }
  }

  const refined = switches.map((s) => {
    const evalAt = (v) => rank(runAll(preset, baseParams({ subscription: { trialToPaid: v } })))[0];
    let lo = s.between[0];
    let hi = s.between[1];
    for (let iter = 0; iter < 30 && hi - lo > 1e-4; iter++) {
      const mid = (lo + hi) / 2;
      if (evalAt(mid) === s.to) hi = mid;
      else lo = mid;
    }
    return { ...s, threshold: Number(((lo + hi) / 2).toPrecision(5)) };
  });

  return { values, rows, switches: refined };
}

// ── 扫描 5：切换摩擦（把用户推去订阅会流失多少）──────────────────────
// 这张图回答「混合机制什么时候不值得做」。
// 混合在数学上是纯解锁的超集（解锁收入 + 订阅增量），所以它几乎总是 ≥ 纯解锁；
// 唯一能让它输的，就是把用户推去订阅这个动作本身有代价——一部分人会被预扣费
// 反感直接走掉。摩擦大到一定程度，纯解锁反而更稳。
function sweepSwitchChurn(preset) {
  const values = linspace(0, 0.9, 19);
  const rows = values.map((churn) => {
    const runs = runAll(preset, baseParams({ hybrid: { switchChurn: churn } }));
    const order = rank(runs);
    return {
      switchChurn: churn,
      ltv: {
        unlock: runs.unlock.ltv12,
        subscription: runs.subscription.ltv12,
        hybrid: runs.hybrid.ltv12,
      },
      winner: order[0],
      runnerUp: order[1],
    };
  });

  const switches = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].winner !== rows[i - 1].winner) {
      switches.push({
        between: [rows[i - 1].switchChurn, rows[i].switchChurn],
        from: rows[i - 1].winner,
        to: rows[i].winner,
      });
    }
  }

  const refined = switches.map((s) => {
    const evalAt = (v) => rank(runAll(preset, baseParams({ hybrid: { switchChurn: v } })))[0];
    let lo = s.between[0];
    let hi = s.between[1];
    for (let iter = 0; iter < 30 && hi - lo > 1e-4; iter++) {
      const mid = (lo + hi) / 2;
      if (evalAt(mid) === s.to) hi = mid;
      else lo = mid;
    }
    return { ...s, threshold: Number(((lo + hi) / 2).toPrecision(5)) };
  });

  return { values, rows, switches: refined };
}

// ── 主流程 ──────────────────────────────────────────────────────────
const output = {
  generatedBy: "scripts/sweep.mjs",
  // 只记录日期：这些产物是确定性的（没有随机数），秒级时间戳只会让每次重跑产生
  // 一行无意义的 git diff，掩盖真正的数据变化。
  generatedAt: new Date().toISOString().slice(0, 10),
  baseParams: BASE,
  presets: [],
};

for (const preset of presets.presets) {
  const byPrice = sweepMonthlyPrice(preset);
  const byFree = sweepFreeEpisodes(preset);
  const byD30 = sweepD30(preset);
  const byFriction = sweepSubscriptionFriction(preset);
  const byChurn = sweepSwitchChurn(preset);

  // 基准点（默认参数）下的结论，用来说明「这张图的原点在哪」
  const base = runAll(preset, baseParams());
  const baseOrder = rank(base);

  output.presets.push({
    id: preset.id,
    name: preset.name,
    d30: preset.anchors.find((a) => a.day === 30).retention,
    baseline: {
      ltv: {
        unlock: base.unlock.ltv12,
        subscription: base.subscription.ltv12,
        hybrid: base.hybrid.ltv12,
      },
      winner: baseOrder[0],
      runnerUp: baseOrder[1],
      paybackMonth: {
        unlock: base.unlock.paybackMonth,
        subscription: base.subscription.paybackMonth,
        hybrid: base.hybrid.paybackMonth,
      },
      ltvCac: {
        unlock: base.unlock.ltvCac,
        subscription: base.subscription.ltvCac,
        hybrid: base.hybrid.ltvCac,
      },
    },
    monthlyPriceSweep: byPrice,
    freeEpisodesSweep: byFree,
    d30Sweep: byD30,
    frictionSweep: byFriction,
    switchChurnSweep: byChurn,
  });

  console.log(`\n${preset.name}`);
  console.log(
    `  基准：${baseOrder.map((k, i) => `${i + 1}.${k} ${base[k].ltv12.toFixed(2)}`).join("  ")}`,
  );
  for (const s of byPrice.switches) {
    console.log(`  月费 ¥${s.threshold} 处：${s.from} → ${s.to}`);
  }
  for (const s of byD30.switches) {
    console.log(`  D30 ${(s.threshold * 100).toFixed(2)}% 处：${s.from} → ${s.to}`);
  }
  for (const s of byFree.switches) {
    console.log(`  免费 ${s.between[0]}~${s.between[1]} 集处：${s.from} → ${s.to}`);
  }
  for (const s of byFriction.switches) {
    console.log(`  订阅转化率 ${(s.threshold * 100).toFixed(1)}% 处：${s.from} → ${s.to}`);
  }
  for (const s of byChurn.switches) {
    console.log(`  切换摩擦 ${(s.threshold * 100).toFixed(1)}% 处：${s.from} → ${s.to}`);
  }
}

mkdirSync(resolve(ROOT, "results"), { recursive: true });
writeFileSync(resolve(ROOT, "results/sweep.json"), JSON.stringify(output, null, 2) + "\n");
console.log("\n已写出 results/sweep.json");
