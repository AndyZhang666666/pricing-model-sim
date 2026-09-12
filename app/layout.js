import "./globals.css";

export const metadata = {
  title: "Pricing Model Sim — 付费机制模拟器",
  description:
    "给一条留存曲线和几个定价参数，算出单次解锁 / 包月订阅 / 混合三种付费机制 12 个月的 ARPU、LTV 与回本周期。",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
