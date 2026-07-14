"use client";
// 设置页：全局设置（刷新间隔/低余额阈值）+ 面板账号（改用户名/密码）+ 关于
// 对照 v1 app.js renderSettings(1397-1460)：文案与保存行为逐条平移；
// 主题切换由 antd 主题体系接管、退出登录在顶栏用户菜单，故不在本页重复。
import { useEffect, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import { Alert, App, Button, Input, InputNumber, Space, Tag, Typography } from "antd";
import { api } from "../../../lib/client";

const { Text } = Typography;

// 单行设置项：左侧标题+说明，右侧控件（对照 v1 的 .set-row 结构）
function SetRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "14px 0",
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 220 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {desc}
        </Text>
      </div>
      <div>{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { message } = App.useApp();

  // 全局设置（对照 v1 state.settings：refreshIntervalSec / lowBalanceUsd）
  const [interval, setIntervalSec] = useState<number | null>(null);
  const [low, setLow] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // 面板账号（/api/auth/me：用户名 + 默认密码提醒）
  const [me, setMe] = useState<{ username: string; isDefaultPassword: boolean } | null>(null);
  const [username, setUsername] = useState("");
  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  // 关于（/api/meta 的 app：版本号 + 构建 commit）
  const [appInfo, setAppInfo] = useState<{ version: string; commit: string | null } | null>(null);

  // 挂载时拉一次元信息与会话信息（对照 v1 bootData：meta 提供 settings/app）
  useEffect(() => {
    api("/api/meta")
      .then((m) => {
        setIntervalSec(m.settings.refreshIntervalSec);
        setLow(m.settings.lowBalanceUsd);
        setAppInfo(m.app || null);
      })
      .catch(() => {});
    api("/api/auth/me")
      .then((r) => {
        setMe(r);
        setUsername(r.username || "");
      })
      .catch(() => {});
  }, []);

  // 保存全局设置（对照 v1 set-save：Number 转换交给服务端钳制范围，回填响应里的 settings）
  const onSaveSettings = async () => {
    setSaving(true);
    try {
      const r = await api("/api/settings", {
        method: "PUT",
        body: { refreshIntervalSec: Number(interval), lowBalanceUsd: Number(low) },
      });
      // 服务端可能钳制过（间隔最小 10 秒、阈值最小 0），以返回值为准回显
      setIntervalSec(r.settings.refreshIntervalSec);
      setLow(r.settings.lowBalanceUsd);
      message.success("设置已保存");
    } catch (e: any) {
      message.error(e.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 修改用户名/密码（对照 v1 pw-save：校验交给服务端，成功后清空密码框）
  const onChangePassword = async () => {
    setPwSaving(true);
    try {
      await api("/api/auth/password", {
        body: { oldPassword: pwOld, newPassword: pwNew, username: username.trim() || undefined },
      });
      setPwOld("");
      setPwNew("");
      message.success("密码已修改");
      // 重新拉会话信息：用户名可能已改、默认密码提醒随之消失
      api("/api/auth/me")
        .then((r) => {
          setMe(r);
          setUsername(r.username || "");
        })
        .catch(() => {});
    } catch (e: any) {
      message.error(e.message || "修改失败");
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <PageContainer title="设置" subTitle="刷新策略、告警阈值与面板账号">
      <Space direction="vertical" size={16} style={{ display: "flex" }}>
        <ProCard title="全局设置" headerBordered>
          <SetRow title="自动刷新间隔" desc="后台按此间隔自动查询各中转站余额">
            <Space>
              <InputNumber
                value={interval}
                onChange={(v) => setIntervalSec(v)}
                min={10}
                style={{ width: 120 }}
              />
              <Text type="secondary">秒</Text>
            </Space>
          </SetRow>
          <SetRow title="全局低余额阈值" desc="剩余余额低于此值时标记为「余额偏低」（可被单站阈值覆盖）">
            <Space>
              <Text type="secondary">$</Text>
              <InputNumber value={low} onChange={(v) => setLow(v)} min={0} style={{ width: 120 }} />
            </Space>
          </SetRow>
          <SetRow title="保存设置" desc="应用刷新间隔与告警阈值">
            <Button type="primary" loading={saving} onClick={onSaveSettings}>
              保存
            </Button>
          </SetRow>
        </ProCard>

        <ProCard title="面板账号" headerBordered>
          {me?.isDefaultPassword && (
            <Alert
              type="warning"
              showIcon
              message="当前为默认密码 admin123，建议尽快修改"
              style={{ marginBottom: 16 }}
            />
          )}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600 }}>修改登录密码</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              当前用户：{me?.username || "admin"}，密码至少 6 位
            </Text>
          </div>
          <Space wrap align="end" size={12}>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>用户名</div>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: 180 }} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>原密码</div>
              <Input.Password value={pwOld} onChange={(e) => setPwOld(e.target.value)} style={{ width: 180 }} />
            </div>
            <div>
              <div style={{ fontSize: 12, marginBottom: 4 }}>新密码</div>
              <Input.Password value={pwNew} onChange={(e) => setPwNew(e.target.value)} style={{ width: 180 }} />
            </div>
            <Button type="primary" loading={pwSaving} onClick={onChangePassword}>
              修改
            </Button>
          </Space>
        </ProCard>

        <ProCard title="关于" headerBordered>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            中转站余额监控{" "}
            {appInfo && (
              <Tag>
                v{appInfo.version}
                {appInfo.commit ? ` · ${appInfo.commit}` : ""}
              </Tag>
            )}
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            支持 New API（访问令牌 / sk 密钥）与 Sub2API（登录令牌 / 账号密码自动续期）。界面基于
            Ant Design Pro 构建。凭证存储于你配置的 MySQL 数据库。
          </Text>
        </ProCard>
      </Space>
    </PageContainer>
  );
}
