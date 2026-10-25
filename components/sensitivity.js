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
import {
  MECHANISMS,
  MECHANISM_LABELS,
  overrideParams,
  buildContext,
  simulateMechanism,
} from "@/lib/model";
import DataTable from "./data-table";

const COLOR = { unlock: "#1d5fbf", subscription: "#283a46", hybrid: "#6b747b" };
const SHORT = { unlock: "单次解锁", subscription: "包月订阅", hybrid: "混合" };

const AXES = [
  { id: "monthlyPrice", label: "月费", unit: "¥", from: 4, to: 120, count: 40 },
  {
    id: "freeEpisodes",
    label: "免费集数",
    unit: " 集",
    from: 0,
    to: 30,
    count: 31,
  },
  {
    id: "trialToPaid",
    label: "订阅转化率",
    unit: "%",
    from: 0.05,
    to: 0.9,
    count: 35,
  },
  {
    id: "switchChurn",
    label: "切换摩擦",
    unit: "%",
    from: 0,
    to: 0.9,
    count: 37,
  },
  { id: "cac", label: "获客成本 CAC", unit: "¥", from: 0, to: 40, count: 41 },
  {
    id: "payerShare",
    label: "解锁付费率",
    unit: "%",
    from: 0.02,
    to: 0.8,
    count: 40,
  },
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
      const params = overrideParams(baseParams, overrideFor(v));
      const ctx = buildContext(retention, 12);
      const out = {};
      for (const k of MECHANISMS)
        out[k] = simulateMechanism(k, ctx, params).summary;
      return out;
    },
    [baseParams, overrideFor, retention],
  );

  const rows = useMemo(() => {
    const vals = linspace(axis.from, axis.to, axis.count);
    return vals.map((v) => {
      const r = emit(v);
      const order = MECHANISMS.slice().sort((a, b) => r[b].ltv12 - r[a].ltv12);
      const display =
        axis.unit === "%" ? Number((v * 100).toFixed(2)) : Number(v.toFixed(2));
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
        for (
          let it = 0;
          it < 40 && hi - lo > (axis.to - axis.from) * 1e-5;
          it++
        ) {
          const mid = (lo + hi) / 2;
          if (winnerAt(mid) === target) hi = mid;
          else lo = mid;
        }
        const thr = (lo + hi) / 2;
        out.push({
          from: SHORT[rows[i - 1].winner],
          to: SHORT[rows[i].winner],
          threshold:
            axisId === "freeEpisodes"
              ? `${rows[i - 1].raw}–${rows[i].raw} 集（相邻档位）`
              : axis.unit === "%"
                ? `${(thr * 100).toFixed(2)}%`
                : `${axis.unit}${thr.toFixed(2)}`,
          x:
            axis.unit === "%"
              ? Number((thr * 100).toFixed(2))
              : Number(thr.toFixed(2)),
        });
      }
    }
    return out;
  }, [rows, emit, axis]);

  // 当前基准状态（默认参数）在这条轴上的位置
  const baseValue = (() => {
    switch (axisId) {
      case "monthlyPrice":
        return baseParams.subscription.monthlyPrice;
      case "freeEpisodes":
        return baseParams.unlock.freeEpisodes;
      case "trialToPaid":
        return baseParams.subscription.trialToPaid;
      case "switchChurn":
        return baseParams.hybrid.switchChurn;
      case "cac":
        return baseParams.common.cac;
      case "payerShare":
        return baseParams.unlock.payerShare;
      default:
        return null;
    }
  })();
  const baseX =
    axis.unit === "%"
      ? Number((baseValue * 100).toFixed(2))
      : Number(baseValue.toFixed(2));

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
            扫完 {axis.label} 从{" "}
            {axis.unit === "%"
              ? `${(axis.from * 100).toFixed(0)}%`
              : `${axis.unit}${axis.from}`}{" "}
            到{" "}
            {axis.unit === "%"
              ? `${(axis.to * 100).toFixed(0)}%`
              : `${axis.unit}${axis.to}`}{" "}
            的全区间，未观察到排序首项变化。并列按固定展示顺序排列，不等于存在唯一较优机制。
            这不代表参数没有业务影响，也不排除未覆盖区域的变化。
          </p>
        ) : (
          <>
            <p className="lead">
              在 {axis.label} 上出现了 <strong>{switches.length}</strong>{" "}
              个切换点：
            </p>
            <ul className="tight" style={{ marginBottom: 10 }}>
              {switches.map((s, i) => (
                <li key={i}>
                  {axis.label} <b>{s.threshold}</b> ——「{s.from}」让位于「{s.to}
                  」
                </li>
              ))}
            </ul>
            <p className="why">
              切换方向以逐项列出的“从 /
              到”为准；其他输入保持当前值，不退回默认值。这里没有建模调价带来的转化或留存弹性，不能当作实际定价建议。
              {baseValue !== null && (
                <>
                  {" "}
                  你现在这个值（
                  <b>
                    {axis.unit === "%"
                      ? `${(baseValue * 100).toFixed(1)}%`
                      : `${axis.unit}${baseValue}`}
                  </b>
                  ，图中虚线）相对第一个切换点位于
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
          <LineChart
            data={rows}
            margin={{ top: 6, right: 12, bottom: 4, left: -8 }}
          >
            <CartesianGrid stroke="#eeebe6" vertical={false} />
            <XAxis
              dataKey="x"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fontSize: 11, fill: "#58616a" }}
              tickLine={false}
              axisLine={{ stroke: "#e6e4e0" }}
              label={{
                value: `${axis.label}${axis.unit === "%" ? "（%）" : axis.unit ? `（${axis.unit.trim()}）` : ""}`,
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
              tickFormatter={(v) => `¥${Number(v).toFixed(0)}`}
            />
            <Tooltip
              contentStyle={{
                fontSize: 12,
                borderRadius: 8,
                border: "1px solid #e6e4e0",
              }}
              formatter={(v) => `¥${Number(v).toFixed(2)}`}
              labelFormatter={(x) =>
                `${axis.label} = ${axis.unit === "%" ? `${x}%` : `${axis.unit}${x}`}`
              }
            />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
            <ReferenceLine
              x={baseX}
              stroke="#c0392b"
              strokeDasharray="4 3"
              label={{
                value: "当前",
                fontSize: 11,
                fill: "#c0392b",
                position: "top",
              }}
            />
            {switches.map((s, i) => (
              <ReferenceLine
                key={i}
                x={s.x}
                stroke="#a19b93"
                strokeDasharray="2 3"
              />
            ))}
            {MECHANISMS.map((k) => (
              <Line
                key={k}
                type="linear"
                dataKey={SHORT[k]}
                stroke={COLOR[k]}
                strokeDasharray={k === "hybrid" ? "6 4" : undefined}
                isAnimationActive={false}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <p className="small" style={{ marginTop: 8, marginBottom: 0 }}>
          虚线标出范围内的当前值与条件切换点；当前值在扫描范围外时不显示定位线。斜率只是其他参数不变时的机械关系，不能作为应当涨价或调整产品的证据。
        </p>
      </div>

      <div className="panel">
        <h2>切换点附近的明细</h2>
        <DataTable label="切换点附近明细">
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
                return switches.some(
                  (s) =>
                    Math.abs(s.x - r.x) <
                    ((axis.to - axis.from) / axis.count) * 1.6,
                );
              })
              .map((r, i) => (
                <tr key={i}>
                  <td>
                    {axis.unit === "%" ? `${r.x}%` : `${axis.unit}${r.x}`}
                  </td>
                  <td className="num">¥{r.单次解锁.toFixed(2)}</td>
                  <td className="num">¥{r.包月订阅.toFixed(2)}</td>
                  <td className="num">¥{r.混合.toFixed(2)}</td>
                  <td>
                    <span className={`chip ${r.winner}`}>{r.winnerLabel}</span>
                  </td>
                </tr>
              ))}
          </tbody>
        </DataTable>
      </div>
    </div>
  );
}
