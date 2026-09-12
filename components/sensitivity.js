"use client";

// 页面 3：敏感性分析 —— 商业化 PM 最常被追问的那句话：「这个定价的临界点在哪」。
//
// 每张图扫一个参数，看三种机制的 LTV 怎么变，以及「最优机制」在哪个值上换手。
// 切换点用二分法收敛到很小的区间，不是网格里的粗略位置。

import { useMemo, useState } from "react";
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
import { MECHANISMS, MECHANISM_LABELS, mergeParams, buildContext, simulateMechanism } from "@/lib/model";

const COLOR = { unlock: "#3b5b92", subscription: "#b4553f", hybrid: "#2f6b52" };
const SHORT = { unlock: "单次解锁", subscription: "包月订阅", hybrid: "混合" };

const AXES = [
  { id: "monthlyPrice", label: "月费", unit: "¥", from: 4, to: 120, count: 40 },
  { id: "freeEpisodes", label: "免费集数", unit: " 集", from: 0, to: 30, count: 31 },
  { id: "trialToPaid", label: "订阅转化率", unit: "%", from: 0.05, to: 0.9, count: 35 },
  { id: "switchChurn", label: "切换摩擦", unit: "%", from: 0, to: 0.9, count: 37 },
  { id: "cac", label: "获客成本 CAC", unit: "¥", from: 0, to: 40, count: 41 },
  { id: "payerShare", label: "解锁付费率", unit: "%", from: 0.02, to: 0.8, count: 40 },
];

function linspace(from, to, count) {
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_, i) => from + i * step);
}

