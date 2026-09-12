"use client";

// 主页面：四个 tab 共享一份状态（留存曲线 + 参数）。
//
// 状态管理刻意保持最简：一个 useMemo 从「曲线 + 参数」算出全部结果，
// 任何一处改动都只是改 state，结果自动重算。没有 store、没有 reducer ——
// 这个工具的数据流是一条直线，用不到更重的东西。

import { useEffect, useMemo, useState } from "react";
import RetentionEditor from "@/components/retention-editor";
import Compare from "@/components/compare";
import Sensitivity from "@/components/sensitivity";
import Cases from "@/components/cases";
import {
  DEFAULT_PARAMS,
  DEFAULT_RETENTION,
  mergeParams,
  buildContext,
  simulateMechanism,
  simulateAll,
  MECHANISMS,
} from "@/lib/model";
import presetsData from "@/data/presets.json";
import casesData from "@/data/cases.json";

const TABS = [
  { id: "retention", label: "留存曲线", sub: "第一步：定义用户" },
  { id: "compare", label: "三机制对比", sub: "核心：该选哪种" },
  { id: "sensitivity", label: "敏感性分析", sub: "临界点在哪" },
  { id: "cases", label: "案例库", sub: "合成案例 + 点评" },
];

const deepClone = (x) => JSON.parse(JSON.stringify(x));

