"use client";

// 页面 4：案例库。
//
// 每个案例 = 一条留存曲线 + 一组参数 + 模拟器跑出来的结论 + 我的点评。
// 点评里说的每个数都从模拟结果里取，不手写。
// 数据来源 data/cases.json，明确标注合成。

import { useMemo } from "react";
import { mergeParams, buildContext, simulateMechanism, MECHANISMS, MECHANISM_LABELS } from "@/lib/model";

const SHORT = { unlock: "单次解锁", subscription: "包月订阅", hybrid: "混合" };
const fmt = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));

export default function Cases({ cases, presets, onLoad }) {
  // presets 是 data/presets.json 的整个对象：{ alpha, presets: [...] }，不是数组。
  // 第一版这里写成 [...presets]，把对象当数组展开，整页白屏。
  const presetById = useMemo(
    () => Object.fromEntries((presets.presets ?? []).map((p) => [p.id, p])),
    [presets],
  );

  return (
    <div>
      <div className="note" style={{ marginBottom: 16 }}>
        以下 4 个案例的留存曲线与全部参数均为<b>合成数据</b>，由公开行业常识范围内的经验估计构造，
        不来自任何真实产品的后台。生成规则见 <span className="mono">data/GENERATION.md</span>。
        点评是针对模型输出的判断，不构成对任何具体产品的建议。
      </div>

      {cases.map((c) => {
        const retention =
          c.retentionPreset === "custom"
            ? c.customRetention
            : (() => {
                const p = presetById[c.retentionPreset];
                return { anchors: p?.anchors ?? [], alpha: presets.alpha ?? 0.85, name: p?.name };
              })();

        const sim = (() => {
          const params = mergeParams(c.params);
          const ctx = buildContext(retention, 12);
          const out = {};
          for (const k of MECHANISMS) out[k] = simulateMechanism(k, ctx, params).summary;
          return { params, ctx, out };
        })();

        const order = MECHANISMS.slice().sort((a, b) => sim.out[b].ltv12 - sim.out[a].ltv12);
        const d30 = sim.ctx.curve.r(30);
        const anyPayback = order.some((k) => sim.out[k].paybackMonth);

        return (
          <div className="case" key={c.id}>
            <h3>{c.title}</h3>
            <p className="scenario">{c.scenario}</p>

            <div className="metrics">
              <div>D30 留存<b>{(d30 * 100).toFixed(1)}%</b></div>
              <div>CAC<b>¥{sim.params.common.cac}</b></div>
              {order.map((k, i) => (
                <div key={k}>
                  {SHORT[k]} LTV{i === 0 ? "（最优）" : ""}
                  <b style={{ color: i === 0 ? "var(--ok)" : undefined }}>¥{fmt(sim.out[k].ltv12)}</b>
                </div>
              ))}
              <div>回本<b>{anyPayback ? order.map((k) => sim.out[k].paybackMonth).filter(Boolean).sort((a, b) => a - b)[0] + " 个月" : "12 个月内无"}</b></div>
            </div>

            <table style={{ marginTop: 4 }}>
              <thead>
                <tr>
                  <th>机制</th>
                  <th className="num">LTV</th>
                  <th className="num">LTV/CAC</th>
                  <th className="num">回本</th>
                </tr>
              </thead>
              <tbody>
                {order.map((k) => (
                  <tr key={k} className={k === order[0] ? "win" : ""}>
                    <td>{MECHANISM_LABELS[k]}</td>
                    <td className="num">¥{fmt(sim.out[k].ltv12)}</td>
                    <td className="num">{sim.out[k].ltvCac ? fmt(sim.out[k].ltvCac) : "—"}</td>
                    <td className="num">{sim.out[k].paybackMonth ? `${sim.out[k].paybackMonth} 月` : "> 12 月"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="comment">
              <b>我的点评</b>
              {c.comment}
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={() => onLoad(retention, c.params)}>
                把这组参数载入模拟器 →
              </button>
              <span className="tiny">载入后可在「三机制对比」页继续调参数</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
