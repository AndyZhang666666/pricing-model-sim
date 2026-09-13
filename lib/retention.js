// 留存曲线的表示、拟合，以及从留存推导月库存量。
//
// 一个 curve 对象是若干纯函数的集合：
//   curve.r(day)       → 注册后第 day 天仍在册的比例，r(0) = 1
//   curve.formula      → 给人看的拟合公式字符串
//   curve.rmse         → 拟合残差（百分点），越小越贴合锚点
//   curve.residuals    → 每个锚点的「实测 / 拟合 / 偏差」，UI 直接展示
//
// 月网格约定（全项目唯一口径，改这里等于改全部）：
//   第 k 个月的「月初在册比例」S_k = r(30 × (k − 1))，k = 1, 2, 3, ...
//   S₁ = r(0) = 1     新用户当月必然在册
//   S₂ = r(30)        = D30 留存
//   S₃ = r(60)
// 即：不按月内按天积分，用月初值代表该月整月的在册比例。这个口径让所有手算
// 校验都能对得上（见 scripts/test-model.mjs：留存恒为 100% 时 S_k ≡ 1），
// 代价是月内波动被抹平。取舍理由写在 docs/DECISIONS.md。

export const ANCHOR_DAYS = [1, 7, 30, 90, 180];

export const DAYS_PER_MONTH = 30;

/** 第 k 个月的月初在册比例。k ≥ 1，S₁ = r(0) = 1（新用户当月必然在册）。 */
export function rateAtMonth(curve, k) {
  if (k <= 1) return 1;
  return curve.r((k - 1) * DAYS_PER_MONTH);
}

/** 前 horizon 个月的月初在册比例数组，下标 0 对应第 1 个月。 */
export function monthlySurvival(curve, horizon) {
  const out = [];
  for (let k = 1; k <= horizon; k++) out.push(rateAtMonth(curve, k));
  return out;
}

