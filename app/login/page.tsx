"use client";
// 登录页：居中卡片（对照 v1 的 login-screen：品牌 + 用户名/密码 + 登录按钮）
// 服务端启用 Cloudflare Turnstile 时，在登录按钮上方渲染人机验证，令牌随登录请求提交
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, theme } from "antd";
import { LineChartOutlined } from "@ant-design/icons";
import { api } from "../../lib/client";
import { useThemeMode } from "../providers";

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// 按需加载 Turnstile 脚本（整页只加载一次；失败允许重试）
let turnstileLoading: Promise<any> | null = null;
function loadTurnstile(): Promise<any> {
  const w = window as any;
  if (w.turnstile) return Promise.resolve(w.turnstile);
  turnstileLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.onload = () => resolve(w.turnstile);
    s.onerror = () => {
      turnstileLoading = null;
      reject(new Error("人机验证组件加载失败，请检查网络后刷新页面"));
    };
    document.head.appendChild(s);
  });
  return turnstileLoading;
}

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const { dark } = useThemeMode();
  const [loading, setLoading] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [cfToken, setCfToken] = useState("");
  const widgetBox = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  // 询问服务端是否启用人机验证
  useEffect(() => {
    api("/api/auth/config")
      .then((c) => setSiteKey(c.turnstileSiteKey || null))
      .catch(() => {});
  }, []);

  // 渲染 Turnstile 组件；令牌一次性，过期或出错即清空，需重新验证
  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstile()
      .then((ts) => {
        if (cancelled || !widgetBox.current) return;
        widgetId.current = ts.render(widgetBox.current, {
          sitekey: siteKey,
          action: "login",
          theme: dark ? "dark" : "light",
          size: "flexible",
          callback: (t: string) => setCfToken(t),
          "expired-callback": () => setCfToken(""),
          "error-callback": () => setCfToken(""),
        });
      })
      .catch((e) => message.error(e.message));
    return () => {
      cancelled = true;
      if (widgetId.current) (window as any).turnstile?.remove(widgetId.current);
      widgetId.current = null;
      setCfToken("");
    };
    // message 引用变化不应重建组件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, dark]);

  const onFinish = async (values: { username: string; password: string }) => {
    if (siteKey && !cfToken) {
      message.warning("请先完成人机验证");
      return;
    }
    setLoading(true);
    try {
      const r = await api("/api/auth/login", {
        body: {
          username: String(values.username || "").trim(),
          password: values.password,
          turnstileToken: cfToken || undefined,
        },
      });
      // 与 v1 一致：默认密码登录成功后提示尽快修改
      if (r.isDefaultPassword) message.warning("当前为默认密码，建议到「设置」中修改");
      router.push("/");
    } catch (e: any) {
      message.error(e.message || "登录失败");
      // 令牌已被服务端消费（无论成败），失败后换一个新的
      if (widgetId.current) {
        (window as any).turnstile?.reset(widgetId.current);
        setCfToken("");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: token.colorBgLayout,
        padding: 16,
      }}
    >
      <Card style={{ width: "100%", maxWidth: 360, boxShadow: token.boxShadowSecondary }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div
            style={{
              width: 44,
              height: 44,
              margin: "0 auto 10px",
              borderRadius: 10,
              background: token.colorPrimary,
              color: token.colorTextLightSolid,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
            }}
          >
            <LineChartOutlined />
          </div>
          <h1 style={{ fontSize: 17, fontWeight: 600, marginBottom: 3, color: token.colorText }}>中转站余额监控</h1>
          <p style={{ fontSize: 12, color: token.colorTextSecondary }}>请登录以继续</p>
        </div>
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="username"
            label="用户名"
            initialValue="admin"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password placeholder="默认 admin123" autoComplete="current-password" />
          </Form.Item>
          {siteKey && (
            <Form.Item>
              <div ref={widgetBox} style={{ minHeight: 65 }} />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block loading={loading} disabled={!!siteKey && !cfToken}>
            登 录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
