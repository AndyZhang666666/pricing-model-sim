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
import { DRAFT_KEY, decodeDraft, comparisonSnapshot } from "@/lib/session";
import DataTable from "@/components/data-table";

const TABS = [
  { id: "retention", label: "留存曲线", sub: "第一步：定义用户" },
  { id: "compare", label: "三机制对比", sub: "同组假设下比较" },
  { id: "sensitivity", label: "敏感性分析", sub: "临界点在哪" },
  { id: "cases", label: "案例库", sub: "合成案例 + 点评" },
];

const deepClone = (x) => JSON.parse(JSON.stringify(x));

export default function Home() {
  const [tab, setTab] = useState("retention");
  const [retention, setRetention] = useState(() =>
    deepClone(DEFAULT_RETENTION),
  );
  const [params, setParams] = useState(() => deepClone(DEFAULT_PARAMS));
  const [presetId, setPresetId] = useState(null);
  const [restored, setRestored] = useState(false),
    [notice, setNotice] = useState("假设仅保存于当前浏览器，不上传。");
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY),
        d = decodeDraft(raw);
      if (d) {
        setRetention(d.retention);
        setParams(d.params);
        setNotice("已恢复本机假设，输出按当前模型重新计算。");
      } else if (raw) {
        localStorage.removeItem(DRAFT_KEY);
        setNotice("旧假设草稿无法恢复，已使用默认值。");
      }
    } catch {
      setNotice("本地存储不可用，仍可比较和导出。");
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ version: 1, retention, params }),
      );
    } catch {
      setNotice("假设保存失败，当前计算仍可使用。");
    }
  }, [retention, params, restored]);

  const setParam = (group, key, value) => {
    if (group === "retention") {
      setRetention((r) => ({ ...r, [key]: value }));
      setPresetId(null);
      return;
    }
    setParams((prev) => {
      const next = { ...prev, [group]: { ...prev[group], [key]: value } };
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

  const sim = useMemo(() => {
    try {
      return simulateAll(retention, params);
    } catch (e) {
      return { error: e.message };
    }
  }, [retention, params]);

  // 用 URL hash 记住当前 tab，方便直接分享到某一页
  useEffect(() => {
    const read = () => {
      const h = location.hash.slice(1);
      setTab(TABS.some((t) => t.id === h) ? h : "retention");
    };
    read();
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  }, []);
  const go = (id) => {
    setTab(id);
    if (typeof window !== "undefined")
      window.history.replaceState(null, "", `#${id}`);
  };
  function reset() {
    setRetention(deepClone(DEFAULT_RETENTION));
    setParams(deepClone(DEFAULT_PARAMS));
    setPresetId(null);
    setNotice("已恢复默认假设。");
  }
  function save() {
    const a = document.createElement("a"),
      u = URL.createObjectURL(
        new Blob(
          [JSON.stringify(comparisonSnapshot(retention, sim), null, 2)],
          { type: "application/json" },
        ),
      );
    a.href = u;
    a.download = "pricing-comparison.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
    setNotice("已导出假设、结果、逐月状态与模型边界。");
  }
  if (sim.error)
    return (
      <main className="wrap">
        <h1>这组假设暂时无法计算</h1>
        <p role="alert">{sim.error}</p>
        <button onClick={reset}>恢复默认比较</button>
      </main>
    );

  return (
    <div className="wrap">
      <header className="top">
        <a className="back" href="https://andyzhang666666.github.io/#projects">
          ← Andy 的作品
        </a>
        <h1>Pricing Model Sim</h1>
        <p>
          给一条留存曲线和几个定价参数，算出「单次解锁 / 包月订阅 /
          混合」三种付费机制 12 个月的 ARPU、LTV、回本周期，比较
          <b>什么条件下，机制排序会改变</b>。
        </p>
        <div className="meta">
          本地计算 · 每名新增用户的统一口径 · 月末切换、次月订阅 ·
          不作真实定价或收益承诺
        </div>
      </header>

      <div className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            aria-pressed={tab === t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => go(t.id)}
          >
            {t.label}
            <small>{t.sub}</small>
          </button>
        ))}
      </div>
      <div className="utilitybar">
        <p role="status">{notice}</p>
        <button onClick={reset}>恢复全部默认</button>
        <button className="primary" onClick={save}>
          导出本组比较
        </button>
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
                  setRetention((r) => ({
                    ...r,
                    name: "自定义",
                    anchors: list,
                  }));
                  setPresetId(null);
                }}
              />
            </div>
          </div>

          <div>
            <div className="panel">
              <h2>这条曲线在告诉模型什么</h2>
              <p className="small">
                留存曲线是后续所有计算的唯一输入。三种机制的收入都乘在这条曲线上
                —— 换句话说，<b>定价参数再优化，也救不了一条留不住的曲线</b>。
              </p>
              <DataTable label="大盘月度留存" style={{ marginTop: 12 }}>
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
                        {i === 0
                          ? "—"
                          : ((s / sim.ctx.S[i - 1]) * 100).toFixed(1) + "%"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              <div className="note">
                口径：第 k 个月的月初在册比例 = r(30 × (k−1))，所以第 1 个月恒为
                100%（新用户当月必然在册）， 第 2 个月 = D30
                留存。按月取月初值而不是按月内积分，是为了让手算校验能对得上 ——
                取舍理由写在 <span className="mono">docs/DECISIONS.md</span>。
              </div>
            </div>

            <div className="panel">
              <h2>订阅人群的生存曲线</h2>
              <p className="small">
                模型<b>假设</b>订阅人群的生存曲线不同于大盘，并用 S<sub>k</sub>
                <sup>α</sup> 表示这种差异；这不是已经观察到的选择效应。 当前 α ={" "}
                {retention.alpha ?? 0.85}。α = 1
                表示两条曲线一致，参数需要真实数据校准。
              </p>
              <DataTable label="订阅人群留存假设" style={{ marginTop: 12 }}>
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
              </DataTable>
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
          <b>已知局限</b>
          ：模型假设同一个月里新增的用户在月内均匀到达（按月网格离散化）；
          不考虑季节性、促销活动、退款与坏账；平台抽成按固定比例处理，不区分首月/续费。
          这些简化也可能改变机制排序，需要真实数据校准，不能当作财务预测。
        </p>
        <p style={{ margin: 0 }}>
          <a href="https://github.com/AndyZhang666666/pricing-model-sim">
            查看模型、合成资料与验证记录
          </a>
        </p>
      </footer>
    </div>
  );
}