/** 普通最小二乘的斜率。pts = [[x, y], ...] */
function olsSlope(pts) {
  const n = pts.length;
  if (n < 2) return 0;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function rmseOf(anchors, f) {
  if (anchors.length === 0) return 0;
  const sum = anchors.reduce((s, a) => s + (f(a.day) - a.retention) ** 2, 0);
  return Math.sqrt(sum / anchors.length) * 100; // 百分点
}

/**
 * 用锚点拟合留存曲线。
 *
 * 两种候选形式（决定曲线**形态**与 D180 之后的**尾部外推**）：
 *   幂律   r(d) = r₁ × d^(−b)          内容/社交类的主流形态：早期掉得快、长尾薄
 *   指数   r(d) = r₁ × exp(−λ(d−1))    工具类更常见：每月按固定比例流失，没有厚尾
 *
 * 锚点区间内（D1 ~ D180）**不用**全局拟合值，而是在相邻锚点之间做对数线性插值，
 * 保证曲线精确穿过每一个锚点。为什么：
 *   第一版只用一条全局幂律，5 个锚点一条曲线穿不过去，短剧类预设的 D30 实测 9%
 *   被拟合成 5.6%，社交类 20% 被拟合成 13.1%。D30 恰好是决定「订阅 vs 解锁」的
 *   核心输入——用户在编辑器里拖到 9%，模型实际拿去算的却是 5.6%，结论就是错的。
 *   曲线必须穿过用户给的点，全局形式只负责锚点之外的部分。
 *
 * 全局拟合仍然做（在 log 空间对斜率 OLS、强制穿过第一个锚点），用途有二：
 *   1. 选形态：幂律 / 指数谁的 RMSE 小，公式显示给人看
 *   2. 尾部：最后一个锚点之后，按该形态的斜率继续衰减
 *
 * 全部锚点相同（例如「零流失」参照曲线）时斜率自然解出 0，退化为常数。
 *
 * @param {{day:number, retention:number}[]} anchors
 */
export function fitCurve(anchors) {
  const pts = (anchors || [])
    .map((a) => ({ day: Number(a.day), retention: Number(a.retention) }))
    .filter((p) => p.day >= 1 && p.retention > 0)
    .sort((a, b) => a.day - b.day);

  if (pts.length < 2) {
    throw new Error("拟合留存曲线至少需要 2 个锚点");
  }

  const r1 = pts[0].retention;
  const last = pts[pts.length - 1];

  // 幂律：ln r = ln r₁ − b · ln d
  const bPower = -olsSlope(pts.map((p) => [Math.log(p.day), Math.log(p.retention)]));
  const powerGlobal = (d) => (d < 1 ? 1 : r1 * Math.pow(d, -bPower));

  // 指数：ln r = ln r₁ − λ · (d − 1)
  const lamExp = -olsSlope(pts.map((p) => [p.day - 1, Math.log(p.retention)]));
  const expGlobal = (d) => (d < 1 ? 1 : r1 * Math.exp(-lamExp * (d - 1)));

  const rmsePower = rmseOf(pts, powerGlobal);
  const rmseExp = rmseOf(pts, expGlobal);

  const usePower = rmsePower <= rmseExp;
  const model = usePower ? "power" : "exp";

  // 尾部外推：从最后一个锚点出发，按选中形态的斜率继续
  const tail = usePower
    ? (d) => last.retention * Math.pow(d / last.day, -bPower)
    : (d) => last.retention * Math.exp(-lamExp * (d - last.day));

  // 锚点区间内：对数线性插值（留存是乘性衰减，log 空间线性比原空间线性更贴近真实形态）
  const r = (d) => {
    if (d < 1) return 1;
    if (d <= pts[0].day) {
      // D0 = 1 到第一个锚点之间，同样按对数线性
      const t = d / pts[0].day;
      return Math.exp(Math.log(1) * (1 - t) + Math.log(pts[0].retention) * t);
    }
    if (d >= last.day) return tail(d);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (d >= a.day && d <= b.day) {
        const t = (Math.log(d) - Math.log(a.day)) / (Math.log(b.day) - Math.log(a.day));
        return Math.exp(Math.log(a.retention) * (1 - t) + Math.log(b.retention) * t);
      }
    }
    return tail(d);
  };

  const residuals = pts.map((p) => ({
    day: p.day,
    observed: p.retention,
    fitted: r(p.day),
    diff: r(p.day) - p.retention,
  }));

  const formula = usePower
    ? `r(d) ≈ ${r1.toFixed(4)} × d^(−${bPower.toFixed(4)})   （幂律形态；锚点间精确插值，D${last.day} 后按此外推）`
    : `r(d) ≈ ${r1.toFixed(4)} × e^(−${lamExp.toFixed(5)} × (d−1))   （指数形态；锚点间精确插值，D${last.day} 后按此外推）`;

  return {
    model,
    r1,
    power: bPower,
    lambda: lamExp,
    // rmse 报告的是全局形态拟合对锚点的偏离，衡量「这条曲线像不像标准幂律/指数」；
    // 实际 r(d) 在锚点处的残差恒为 0。
    rmse: usePower ? rmsePower : rmseExp,
    rmseByModel: { power: rmsePower, exp: rmseExp },
    formula,
    r,
    residuals,
    anchors: pts,
  };
}

/**
 * 订阅人群的生存曲线。
 *
 * 关键假设：订阅者是**自选出来的高意愿人群**，直接用大盘留存会低估他们的粘性——
 * 会为一个内容产品按月付费的人，本来就是重度用户。做法是把大盘的月度生存率
 * 开 alpha 次方：subS_k = S_k ^ alpha，alpha ∈ (0, 1]。
 *   alpha = 1   退化为「订阅者和普通用户一样容易流失」（最保守）
 *   alpha < 1   订阅者流失更慢（S < 1 时开方会变大）
 * 默认值 0.85 与 model.js 的 DEFAULT_RETENTION.alpha 一致——两处写不同的默认值是
 * 隐患：调用方不传 alpha 时到底拿到哪个值，取决于走的是哪条代码路径。
 * 这是可调参数，不是拟合出来的，出处标在 docs/ASSUMPTIONS.md。
 *
 * @param {number[]} S  monthlySurvival 的输出
 * @param {number} alpha
 */
export function subscriberSurvival(S, alpha = 0.85) {
  const a = Math.min(1, Math.max(0.05, Number(alpha) || 0));
  return S.map((s) => Math.pow(Math.max(s, 0), a));
}
