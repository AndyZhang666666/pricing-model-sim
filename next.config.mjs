/** @type {import('next').NextConfig} */

// GitHub Pages 静态导出：本项目全部计算在浏览器端完成，没有服务端依赖。
// basePath 必须等于仓库名，否则 Pages 上的资源路径会 404。
const repo = "pricing-model-sim";

const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  basePath: `/${repo}`,
  assetPrefix: `/${repo}/`,
  trailingSlash: true,
};

export default nextConfig;
