// 构建后处理。
//
// 只做一件事：在 out/ 里写一个空的 .nojekyll。
//
// 为什么必须有：GitHub Pages 默认用 Jekyll 处理静态文件，而 Jekyll 会**忽略
// 所有下划线开头的目录**。Next.js 的静态产物全部放在 out/_next/ 下面 ——
// 没有这个文件，部署上去的页面能打开，但样式和脚本全 404，看起来就像一个白板。
//
// 放在这里而不是只写在 CI workflow 里，是因为本地 `npm run build` 之后用
// `npx serve out` 预览时遇到的是同一套规则。两处行为一致，本地看到的就是线上会看到的。

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "..", "out");

if (!existsSync(out)) {
  mkdirSync(out, { recursive: true });
}

writeFileSync(resolve(out, ".nojekyll"), "");
console.log("postbuild: 已写入 out/.nojekyll（否则 Pages 上的 _next 目录会被 Jekyll 忽略）");
