/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker 部署用 standalone 产物（node server.js 单进程，含后台刷新循环）
  output: "standalone",
  // mysql2 是原生 CJS 服务端依赖，不打包进 serverless bundle
  serverExternalPackages: ["mysql2"],
  // 运行时数据（站点凭证/会话密钥）绝不进构建产物：
  // 文件追踪会因代码引用 ./data 路径把整个目录拷进 standalone，必须显式排除
  outputFileTracingExcludes: { "*": ["./data/**", "data/**"] },
  // antd/pro-components ESM 转译
  transpilePackages: [
    "antd",
    "@ant-design/pro-components",
    "@ant-design/pro-layout",
    "@ant-design/pro-table",
    "@ant-design/pro-form",
    "@ant-design/pro-card",
    "@ant-design/icons",
    "@ant-design/plots",
    "rc-util",
    "rc-pagination",
    "rc-picker",
  ],
};

export default nextConfig;
