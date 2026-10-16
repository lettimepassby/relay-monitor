// Next.js 服务启动钩子：初始化运行时单例并启动后台任务
//（60 秒刷新循环、告警评估、每日日报调度——v1 server.js 尾部逻辑的 v2 承载点）
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 关掉 Happy Eyeballs（autoSelectFamily）并优先 IPv4：它给多地址域名的每个地址只留 250ms，
    // 事件循环稍有卡顿就会把其实已建好的连接当超时关掉，Cloudflare 这类多 IP 站点会整片 "fetch failed"
    // （2026-10 生产事故，已在容器内复现）。容器没有 IPv6，这个机制本就没有收益。
    const net = await import("node:net");
    const dns = await import("node:dns");
    net.setDefaultAutoSelectFamily(false);
    dns.setDefaultResultOrder("ipv4first");
    try {
      const { getRuntime } = await import("./lib/runtime.js");
      await getRuntime();
    } catch (err: any) {
      console.error(`\n[致命] 服务初始化失败：${err?.message}\n`);
      // 生产环境直接退出（重启由容器编排负责）；开发环境保留进程便于排查
      if (process.env.NODE_ENV === "production") process.exit(1);
    }
  }
}
