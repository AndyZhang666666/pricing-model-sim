"use client";

// 留存曲线编辑器：用户直接拖动锚点，曲线实时重拟合并重算，不用输数字。
//
// 为什么要拖而不是填表：留存曲线是这个工具唯一的输入，也是最难估的一项。
// 让用户填 5 个两位数会让人去查资料然后随便填一个；让他拖一个点、看到曲线
// 形状变化，判断的依据就从「数字」变成「像不像我的产品」——后者他有，前者他没有。

import { useRef, useState, useEffect, useCallback } from "react";
import { fitCurve, ANCHOR_DAYS, DAYS_PER_MONTH } from "@/lib/retention";

const W = 620;
const H = 240;
const PAD = { l: 44, r: 16, t: 16, b: 30 };
const MAX_DAY = 180;

const X = (day) => PAD.l + ((Math.log(Math.max(day, 1)) / Math.log(MAX_DAY)) * (W - PAD.l - PAD.r));
const Y = (v) => PAD.t + (1 - v) * (H - PAD.t - PAD.b);

export default function RetentionEditor({ anchors, onChange }) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);

  const curve = fitCurve(anchors);

  // 曲线采样点。对数横轴：前 30 天占了一半宽度，因为这 30 天的形态决定结论。
  const path = (() => {
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 120;
      const day = Math.exp(t * Math.log(MAX_DAY));
      pts.push(`${X(day).toFixed(1)},${Y(curve.r(day)).toFixed(1)}`);
    }
    return `M ${pts.join(" L ")}`;
  })();

  const snapTo = useCallback(
    (e) => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const py = ((e.clientY - rect.top) / rect.height) * H;
      const day = Math.exp(((px - PAD.l) / (W - PAD.l - PAD.r)) * Math.log(MAX_DAY));
      const v = 1 - (py - PAD.t) / (H - PAD.t - PAD.b);
      // 横向吸附到最近的锚点日，避免拖出 5 个乱七八糟的点
      const nearest = ANCHOR_DAYS.reduce((a, b) =>
        Math.abs(b - day) < Math.abs(a - day) ? b : a,
      );
      return { day: nearest, value: Math.min(1, Math.max(0, v)) };
    },
    [],
  );

  const onMove = useCallback(
    (e) => {
      if (!drag) return;
      const s = snapTo(e);
      if (!s) return;
      // D1 不允许超过 1，其余锚点不允许高于前一个（留存单调不增）
      const prev = anchors.find((a) => a.day === drag - 1) ?? null;
      const list = anchors.map((a) =>
        a.day === s.day
          ? {
              day: s.day,
              retention: prev
                ? Math.min(s.value, prev.retention)
                : Math.min(1, s.value),
            }
          : a,
      );
      onChange(list);
    },
    [drag, anchors, onChange, snapTo],
  );

  useEffect(() => {
    if (!drag) return undefined;
    const up = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", up);
    };
  }, [drag, onMove]);

  return (
    <div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block", touchAction: "none" }}
        onMouseDown={(e) => {
          const s = snapTo(e);
          if (s) setDrag(s.day);
        }}
      >
        {/* 网格：纵向标 D1/D7/D30/D90/D180，横向标留存的 0/25/50/75/100% */}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={`h${g}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={Y(g)} y2={Y(g)} stroke="#eeebe6" strokeWidth="1" />
            <text x={PAD.l - 8} y={Y(g) + 4} fontSize="10" fill="#a19b93" textAnchor="end">
              {(g * 100).toFixed(0)}%
            </text>
          </g>
        ))}
        {ANCHOR_DAYS.map((d) => (
          <g key={`v${d}`}>
            <line x1={X(d)} x2={X(d)} y1={PAD.t} y2={H - PAD.b} stroke="#f4f2ee" strokeWidth="1" />
            <text x={X(d)} y={H - PAD.b + 15} fontSize="10" fill="#a19b93" textAnchor="middle">
              D{d}
            </text>
          </g>
        ))}

        <path d={path} fill="none" stroke="#1f1e1c" strokeWidth="2" />

        {anchors.map((a) => {
          const obs = curve.residuals.find((r) => r.day === a.day);
          const off = obs && Math.abs(obs.fitted - obs.observed) > 0.004;
          return (
            <g key={a.day} style={{ cursor: "grab" }}>
              {/* 拟合值与实测值不一致时，把实测位置也画出来，别让人以为曲线穿过了它 */}
              {off && (
                <circle cx={X(a.day)} cy={Y(a.retention)} r="3" fill="none" stroke="#c0392b" strokeWidth="1.5" strokeDasharray="2 2" />
              )}
              <circle
                cx={X(a.day)}
                cy={Y(curve.r(a.day))}
                r={drag === a.day ? 6 : 4.5}
                fill="#fff"
                stroke="#1f1e1c"
                strokeWidth="2"
              />
            </g>
          );
        })}
      </svg>

      <div className="row between" style={{ marginTop: 8 }}>
        <span className="small">拖动圆点改留存 · 曲线自动重拟合</span>
        <span className="small mono" style={{ fontSize: 11 }}>
          {curve.model === "power" ? "幂律" : "指数"} · RMSE {(curve.rmse).toFixed(2)}pp
        </span>
      </div>
      <div className="formula" style={{ marginTop: 8 }}>
        {curve.formula}
      </div>

      <table style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>锚点</th>
            <th className="num">实测</th>
            <th className="num">拟合</th>
            <th className="num">月序</th>
          </tr>
        </thead>
        <tbody>
          {anchors.map((a) => {
            const fitted = curve.r(a.day);
            const monthAt = a.day / DAYS_PER_MONTH;
            return (
              <tr key={a.day}>
                <td>D{a.day}</td>
                <td className="num">{(a.retention * 100).toFixed(1)}%</td>
                <td className="num">{(fitted * 100).toFixed(1)}%</td>
                <td className="num tiny">第 {monthAt.toFixed(1)} 月起</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
