import assert from "node:assert/strict";
import fs from "node:fs";
import { simulateAll, overrideParams } from "../lib/model.js";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const url = process.env.TEST_URL || "http://127.0.0.1:8804/pricing-model-sim/";
const out = process.env.EVIDENCE_DIR || "/tmp/pricing-browser";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
    headless: true,
    channel: process.env.CHROME_CHANNEL || "chrome",
  }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const tab = (name) =>
  page
    .getByRole("button", { name: new RegExp("^" + name) })
    .first()
    .click();
async function range(name, value) {
  await page.getByRole("slider", { name, exact: true }).evaluate((e, v) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(e, String(v));
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
async function download(file) {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出本组比较", exact: true }).click();
  const d = await waiting;
  await d.saveAs(out + "/" + file + ".json");
  return JSON.parse(fs.readFileSync(out + "/" + file + ".json", "utf8"));
}
try {
  await page.goto(url + "#unknown");
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("spinbutton", { name: "D1 留存（%）", exact: true })
    .fill("");
  await page
    .getByRole("spinbutton", { name: "D1 留存（%）", exact: true })
    .press("Escape");
  assert.equal(
    await page
      .getByRole("spinbutton", { name: "D7 留存（%）", exact: true })
      .inputValue(),
    "24",
  );
  await page
    .getByRole("spinbutton", { name: "D1 留存（%）", exact: true })
    .fill("10");
  await page
    .getByRole("spinbutton", { name: "D1 留存（%）", exact: true })
    .press("Enter");
  await page.waitForFunction(
    () =>
      Number(document.querySelector('[aria-label="D7 留存（%）"]').value) <= 10,
  );
  assert.ok(
    Number(
      await page
        .getByRole("spinbutton", { name: "D7 留存（%）", exact: true })
        .inputValue(),
    ) <= 10,
  );
  await page
    .getByRole("spinbutton", { name: "D30 留存（%）", exact: true })
    .fill("0");
  await page
    .getByRole("spinbutton", { name: "D30 留存（%）", exact: true })
    .press("Enter");
  await page.waitForFunction(
    () => document.querySelector('[aria-label="D90 留存（%）"]').value === "0",
  );
  assert.equal(
    await page
      .getByRole("spinbutton", { name: "D90 留存（%）", exact: true })
      .inputValue(),
    "0",
  );
  let d = await download("zero-anchor");
  assert.equal(d.retention.anchors.find((a) => a.day === 30).retention, 0);
  assert.equal(d.curve.anchors.find((a) => a.day === 30).retention, 0);
  await page.reload();
  await page.waitForLoadState("networkidle");
  assert.equal(
    await page
      .getByRole("spinbutton", { name: "D30 留存（%）", exact: true })
      .inputValue(),
    "0",
  );
  await page.getByRole("button", { name: "恢复全部默认", exact: true }).click();
  await tab("三机制对比");
  await range("开始试用的比例", 0.12);
  await range("免费试用天数", 15);
  d = await download("custom");
  await tab("敏感性分析");
  const table = page.getByRole("region", {
    name: "切换点附近明细",
    exact: true,
  });
  await table.waitFor();
  const row = table.locator("tbody tr").first();
  const expected = simulateAll(
    d.retention,
    overrideParams(d.params, { subscription: { monthlyPrice: 4 } }),
  );
  assert.equal(
    (await row.locator("td").nth(2).innerText()).trim(),
    "¥" + expected.results.subscription.summary.ltv12.toFixed(2),
  );
  await tab("三机制对比");
  assert.equal(
    await page
      .getByRole("slider", { name: "开始试用的比例", exact: true })
      .inputValue(),
    "0.12",
  );
  await range("获客成本 CAC", 0);
  assert.match(
    await page
      .getByRole("region", { name: "十二个月机制汇总", exact: true })
      .innerText(),
    /不适用/,
  );
  await range("单集价格", 0);
  await range("月费", 0);
  assert.match(await page.locator(".verdict").innerText(), /LTV 并列/);
  d = await download("zero-prices");
  assert.ok(d.verdict.tie);
  assert.ok(
    Object.values(d.results).every(
      (r) =>
        r.summary.ltv12 === 0 &&
        Number.isFinite(r.summary.expectedUnlocks) &&
        Number.isFinite(r.summary.expectedPaidMonths),
    ),
  );
  await range("单集价格", 1);
  await range("付费用户月均解锁", 1);
  await range("付费率（首月）", 0.25);
  await range("免费集数", 0);
  await range("切订阅门槛", 0);
  await range("每月分流比例", 1);
  await range("切换摩擦", 1);
  await page
    .getByText("核对混合机制的逐月状态（每名新增用户）", { exact: true })
    .click();
  const trace = page.getByRole("region", {
    name: "混合机制逐月状态",
    exact: true,
  });
  assert.equal(await trace.locator("tbody tr").count(), 12);
  d = await download("conserved-pool");
  assert.equal(d.results.hybrid.summary.expectedUnlocks, 0.25);
  assert.equal(d.results.hybrid.summary.churnedBySwitch, 0.25);
  assert.equal(d.results.hybrid.trace[1].unlockPool, 0);
  await tab("案例库");
  assert.equal(await page.locator(".case button").count(), 4);
  for (let i = 0; i < 4; i++) {
    await page.locator(".case button").nth(i).click();
    assert.ok(
      await page
        .getByRole("slider", { name: "获客成本 CAC", exact: true })
        .isVisible(),
    );
    await tab("案例库");
  }
  await page.locator(".case button").nth(3).click();
  await page.reload();
  await page.waitForLoadState("networkidle");
  assert.equal(
    await page
      .getByRole("slider", { name: "获客成本 CAC", exact: true })
      .inputValue(),
    "12",
  );
  for (const name of ["留存曲线", "三机制对比", "敏感性分析", "案例库"]) {
    await tab(name);
    for (const width of [1440, 768, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(
        () => document.documentElement.scrollWidth <= innerWidth,
        {},
        { timeout: 2000 },
      );
      if (name === "留存曲线") {
        await page.waitForFunction(() => {
          const svg = document.querySelector('svg[aria-label^="留存假设曲线"]');
          return (
            Math.abs(
              svg.viewBox.baseVal.width - svg.getBoundingClientRect().width,
            ) < 1
          );
        });
        assert.ok(
          await page
            .locator('svg[aria-label^="留存假设曲线"] text')
            .evaluateAll((es) =>
              es.every((e) => {
                const b = e.getBBox(),
                  width = e.ownerSVGElement.viewBox.baseVal.width;
                return b.x >= 0 && b.x + b.width <= width;
              }),
            ),
          "全部刻度应在图表内部",
        );
      }
    }
  }
  await page.getByRole("button", { name: "恢复全部默认", exact: true }).click();
  await tab("留存曲线");
  const svg = page.locator('svg[aria-label^="留存假设曲线"]');
  const anchor = await svg.locator("circle").nth(1).boundingBox();
  const graph = await svg.boundingBox();
  await page.mouse.move(
    anchor.x + anchor.width / 2,
    anchor.y + anchor.height / 2,
  );
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.move(graph.x + graph.width - 30, graph.y + 180, {
    steps: 8,
  });
  await page.mouse.up();
  d = await download("dragged-anchor");
  assert.equal(d.retention.anchors[0].retention, 0.42);
  assert.notEqual(
    d.retention.anchors[1].retention,
    0.24,
    "横向拖动仍修改原D7锚点",
  );
  assert.ok(
    d.retention.anchors[1].retention >= d.retention.anchors[2].retention,
  );
  await page.getByRole("button", { name: "恢复全部默认", exact: true }).click();
  await tab("三机制对比");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .locator(".verdict")
    .screenshot({ path: out + "/mobile-decision.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(250);
  await page
    .locator(".verdict")
    .screenshot({ path: out + "/desktop-decision.png" });
  await page.evaluate(() =>
    localStorage.setItem("pricing-model:assumptions:v1", "{bad"),
  );
  await page.reload();
  await page.waitForLoadState("networkidle");
  assert.match(await page.locator("body").innerText(), /旧假设草稿无法恢复/);
  await page.evaluate(() => {
    location.hash = "retention";
  });
  await page
    .getByRole("spinbutton", { name: "D1 留存（%）", exact: true })
    .waitFor();
  await page
    .getByRole("spinbutton", { name: "D1 留存（%）", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(
    Number(
      await page
        .getByRole("spinbutton", { name: "D1 留存（%）", exact: true })
        .inputValue(),
    ) < 42,
  );
  const c = await browser.newContext();
  await c.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw Error("blocked");
      },
    }),
  );
  const p = await c.newPage();
  await p.goto(url);
  await p.waitForLoadState("networkidle");
  assert.match(
    await p.locator("body").innerText(),
    /本地存储不可用|假设保存失败/,
  );
  await c.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: zero/monotonic anchors, exact single-field sweep, exported provenance, zero-price ties, zero-CAC state, conserved cohort trace, 4 presets/reload, 4 tabs × 4 widths, corrupt/blocked storage, hash and keyboard input; no page errors.",
  );
} finally {
  await browser.close();
}
