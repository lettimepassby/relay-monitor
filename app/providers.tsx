"use client";
// 全局 Provider：深浅色主题（沿用 v1 的 localStorage 键 app-shell-theme）+ PWA SW 注册
import { createContext, useContext, useEffect, useState } from "react";
import { ConfigProvider, App, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";

const ThemeCtx = createContext<{ dark: boolean; toggle: () => void }>({
  dark: false,
  toggle: () => {},
});

export const useThemeMode = () => useContext(ThemeCtx);

export default function Providers({ children }: { children: React.ReactNode }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    // 主题恢复：显式保存优先，其次跟随系统（与 v1 行为一致）
    const saved = localStorage.getItem("app-shell-theme");
    if (saved === "dark") setDark(true);
    else if (!saved && window.matchMedia?.("(prefers-color-scheme: dark)").matches) setDark(true);
    // PWA：注册 service worker（网络优先壳缓存，来自 v1.12）
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  const toggle = () =>
    setDark((d) => {
      const next = !d;
      localStorage.setItem("app-shell-theme", next ? "dark" : "light");
      return next;
    });

  return (
    <ThemeCtx.Provider value={{ dark, toggle }}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: { colorPrimary: "#1677ff", borderRadius: 6 },
        }}
      >
        <App>{children}</App>
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}
