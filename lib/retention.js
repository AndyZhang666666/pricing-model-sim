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

/** 第 k 个月的月初在册比例。k ≥ 1。 */
export function rateAtMonth(curve, k) {
  if (k <= 0) return 1;
  return curve.r(k * DAYS_PER_MONTH);
}

/** 前 horizon 个月的月初在册比例数组，下标 0 对应第 1 个月。 */
export function monthlySurvival(curve, horizon) {
  const out = [];
  for (let k = 1; k <= horizon; k++) out.push(rateAtMonth(curve, k));
  return out;
}

/** 第 k 个月相对第 k−1 个月的续存率 ρ_k（k = 1 时定义为 1）。 */
export function monthlyRetentionRatio(curve, k) {
  if (k <= 1) return 1;
  const prev = rateAtMonth(curve, k - 1);
  if (prev <= 0) return 0;
  return rateAtMonth(curve, k) / prev;
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
 * 两种候选形式：
 *   幂律   r(d) = r₁ × d^(−b)          内容/社交类的主流形态：早期掉得快、长尾薄
 *   指数   r(d) = r₁ × exp(−λ(d−1))    工具类更常见：每月按固定比例流失，没有厚尾
 *
 * 拟合方式：在 log 空间对斜率做最小二乘，然后**强制曲线穿过第一个锚点**，
 * 即令 r(d₁) = 锚点实测值。为什么要强制：锚点少的时候 OLS 的截距很不稳，
 * 会出现 D1 拟合到 0.31 而实测是 0.45 的情况。第一个锚点是全曲线最可信的
 * 一个数，钉住它、只让斜率自由，残差反而更小。取舍见 docs/DECISIONS.md。
 *
 * 全部锚点相同（例如「零流失」参照曲线）时斜率自然解出 0，公式退化为常数。
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

  // 幂律：ln r = ln r₁ − b · ln d
  const bPower = -olsSlope(pts.map((p) => [Math.log(p.day), Math.log(p.retention)]));
  const power = (d) => (d < 1 ? 1 : r1 * Math.pow(d, -bPower));

  // 指数：ln r = ln r₁ − λ · (d − 1)
  const lamExp = -olsSlope(pts.map((p) => [p.day - 1, Math.log(p.retention)]));
  const exp = (d) => (d < 1 ? 1 : r1 * Math.exp(-lamExp * (d - 1)));

  const rmsePower = rmseOf(pts, power);
  const rmseExp = rmseOf(pts, exp);

  const usePower = rmsePower <= rmseExp;
  const r = usePower ? power : exp;
  const model = usePower ? "power" : "exp";

  const residuals = pts.map((p) => ({
    day: p.day,
    observed: p.retention,
    fitted: r(p.day),
    diff: r(p.day) - p.retention,
  }));

  const formula = usePower
    ? `r(d) = ${r1.toFixed(4)} × d^(−${bPower.toFixed(4)})   （幂律）`
    : `r(d) = ${r1.toFixed(4)} × e^(−${lamExp.toFixed(5)} × (d−1))   （指数）`;

  return {
    model,
    r1,
    power: bPower,
    lambda: lamExp,
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
 *   alpha = 0.6 默认值，含义是订阅者流失更慢（S < 1 时开方会变大）
 * 这是可调参数，不是拟合出来的，所以单独放在 ASSUMPTIONS.md 里标「经验估计」。
 *
 * @param {number[]} S  monthlySurvival 的输出
 * @param {number} alpha
 */
export function subscriberSurvival(S, alpha = 0.6) {
  const a = Math.min(1, Math.max(0.05, Number(alpha) || 0));
  return S.map((s) => Math.pow(Math.max(s, 0), a));
}

/** 一次把曲线和两种生存数组都算好，UI 和脚本共用。 */
export function buildCurveContext(retention, horizon = 12) {
  const curve = fitCurve(retention.anchors);
  const S = monthlySurvival(curve, horizon);
  const Ssub = subscriberSurvival(S, retention.alpha ?? 0.6);
  return { curve, S, Ssub, horizon };
}

/** D1 / D7 / D30 / D90 / D180 的拟合值，给 UI 打表用。 */
export function anchorTable(curve) {
  return ANCHOR_DAYS.map((day) => ({
    day,
    fitted: curve.r(day),
    observed: curve.anchors.find((a) => a.day === day)?.retention ?? null,
  }));
}
