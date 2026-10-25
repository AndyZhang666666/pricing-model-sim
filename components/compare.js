"use client";

// 页面 2：三种机制对比 —— 核心页。
//
// 结构：左侧参数面板，右侧结论卡 + 三线对比图 + 汇总表。
// 所有数字来自 lib/model.js 的 simulateAll，页面本身不做任何计算。

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";
import { MECHANISMS, MECHANISM_LABELS } from "@/lib/model";
import DataTable from "./data-table";

const COLOR = { unlock: "#1d5fbf", subscription: "#283a46", hybrid: "#6b747b" };
const SHORT = { unlock: "单次解锁", subscription: "包月订阅", hybrid: "混合" };

const fmt = (v, d = 2) =>
  v === null || v === undefined ? "—" : Number(v).toFixed(d);

function Slider({ label, hint, value, min, max, step, onChange, format }) {
  return (
    <label className="field">
      <span>
        {label}
        <b>{format ? format(value) : value}</b>
      </span>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={format ? format(value) : String(value)}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <em>{hint}</em>}
    </label>
  );
}

export default function Compare({ sim, params, setParam }) {
  const { results, verdict } = sim;
  const order = MECHANISMS.slice().sort(
    (a, b) => results[b].summary.ltv12 - results[a].summary.ltv12,
  );

  // 三线图的横轴数据：把三种机制的逐月序列并到一起
  const chartData = results.unlock.monthly.map((row, i) => ({
    month: i + 1,
    单次解锁: results.unlock.monthly[i].discountedArpu,
    包月订阅: results.subscription.monthly[i].discountedArpu,
    混合: results.hybrid.monthly[i].discountedArpu,
    ltvUnlock: results.unlock.monthly[i].arpu,
  }));

  const cac = params.common.cac;

  return (
    <div className="grid">
      {/* ── 参数面板 ── */}
      <div>
        <div className="panel">
          <h2>公共参数</h2>
          <Slider
            label="获客成本 CAC"
            hint="单个新增用户的获取成本，回本月份的分母"
            value={params.common.cac}
            min={0}
            max={40}
            step={0.5}
            onChange={(v) => setParam("common", "cac", v)}
            format={(v) => `¥${v}`}
          />
          <Slider
            label="平台 / 渠道抽成"
            hint="应用商店或渠道方拿走的部分"
            value={params.common.platformCut}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setParam("common", "platformCut", v)}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Slider
            label="月折现率"
            hint="未来的钱折算到今天；0 表示不做时间价值折算"
            value={params.common.discountMonthly}
            min={0}
            max={0.05}
            step={0.005}
            onChange={(v) => setParam("common", "discountMonthly", v)}
            format={(v) => `${(v * 100).toFixed(1)}%`}
          />
          <Slider
            label="每月新增用户"
            hint="只影响总收入与存量，不影响 ARPU / LTV"
            value={params.common.newUsersPerMonth}
            min={1000}
            max={200000}
            step={1000}
            onChange={(v) => setParam("common", "newUsersPerMonth", v)}
            format={(v) => v.toLocaleString()}
          />
        </div>

        <div className="panel">
          <h2>单次解锁</h2>
          <Slider
            label="单集价格"
            value={params.unlock.pricePerUnlock}
            min={0}
            max={10}
            step={0.1}
            onChange={(v) => setParam("unlock", "pricePerUnlock", v)}
            format={(v) => `¥${v.toFixed(2)}`}
          />
          <Slider
            label="付费用户月均解锁"
            hint="付费人群平均每月解锁多少集"
            value={params.unlock.unlocksPerPayerMonth}
            min={0}
            max={40}
            step={0.5}
            onChange={(v) => setParam("unlock", "unlocksPerPayerMonth", v)}
            format={(v) => `${v} 集`}
          />
          <Slider
            label="付费率（首月）"
            hint="活跃用户中会付费解锁的比例"
            value={params.unlock.payerShare}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setParam("unlock", "payerShare", v)}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Slider
            label="付费意愿月衰减"
            hint="老用户比新用户少掏多少；1 表示不衰减"
            value={params.unlock.payerDecay}
            min={0.5}
            max={1}
            step={0.01}
            onChange={(v) => setParam("unlock", "payerDecay", v)}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            label="免费集数"
            hint="白嫖期，会推迟解锁收入"
            value={params.unlock.freeEpisodes}
            min={0}
            max={30}
            step={1}
            onChange={(v) => setParam("unlock", "freeEpisodes", v)}
            format={(v) => `${v} 集`}
          />
        </div>

        <div className="panel">
          <h2>包月订阅</h2>
          <Slider
            label="月费"
            value={params.subscription.monthlyPrice}
            min={0}
            max={80}
            step={1}
            onChange={(v) => setParam("subscription", "monthlyPrice", v)}
            format={(v) => `¥${v}`}
          />
          <Slider
            label="免费试用天数"
            value={params.subscription.trialDays}
            min={0}
            max={30}
            step={1}
            onChange={(v) => setParam("subscription", "trialDays", v)}
            format={(v) => `${v} 天`}
          />
          <Slider
            label="开始试用的比例"
            value={params.subscription.trialOptIn}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setParam("subscription", "trialOptIn", v)}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Slider
            label="试用转付费率"
            hint="试用期结束时的付费转化"
            value={params.subscription.trialToPaid}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setParam("subscription", "trialToPaid", v)}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
        </div>

        <div className="panel">
          <h2>混合机制</h2>
          <Slider
            label="切订阅门槛"
            hint="累计解锁满多少集后开始推订阅"
            value={params.hybrid.unlockThreshold}
            min={0}
            max={20}
            step={1}
            onChange={(v) => setParam("hybrid", "unlockThreshold", v)}
            format={(v) => `${v} 集`}
          />
          <Slider
            label="每月分流比例"
            hint="达到门槛后每月有多少比例转向订阅"
            value={params.hybrid.switchRate}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setParam("hybrid", "switchRate", v)}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Slider
            label="切换摩擦"
            hint="被推订阅的人里，因为预扣费反感而直接走掉的比例"
            value={params.hybrid.switchChurn}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setParam("hybrid", "switchChurn", v)}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
        </div>

        <div className="panel">
          <h2>订阅人群粘性 α</h2>
          <Slider
            label="α（越小 = 订阅者越粘）"
            hint="订阅者是自选出来的高意愿人群，用大盘留存会低估他们"
            value={sim.ctx.retention.alpha ?? 0.85}
            min={0.2}
            max={1}
            step={0.01}
            onChange={(v) => setParam("retention", "alpha", v)}
            format={(v) => v.toFixed(2)}
          />
          <p className="small" style={{ margin: 0 }}>
            当前曲线 D30 = <b>{((verdict.d30 ?? 0) * 100).toFixed(1)}%</b>。 α =
            1 表示订阅者和普通用户一样容易流失（最保守）。
          </p>
        </div>
      </div>

      {/* ── 结论 + 图表 ── */}
      <div>
        {/* 结论卡：用人话说结论，理由从数字里推 */}
        <div className="verdict">
          <b className="head">当前假设下的比较</b>
          <p className="lead">
            {verdict.tie ? (
              <>
                <strong>
                  {verdict.tiedWinners.map((k) => SHORT[k]).join(" / ")}
                </strong>{" "}
                的 12 个月 LTV 并列，不强行选唯一赢家。
              </>
            ) : (
              <>
                在这组假设下，<strong>{verdict.winnerLabel}</strong> 的 12 个月
                LTV 较高；
                {verdict.margin === null ? (
                  "第二名为零，不计算相对百分比。"
                ) : (
                  <>
                    比{verdict.runnerUpLabel}高{" "}
                    <strong>{verdict.margin.toFixed(1)}%</strong>。
                  </>
                )}
              </>
            )}
            {verdict.coverage}。
          </p>
          <p className="why">{verdict.reason}</p>
          <p className="note">
            这是情景比较，不是最优定价建议。调高月费不会自动重估转化与留存；α、切换摩擦等参数需用实际数据校准。下一步应优先验证会改变机制排序的假设。
          </p>
          <div className="nums">
            {order.map((k, i) => (
              <div key={k}>
                {i === 0 ? "① " : i === 1 ? "② " : "③ "}
                {SHORT[k]} LTV
                <b style={{ color: i === 0 ? COLOR[k] : "#1f1e1c" }}>
                  ¥{fmt(results[k].summary.ltv12, 2)}
                </b>
              </div>
            ))}
            <div>
              回本最快
              <b>
                {(() => {
                  const best = order
                    .map((k) => [k, results[k].summary.paybackMonth])
                    .filter(([, m]) => m)
                    .sort((a, b) => a[1] - b[1])[0];
                  return params.common.cac === 0
                    ? "不适用（CAC=0）"
                    : best
                      ? `${SHORT[best[0]]} ${best[1]} 个月`
                      : "12 个月内无";
                })()}
              </b>
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>累计折现贡献（每名新增用户）</h2>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={chartData}
              margin={{ top: 6, right: 12, bottom: 4, left: -8 }}
            >
              <CartesianGrid stroke="#eeebe6" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: "#a19b93" }}
                tickLine={false}
                axisLine={{ stroke: "#e6e4e0" }}
                label={{
                  value: "注册后第几个月",
                  position: "insideBottom",
                  offset: -2,
                  fontSize: 11,
                  fill: "#a19b93",
                }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#a19b93" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `¥${v}`}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 8,
                  border: "1px solid #e6e4e0",
                }}
                formatter={(v) => `¥${Number(v).toFixed(2)}`}
                labelFormatter={(m) => `第 ${m} 个月`}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
              <ReferenceLine
                y={cac}
                stroke="#c0392b"
                strokeDasharray="4 3"
                label={{
                  value: `CAC ¥${cac}`,
                  fontSize: 11,
                  fill: "#c0392b",
                  position: "insideTopRight",
                }}
              />
              {MECHANISMS.map((k) => (
                <Line
                  key={k}
                  type="linear"
                  dataKey={SHORT[k]}
                  stroke={COLOR[k]}
                  strokeDasharray={k === "hybrid" ? "6 4" : undefined}
                  isAnimationActive={false}
                  strokeWidth={k === verdict.winner ? 2.4 : 1.6}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <p className="small" style={{ marginTop: 8, marginBottom: 0 }}>
            虚线是
            CAC。曲线越过它表示累计折现渠道收入覆盖获客成本，尚未扣除履约、研发等成本，不等于净利润。
            注意横轴是<b>用户自己的月龄</b>，不是日历月，这样才能和 CAC 直接比。
          </p>
        </div>

        <div className="panel">
          <h2>12 个月汇总</h2>
          <DataTable label="十二个月机制汇总">
            <thead>
              <tr>
                <th>机制</th>
                <th className="num">12 月 LTV</th>
                <th className="num">LTV / CAC</th>
                <th className="num">回本月份</th>
                <th className="num">人均累计解锁</th>
                <th className="num">人均订阅月数</th>
              </tr>
            </thead>
            <tbody>
              {order.map((k) => {
                const s = results[k].summary;
                return (
                  <tr key={k} className={k === verdict.winner ? "win" : ""}>
                    <td>
                      <span className={`chip ${k}`}>{MECHANISM_LABELS[k]}</span>
                    </td>
                    <td className="num">¥{fmt(s.ltv12)}</td>
                    <td className="num">
                      {s.ltvCac !== null ? fmt(s.ltvCac, 2) : "—"}
                    </td>
                    <td className="num">
                      {s.cac === 0
                        ? "不适用"
                        : s.paybackMonth
                          ? `${s.paybackMonth} 个月`
                          : "> 12 个月"}
                    </td>
                    <td className="num">{`${fmt(s.expectedUnlocks, 1)} 集`}</td>
                    <td className="num">
                      {k === "unlock"
                        ? "不适用"
                        : `${fmt(s.expectedPaidMonths, 1)} 月`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <div className="note">
            <b>怎么读这张表</b>：LTV/CAC &lt; 1
            表示模型中的折现渠道收入尚未覆盖获客成本，不是完整利润核算。
            两列都以每名新增用户为分母。未付费者计零，因此订阅月数可能小于
            1。它们说明收入到底从哪来：
            解锁机制靠集数堆，订阅机制靠月数堆，混合机制两边都有一点。
          </div>
        </div>

        <details className="panel">
          <summary>核对混合机制的逐月状态（每名新增用户）</summary>
          <p className="small">
            月末切换，下月开始计订阅；离开解锁池的人不再反复分流。所有份额以最初新增用户为分母。
          </p>
          <div
            className="tableScroll"
            tabIndex={0}
            role="region"
            aria-label="混合机制逐月状态"
          >
            <table>
              <thead>
                <tr>
                  <th>月</th>
                  <th>本月解锁池</th>
                  <th>转订阅</th>
                  <th>切换流失</th>
                  <th>本月订阅付费</th>
                </tr>
              </thead>
              <tbody>
                {results.hybrid.trace.map((r) => (
                  <tr key={r.month}>
                    <td>{r.month}</td>
                    <td>{r.unlockPool.toFixed(4)}</td>
                    <td>{r.moved.toFixed(4)}</td>
                    <td>{r.churned.toFixed(4)}</td>
                    <td>{r.subPayers.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <div className="panel">
          <h2>第 12 个月的存量与收入结构</h2>
          <DataTable label="第十二月存量与收入结构">
            <thead>
              <tr>
                <th>机制</th>
                <th className="num">第 12 月存量</th>
                <th className="num">第 12 月单月收入</th>
                <th className="num">存量变现效率</th>
                <th className="num">12 月累计收入</th>
              </tr>
            </thead>
            <tbody>
              {order.map((k) => {
                const m = results[k].monthly[11];
                return (
                  <tr key={k}>
                    <td>{SHORT[k]}</td>
                    <td className="num">
                      {Math.round(m.stock).toLocaleString()}
                    </td>
                    <td className="num">
                      ¥{Math.round(m.revenue).toLocaleString()}
                    </td>
                    <td className="num">¥{fmt(m.stockArpu)}</td>
                    <td className="num">
                      ¥
                      {Math.round(
                        results[k].summary.cumRevenue12,
                      ).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <p className="small" style={{ marginTop: 8, marginBottom: 0 }}>
            「存量变现效率」= 当月收入 ÷ 当月存量，是另一种口径的 ARPU；它
            <b>不能</b>用来算回本，
            因为分母是活跃用户而不是新增用户。放在这里是为了看单位存量的变现能力。
          </p>
        </div>
      </div>
    </div>
  );
}