export default function Sensitivity({ retention, baseParams }) {
  const [axisId, setAxisId] = useState("monthlyPrice");
  const axis = AXES.find((a) => a.id === axisId);

  // 给定扫描值，生成对应的参数覆盖
  const overrideFor = useMemo(
    () => (v) => {
      switch (axisId) {
        case "monthlyPrice":
          return { subscription: { monthlyPrice: v } };
        case "freeEpisodes":
          return { unlock: { freeEpisodes: v } };
        case "trialToPaid":
          return { subscription: { trialToPaid: v } };
        case "switchChurn":
          return { hybrid: { switchChurn: v } };
        case "cac":
          return { common: { cac: v } };
        case "payerShare":
          return { unlock: { payerShare: v } };
        default:
          return {};
      }
    },
    [axisId],
  );

  const emit = useMemo(
    () => (v) => {
      const params = mergeParams({ ...baseParams, ...overrideFor(v) });
      const ctx = buildContext(retention, 12);
      const out = {};
      for (const k of MECHANISMS) out[k] = simulateMechanism(k, ctx, params).summary;
      return out;
    },
    [baseParams, overrideFor, retention],
  );

  const rows = useMemo(() => {
    const vals = linspace(axis.from, axis.to, axis.count);
    return vals.map((v) => {
      const r = emit(v);
      const order = MECHANISMS.slice().sort((a, b) => r[b].ltv12 - r[a].ltv12);
      const display = axis.unit === "%" ? Number((v * 100).toFixed(2)) : Number(v.toFixed(2));
      return {
        x: display,
        raw: v,
        单次解锁: r.unlock.ltv12,
        包月订阅: r.subscription.ltv12,
        混合: r.hybrid.ltv12,
        winner: order[0],
        winnerLabel: MECHANISM_LABELS[order[0]],
      };
    });
  }, [axis, emit]);

  // 切换点：相邻两点 winner 不同，再二分收敛
  const switches = useMemo(() => {
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].winner !== rows[i - 1].winner) {
        let lo = rows[i - 1].raw;
        let hi = rows[i].raw;
        const winnerAt = (v) => {
          const r = emit(v);
          return MECHANISMS.slice().sort((a, b) => r[b].ltv12 - r[a].ltv12)[0];
        };
        const target = rows[i].winner;
        for (let it = 0; it < 40 && hi - lo > (axis.to - axis.from) * 1e-5; it++) {
          const mid = (lo + hi) / 2;
          if (winnerAt(mid) === target) hi = mid;
          else lo = mid;
        }
        const thr = (lo + hi) / 2;
        out.push({
          from: SHORT[rows[i - 1].winner],
          to: SHORT[rows[i].winner],
          threshold:
            axis.unit === "%" ? `${(thr * 100).toFixed(2)}%` : `${axis.unit}${thr.toFixed(2)}`,
          x: axis.unit === "%" ? Number((thr * 100).toFixed(2)) : Number(thr.toFixed(2)),
        });
      }
    }
    return out;
  }, [rows, emit, axis]);

  // 当前基准状态（默认参数）在这条轴上的位置
  const baseValue = (() => {
    switch (axisId) {
      case "monthlyPrice": return baseParams.subscription.monthlyPrice;
      case "freeEpisodes": return baseParams.unlock.freeEpisodes;
      case "trialToPaid": return baseParams.subscription.trialToPaid;
      case "switchChurn": return baseParams.hybrid.switchChurn;
      case "cac": return baseParams.common.cac;
      case "payerShare": return baseParams.unlock.payerShare;
      default: return null;
    }
  })();
  const baseX = axis.unit === "%" ? Number((baseValue * 100).toFixed(2)) : Number(baseValue.toFixed(2));

  // 整体最优机制（按扫过整条轴，各机制 LTV 的曲线下面积更大者不好定义，
  // 这里给出更有用的读法：切换点两侧分别是谁占优）
  const orderedByArea = useMemo(() => {
    const sums = {};
    for (const k of MECHANISMS) sums[k] = rows.reduce((s, r) => s + r[SHORT[k]], 0);
    return MECHANISMS.slice().sort((a, b) => sums[b] - sums[a]);
  }, [rows]);

  return (
    <div className="grid wide">
      <div className="panel">
        <h2>选一个参数扫一遍</h2>
        <div className="tabbar" style={{ marginBottom: 0 }}>
          {AXES.map((a) => (
            <button
              key={a.id}
              className={a.id === axisId ? "active" : ""}
              onClick={() => setAxisId(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="verdict">
        <b className="head">切换边界</b>
        {switches.length === 0 ? (
          <p className="lead" style={{ marginBottom: 0 }}>
            扫完 {axis.label} 从 {axis.unit === "%" ? `${(axis.from * 100).toFixed(0)}%` : `${axis.unit}${axis.from}`}
            {" "}到 {axis.unit === "%" ? `${(axis.to * 100).toFixed(0)}%` : `${axis.unit}${axis.to}`} 的全区间，
            <strong>{MECHANISM_LABELS[rows[0].winner]}</strong> 始终最优，没有换手。
            说明在这个区间里，「选哪种机制」这件事对 {axis.label} 不敏感 ——
            它不是你的决策变量。
          </p>
        ) : (
          <>
            <p className="lead">
              在 {axis.label} 上出现了 <strong>{switches.length}</strong> 个切换点：
            </p>
            <ul className="tight" style={{ marginBottom: 10 }}>
              {switches.map((s, i) => (
                <li key={i}>
                  {axis.label} <b>{s.threshold}</b> ——「{s.from}」让位于「{s.to}」
                </li>
              ))}
            </ul>
            <p className="why">
              把 {MECHANISM_LABELS[orderedByArea[0]]} 和 {MECHANISM_LABELS[orderedByArea[1]]}
              {" "}两条曲线的交点找出来，就是「该用哪种机制」的判断线。
              低于切换点用前者，高于用后者。
              {baseValue !== null && (
                <>
                  {" "}你现在这个值（<b>{axis.unit === "%" ? `${(baseValue * 100).toFixed(1)}%` : `${axis.unit}${baseValue}`}</b>
                  ，图中红虚线）落在切换点的
                  {baseX < switches[0].x ? "左侧" : "右侧"}。
                </>
              )}
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <h2>三种机制的 LTV 随 {axis.label} 的变化</h2>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 4, left: -8 }}>
            <CartesianGrid stroke="#eeebe6" vertical={false} />
            <XAxis dataKey="x" tick={{ fontSize: 11, fill: "#a19b93" }} tickLine={false}
              axisLine={{ stroke: "#e6e4e0" }}
              label={{ value: `${axis.label}${axis.unit === "%" ? "（%）" : axis.unit ? `（${axis.unit.trim()}）` : ""}`, position: "insideBottom", offset: -2, fontSize: 11, fill: "#a19b93" }} />
            <YAxis tick={{ fontSize: 11, fill: "#a19b93" }} tickLine={false} axisLine={false}
              tickFormatter={(v) => `¥${Number(v).toFixed(0)}`} />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e6e4e0" }}
              formatter={(v) => `¥${Number(v).toFixed(2)}`}
              labelFormatter={(x) => `${axis.label} = ${axis.unit === "%" ? `${x}%` : `${axis.unit}${x}`}`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
            <ReferenceLine x={baseX} stroke="#c0392b" strokeDasharray="4 3"
              label={{ value: "当前", fontSize: 11, fill: "#c0392b", position: "top" }} />
            {switches.map((s, i) => (
              <ReferenceLine key={i} x={s.x} stroke="#a19b93" strokeDasharray="2 3" />
            ))}
            {MECHANISMS.map((k) => (
              <Line key={k} type="monotone" dataKey={SHORT[k]} stroke={COLOR[k]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <p className="small" style={{ marginTop: 8, marginBottom: 0 }}>
          红虚线是当前参数取值，灰虚线是切换点。三条线各自单调，但斜率不同 ——
          斜率最大的那条，就是你该往那个方向调的证据。
        </p>
      </div>

      <div className="panel">
        <h2>切换点附近的明细</h2>
        <table>
          <thead>
            <tr>
              <th>{axis.label}</th>
              <th className="num">单次解锁</th>
              <th className="num">包月订阅</th>
              <th className="num">混合</th>
              <th>当时最优</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .filter((r, i) => {
                if (i === 0 || i === rows.length - 1) return true;
                // 只留切换点前后各一行，以及两端
                return switches.some((s) => Math.abs(s.x - r.x) < (axis.to - axis.from) / axis.count * 1.6);
              })
              .map((r, i) => (
                <tr key={i}>
                  <td>{axis.unit === "%" ? `${r.x}%` : `${axis.unit}${r.x}`}</td>
                  <td className="num">¥{r.单次解锁.toFixed(2)}</td>
                  <td className="num">¥{r.包月订阅.toFixed(2)}</td>
                  <td className="num">¥{r.混合.toFixed(2)}</td>
                  <td>
                    <span className={`chip ${r.winner}`}>{r.winnerLabel}</span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