export default function Home() {
  const [tab, setTab] = useState("retention");
  const [retention, setRetention] = useState(() => deepClone(DEFAULT_RETENTION));
  const [params, setParams] = useState(() => deepClone(DEFAULT_PARAMS));
  const [presetId, setPresetId] = useState(null);

  const setParam = (group, key, value) => {
    setParams((prev) => {
      const next = { ...prev, [group]: { ...prev[group], [key]: value } };
      if (group === "retention") {
        setRetention((r) => ({ ...r, [key]: value }));
      }
      return next;
    });
    // 手改参数就不再跟随任何预设
    if (presetId) setPresetId(null);
  };

  const applyPreset = (preset) => {
    setPresetId(preset.id);
    setRetention({
      name: preset.name,
      alpha: presetsData.alpha ?? 0.85,
      anchors: deepClone(preset.anchors),
    });
  };

  const sim = useMemo(
    () => simulateAll(retention, params),
    [retention, params],
  );

  // 用 URL hash 记住当前 tab，方便直接分享到某一页
  useEffect(() => {
    const h = window.location.hash.replace("#", "");
    if (TABS.some((t) => t.id === h)) setTab(h);
  }, []);
  const go = (id) => {
    setTab(id);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `#${id}`);
  };

  return (
    <div className="wrap">
      <header className="top">
        <h1>Pricing Model Sim</h1>
        <p>
          给一条留存曲线和几个定价参数，算出「单次解锁 / 包月订阅 / 混合」三种付费机制
          12 个月的 ARPU、LTV、回本周期，并回答一个问题：<b>你的业务该选哪种</b>。
        </p>
        <div className="meta">
          全部计算在浏览器里完成，没有服务端 · 公式与实际口径见{" "}
          <code>lib/model.js</code> · 校验产物在 <code>results/</code>
        </div>
      </header>

      <div className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => go(t.id)}>
            {t.label}
            <small>{t.sub}</small>
          </button>
        ))}
      </div>

      {tab === "retention" && (
        <div className="grid">
          <div>
            <div className="panel">
              <h2>选一条预设曲线</h2>
              <div className="row wrap tight">
                {presetsData.presets.map((p) => (
                  <button
                    key={p.id}
                    className={presetId === p.id ? "primary" : ""}
                    onClick={() => applyPreset(p)}
                  >
                    {p.name}
                  </button>
                ))}
                <button
                  onClick={() => {
                    setPresetId(null);
                    setRetention(deepClone(DEFAULT_RETENTION));
                  }}
                >
                  重置
                </button>
              </div>
              {presetId && (
                <p className="small" style={{ marginTop: 12, marginBottom: 0 }}>
                  {presetsData.presets.find((p) => p.id === presetId)?.why}
                </p>
              )}
            </div>

            <div className="panel">
              <h2>或者自己拖一条</h2>
              <RetentionEditor
                anchors={retention.anchors}
                onChange={(list) => {
                  setRetention((r) => ({ ...r, name: "自定义", anchors: list }));
                  setPresetId(null);
                }}
              />
            </div>
          </div>

          <div>
            <div className="panel">
              <h2>这条曲线在告诉模型什么</h2>
              <p className="small">
                留存曲线是后续所有计算的唯一输入。三种机制的收入都乘在这条曲线上 ——
                换句话说，<b>定价参数再优化，也救不了一条留不住的曲线</b>。
              </p>
              <table style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>月</th>
                    <th className="num">月初在册</th>
                    <th className="num">该月环比续存</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.ctx.S.slice(0, 8).map((s, i) => (
                    <tr key={i}>
                      <td>第 {i + 1} 月</td>
                      <td className="num">{(s * 100).toFixed(2)}%</td>
                      <td className="num">
                        {i === 0 ? "—" : ((s / sim.ctx.S[i - 1]) * 100).toFixed(1) + "%"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="note">
                口径：第 k 个月的月初在册比例 = r(30 × (k−1))，所以第 1 个月恒为 100%（新用户当月必然在册），
                第 2 个月 = D30 留存。按月取月初值而不是按月内积分，是为了让手算校验能对得上 ——
                取舍理由写在 <span className="mono">docs/DECISIONS.md</span>。
              </div>
            </div>

            <div className="panel">
              <h2>订阅人群的生存曲线</h2>
              <p className="small">
                订阅者是<b>自选出来的高意愿人群</b>，直接用大盘留存会低估他们的粘性。
                模型把大盘的月度生存率开 α 次方来修正：S<sub>k</sub><sup>α</sup>，
                当前 α = {retention.alpha ?? 0.85}。α = 1 表示订阅者和普通用户一样容易流失。
              </p>
              <table style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>月</th>
                    <th className="num">大盘在册</th>
                    <th className="num">订阅人群</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.ctx.S.slice(0, 8).map((s, i) => (
                    <tr key={i}>
                      <td>第 {i + 1} 月</td>
                      <td className="num">{(s * 100).toFixed(2)}%</td>
                      <td className="num" style={{ color: "var(--c-sub)" }}>
                        {(sim.ctx.Ssub[i] * 100).toFixed(2)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="row">
              <button className="primary" onClick={() => go("compare")}>
                下一步：对比三种机制 →
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "compare" && (
        <Compare sim={sim} params={sim.params} setParam={setParam} />
      )}

      {tab === "sensitivity" && (
        <Sensitivity retention={retention} baseParams={sim.params} />
      )}

      {tab === "cases" && (
        <Cases
          cases={casesData.cases}
          presets={presetsData}
          onLoad={(ret, p) => {
            setRetention(deepClone(ret));
            setParams(mergeParams(p));
            setPresetId(null);
            go("compare");
          }}
        />
      )}

      <footer>
        <p style={{ margin: "0 0 6px" }}>
          <b>已知局限</b>：模型假设同一个月里新增的用户在月内均匀到达（按月网格离散化）；
          不考虑季节性、促销活动、退款与坏账；平台抽成按固定比例处理，不区分首月/续费。
          这些简化在「比较三种机制的相对高低」这个用途上影响有限，但不能当作财务预测。
        </p>
        <p style={{ margin: 0 }}>
          合成数据说明见 <span className="mono">data/GENERATION.md</span> ·
          假设清单见 <span className="mono">docs/ASSUMPTIONS.md</span> ·
          校验脚本 <span className="mono">npm run check</span>
        </p>
      </footer>
    </div>
  );
}
