// Next.js 服务启动钩子：初始化运行时单例并启动后台任务
//（60 秒刷新循环、告警评估、每日日报调度——v1 server.js 尾部逻辑的 v2 承载点）
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
