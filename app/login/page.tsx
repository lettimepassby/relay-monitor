"use client";
// 登录页：居中卡片（对照 v1 的 login-screen：品牌 + 用户名/密码 + 登录按钮）
import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, theme } from "antd";
import { LineChartOutlined } from "@ant-design/icons";
import { api } from "../../lib/client";

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const r = await api("/api/auth/login", {
        body: { username: String(values.username || "").trim(), password: values.password },
      });
      // 与 v1 一致：默认密码登录成功后提示尽快修改
      if (r.isDefaultPassword) message.warning("当前为默认密码，建议到「设置」中修改");
      router.push("/");
    } catch (e: any) {
      message.error(e.message || "登录失败");
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
          <Button type="primary" htmlType="submit" block loading={loading}>
            登 录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
