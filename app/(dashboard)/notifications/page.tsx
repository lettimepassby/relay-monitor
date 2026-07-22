"use client";
// 通知页：渠道列表 / 添加编辑渠道弹窗 / 告警规则 / 每日日报
// 对照 v1 app.js renderNotify(587-680)、openChModal/renderChFields(1616-1673)、
// 通知相关事件处理(1925-2027)与 loadNotifications(2094)。
// v1 对通知页刻意跳过自动重绘（refreshCurrentView：表单未保存的输入会被清空），
// 因此本页只在挂载时加载一次，不做 30 秒轮询。
import { useEffect, useState } from "react";
import { PageContainer, ProCard } from "@ant-design/pro-components";
import {
  App,
  Avatar,
  Button,
  Checkbox,
  Empty,
  Input,
  List,
  Modal,
  Select,
  Switch,
  Tabs,
  theme,
  TimePicker,
  Typography,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SendOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../../../lib/client";

const { Text } = Typography;

// 渠道类型铭牌缩写（对照 v1 CH_PLATE）
const CH_PLATE: Record<string, string> = {
  telegram: "TG", dingtalk: "DT", wecom: "WC", feishu: "FS", bark: "BK",
  ntfy: "NF", serverchan: "SC", resend: "RS", smtp: "SM", webhook: "WH",
};

// 密钥类字段：编辑时不回显，留空提交表示保持不变（store.updateChannel 的空值保留策略）
const SECRET_KEYS = ["botToken", "secret", "token", "sendKey", "apiKey", "password", "deviceKey"];

// 阈值内部按天存储；界面按所选单位展示（对照 v1 etaRuleDisplay）
function etaRuleDisplay(r: any): number {
  const days = Number(r?.etaDays ?? 3);
  return r?.etaUnit === "hours" ? +(days * 24).toFixed(2) : +days.toFixed(2);
}

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
      <div style={{ minWidth: 220, maxWidth: 520 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {desc}
        </Text>
      </div>
      <div>{children}</div>
    </div>
  );
}

export default function NotificationsPage() {
  const { message, modal } = App.useApp();
  const { token } = theme.useToken(); // 深浅主题下均可读的语义 token

  // 通知数据（对照 v1 state.channels / state.rules / state.channelTypes / state.settings）
  const [loading, setLoading] = useState(true);
  const [channels, setChannels] = useState<any[]>([]);
  const [rules, setRules] = useState<any>({});
  const [channelTypes, setChannelTypes] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({});

  // 告警规则表单（阈值与间隔；开关直接落库，不进表单）
  const [etaVal, setEtaVal] = useState("");
  const [etaUnit, setEtaUnit] = useState<"days" | "hours">("days");
  const [renotify, setRenotify] = useState("24");
  const [errThreshold, setErrThreshold] = useState("1");
  const [errRetry, setErrRetry] = useState("30");
  const [rulesSaving, setRulesSaving] = useState(false);
  // 每类告警的推送渠道绑定（空 = 所有启用渠道）；选择即落库，与开关一致
  const [channelsFor, setChannelsFor] = useState<Record<string, string[]>>({});

  // 每日日报表单
  const [drEnabled, setDrEnabled] = useState(false);
  const [drTime, setDrTime] = useState("09:00");
  const [drChannelIds, setDrChannelIds] = useState<string[]>([]);
  const [drSaving, setDrSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState<{ text: string; html: string } | null>(null);

  // 渠道弹窗
  const [chOpen, setChOpen] = useState(false);
  const [editingCh, setEditingCh] = useState<any>(null); // null = 新增
  const [chName, setChName] = useState("");
  const [chType, setChType] = useState("");
  const [chConfig, setChConfig] = useState<Record<string, string>>({});
  const [chSaving, setChSaving] = useState(false);
  const [chTesting, setChTesting] = useState(false);
  const [rowTesting, setRowTesting] = useState<string | null>(null); // 列表行测试中的渠道 id

  // 服务端钳制后的规则回显到表单（如非法输入被忽略、eta 下限 1 小时），
  // 不然界面显示的是没生效的输入（对照 v1 rulesSave 后的回填）
  const syncRuleForm = (r: any) => {
    setEtaUnit(r?.etaUnit === "hours" ? "hours" : "days");
    setEtaVal(String(etaRuleDisplay(r)));
    setRenotify(String(r?.renotifyHours ?? 24));
    setErrThreshold(String(r?.errorThreshold ?? 1));
    setErrRetry(String(r?.errorRetrySec ?? 30));
    setChannelsFor(r?.channelsFor || {});
  };

  const syncDrForm = (s: any) => {
    setDrEnabled(!!s?.dailyReport?.enabled);
    setDrTime(s?.dailyReport?.time || "09:00");
    setDrChannelIds(s?.dailyReport?.channelIds || []);
  };

  // 挂载时加载：notifications 给渠道/规则/类型，meta 给 settings（对照 v1 bootData）
  useEffect(() => {
    (async () => {
      try {
        const [n, m] = await Promise.all([api("/api/notifications"), api("/api/meta")]);
        setChannels(n.channels);
        setRules(n.rules);
        setChannelTypes(n.channelTypes);
        setSettings(m.settings);
        syncRuleForm(n.rules);
        syncDrForm(m.settings);
      } catch (e: any) {
        message.error(e.message || "加载失败");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重新拉取渠道数据（对照 v1 loadNotifications）
  // 同步渠道绑定（删除渠道时服务端会清理其中的死 id），但不动阈值输入表单
  const reloadChannels = async () => {
    const n = await api("/api/notifications");
    setChannels(n.channels);
    setRules(n.rules);
    setChannelTypes(n.channelTypes);
    setChannelsFor(n.rules?.channelsFor || {});
  };

  // ---- 渠道操作 ---------------------------------------------------------------

  const toggleChannel = async (c: any) => {
    try {
      await api(`/api/notifications/channels/${c.id}`, { method: "PUT", body: { enabled: !c.enabled } });
      setChannels((list) => list.map((x) => (x.id === c.id ? { ...x, enabled: !c.enabled } : x)));
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const testChannel = async (c: any) => {
    setRowTesting(c.id);
    try {
      const r = await api("/api/notifications/test", { body: { channelId: c.id } });
      if (r.ok) message.success(`已发送到「${c.name}」`);
      else message.error(`发送失败：${r.error}`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRowTesting(null);
    }
  };

  const deleteChannel = (c: any) => {
    modal.confirm({
      title: `确定删除渠道「${c.name}」？`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api(`/api/notifications/channels/${c.id}`, { method: "DELETE" });
          await reloadChannels();
          message.success("已删除");
        } catch (e: any) {
          message.error(e.message);
        }
      },
    });
  };

  // ---- 渠道弹窗 ---------------------------------------------------------------

  // 打开弹窗：编辑时回填 config，但密钥字段不回显（留空提交 = 保持原值）
  const openChModal = (channel: any) => {
    const type = channel?.type || channelTypes[0]?.value || "";
    const t = channelTypes.find((x) => x.value === type);
    const cfg: Record<string, string> = {};
    for (const f of t?.fields || []) {
      const v = channel?.config?.[f.key] || "";
      cfg[f.key] = SECRET_KEYS.includes(f.key) ? "" : v;
    }
    setEditingCh(channel || null);
    setChType(type);
    setChName(channel?.name || "");
    setChConfig(cfg);
    setChOpen(true);
  };

  // 切换类型时清空动态字段（对照 v1 renderChFields(null)）；仅新增时可切
  const onChTypeChange = (type: string) => {
    setChType(type);
    setChConfig({});
  };

  // 表单载荷：按当前类型的字段定义取值并 trim（对照 v1 chFormPayload）
  const chFormConfig = () => {
    const t = channelTypes.find((x) => x.value === chType);
    const config: Record<string, string> = {};
    for (const f of t?.fields || []) config[f.key] = (chConfig[f.key] || "").trim();
    return config;
  };

  const saveChannel = async () => {
    const t = channelTypes.find((x) => x.value === chType);
    const config = chFormConfig();
    // 必填校验：编辑时密钥不回显，已配置过的空值视为「保持不变」不算缺失
    const missing = (t?.fields || []).filter(
      (f: any) => f.required && !config[f.key] && !editingCh?.config?.[f.key]
    );
    if (missing.length) {
      message.error(`请填写：${missing.map((f: any) => f.label).join("、")}`);
      return;
    }
    setChSaving(true);
    try {
      const payload = { name: chName.trim() || "未命名渠道", type: chType, config };
      if (editingCh) await api(`/api/notifications/channels/${editingCh.id}`, { method: "PUT", body: payload });
      else await api("/api/notifications/channels", { body: payload });
      setChOpen(false);
      await reloadChannels();
      message.success("已保存");
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setChSaving(false);
    }
  };

  // 弹窗内测试：按 type+config 试发未保存的配置（对照 v1 chTest）；
  // 编辑时密钥字段不回显，空值用已保存的原值补齐，否则测试必然失败
  const testChForm = async () => {
    const config = chFormConfig();
    if (editingCh?.config) {
      for (const k of Object.keys(config)) {
        if (!config[k] && editingCh.config[k]) config[k] = editingCh.config[k];
      }
    }
    setChTesting(true);
    try {
      const r = await api("/api/notifications/test", { body: { type: chType, config } });
      if (r.ok) message.success("测试消息已发送");
      else message.error(`发送失败：${r.error}`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setChTesting(false);
    }
  };

  // ---- 告警规则 ---------------------------------------------------------------

  // 开关即时落库（对照 v1 data-rule 点击）
  const toggleRule = async (key: string) => {
    try {
      const r = await api("/api/notifications/rules", { method: "PUT", body: { [key]: !rules[key] } });
      setRules(r.rules);
    } catch (e: any) {
      message.error(e.message);
    }
  };

  // 每类告警的渠道绑定：选择即落库；失败时回滚为服务端状态
  const saveChannelsFor = async (key: string, ids: string[]) => {
    setChannelsFor((cf) => ({ ...cf, [key]: ids }));
    try {
      const r = await api("/api/notifications/rules", {
        method: "PUT",
        body: { channelsFor: { [key]: ids } },
      });
      setRules(r.rules);
      setChannelsFor(r.rules?.channelsFor || {});
    } catch (e: any) {
      message.error(e.message);
      setChannelsFor(rules?.channelsFor || {});
    }
  };

  // 告警规则行右侧：渠道多选（空 = 全部启用渠道）+ 开关
  const alertChannelOptions = channels.map((c: any) => ({
    value: c.id,
    label: c.enabled === false ? `${c.name}（已停用）` : c.name,
  }));
  // 普通渲染函数而非内嵌组件：避免每次渲染产生新组件类型导致 Select 重挂、
  // 多选下拉每选一项就被关闭
  const renderAlertControls = (evKey: string, ruleKey: string) => (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
      <Select
        mode="multiple"
        allowClear
        style={{ minWidth: 200, maxWidth: 320 }}
        placeholder="全部启用渠道"
        maxTagCount="responsive"
        optionFilterProp="label"
        value={channelsFor[evKey] || []}
        onChange={(ids) => saveChannelsFor(evKey, ids as string[])}
        options={alertChannelOptions}
        disabled={!channels.length}
      />
      <Switch checked={!!rules[ruleKey]} onChange={() => toggleRule(ruleKey)} />
    </div>
  );

  // 切换单位时把输入值换算过去（两个单位间必然是互换，对照 v1 rule-etaUnit onchange）
  const onEtaUnitChange = (u: "days" | "hours") => {
    const v = Number(etaVal);
    if (Number.isFinite(v) && v > 0) {
      setEtaVal(String(u === "hours" ? +(v * 24).toFixed(2) : +(v / 24).toFixed(2)));
    }
    setEtaUnit(u);
  };

  const saveRules = async () => {
    setRulesSaving(true);
    try {
      const val = Number(etaVal);
      const r = await api("/api/notifications/rules", {
        method: "PUT",
        body: {
          etaDays: etaUnit === "hours" ? val / 24 : val, // 内部统一按天
          etaUnit,
          renotifyHours: Number(renotify),
          errorThreshold: Number(errThreshold),
          errorRetrySec: Number(errRetry),
        },
      });
      setRules(r.rules);
      syncRuleForm(r.rules);
      message.success("规则已保存");
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRulesSaving(false);
    }
  };

  // ---- 每日日报 ---------------------------------------------------------------

  const saveDailyReport = async () => {
    setDrSaving(true);
    try {
      const r = await api("/api/settings", {
        method: "PUT",
        body: {
          dailyReport: {
            enabled: drEnabled,
            time: drTime || "09:00",
            channelIds: drChannelIds,
          },
        },
      });
      setSettings(r.settings);
      syncDrForm(r.settings);
      message.success("日报设置已保存");
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDrSaving(false);
    }
  };

  const previewReport = async () => {
    setPreviewing(true);
    try {
      const r = await api("/api/report/preview", { method: "POST", body: {} });
      setReport({ text: r.text, html: r.html });
      setReportOpen(true);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const sendReport = async () => {
    setSending(true);
    try {
      const r = await api("/api/report/send", { method: "POST", body: {} });
      const ok = r.results.filter((x: any) => x.ok).length;
      const text = `日报已发送：${ok}/${r.results.length} 个渠道成功`;
      if (ok) message.success(text);
      else message.error(text);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSending(false);
    }
  };

  // ---- 渲染 -------------------------------------------------------------------

  const curType = channelTypes.find((x) => x.value === chType);
  const r = rules;

  return (
    <PageContainer
      title="通知"
      extra={[
        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => openChModal(null)}>
          添加渠道
        </Button>,
      ]}
      loading={loading}
    >
      {/* 通知渠道列表 */}
      {/* 窄视口：标题不换行不收缩，说明文字（extra）允许换行，避免标题被挤成竖排 */}
      <ProCard
        title={<span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>通知渠道</span>}
        extra={
          <Text type="secondary" style={{ fontSize: 12, whiteSpace: "normal", textAlign: "right" }}>
            在下方「告警规则」中可为每类告警单独选择推送渠道
          </Text>
        }
      >
        <List
          dataSource={channels}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <>
                    <div style={{ fontWeight: 600 }}>还没有通知渠道</div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      添加 Telegram、钉钉、企业微信、飞书、Bark、ntfy、Server酱或自定义 Webhook。
                    </Text>
                  </>
                }
              />
            ),
          }}
          renderItem={(c: any) => {
            const t = channelTypes.find((x) => x.value === c.type);
            return (
              <List.Item
                actions={[
                  <Switch key="enabled" checked={c.enabled !== false} onChange={() => toggleChannel(c)} title="启用/停用" />,
                  <Button
                    key="test"
                    type="text"
                    icon={<SendOutlined />}
                    loading={rowTesting === c.id}
                    onClick={() => testChannel(c)}
                    title="发送测试"
                  />,
                  <Button key="edit" type="text" icon={<EditOutlined />} onClick={() => openChModal(c)} title="编辑" />,
                  <Button key="del" type="text" danger icon={<DeleteOutlined />} onClick={() => deleteChannel(c)} title="删除" />,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <Avatar shape="square" style={{ background: token.colorPrimaryBg, color: token.colorPrimary, fontWeight: 700 }}>
                      {CH_PLATE[c.type] || "?"}
                    </Avatar>
                  }
                  title={c.name}
                  description={t?.label || c.type}
                />
              </List.Item>
            );
          }}
        />
      </ProCard>

      {/* 告警规则 */}
      <ProCard title="告警规则" style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
          每类告警可单独选择推送渠道；不选 = 发送到所有启用的渠道
        </Text>
        <SetRow title="余额偏低" desc="剩余余额低于阈值时通知">
          {renderAlertControls("low", "onLow")}
        </SetRow>
        <SetRow title="余额耗尽" desc="剩余余额归零时通知">
          {renderAlertControls("exhaust", "onExhaust")}
        </SetRow>
        <SetRow title="查询失败" desc="接口查询出错时通知（令牌失效、站点宕机等）">
          {renderAlertControls("error", "onError")}
        </SetRow>
        <SetRow title="恢复正常" desc="从异常状态恢复后通知">
          {renderAlertControls("recover", "onRecover")}
        </SetRow>
        <SetRow title="耗尽预警" desc="按消耗速度预计即将耗尽时通知">
          {renderAlertControls("eta", "onEta")}
        </SetRow>
        <SetRow title="耗尽预警阈值" desc="预计在该时间内耗尽则触发「耗尽预警」，可按天或小时设置">
          <div style={{ display: "flex", gap: 8 }}>
            <Input style={{ width: 90 }} value={etaVal} onChange={(e) => setEtaVal(e.target.value)} />
            <Select
              style={{ width: 80 }}
              value={etaUnit}
              onChange={onEtaUnitChange}
              options={[
                { value: "days", label: "天" },
                { value: "hours", label: "小时" },
              ]}
            />
          </div>
        </SetRow>
        <SetRow title="重复提醒间隔" desc="同一异常持续存在时，每隔 N 小时再次提醒（0 = 只提醒一次）">
          <Input style={{ width: 90 }} value={renotify} onChange={(e) => setRenotify(e.target.value)} suffix="小时" />
        </SetRow>
        <SetRow title="失败通知阈值" desc="查询连续失败达到该次数才推送「查询失败」（1 = 首次失败即通知）">
          <Input style={{ width: 90 }} value={errThreshold} onChange={(e) => setErrThreshold(e.target.value)} suffix="次" />
        </SetRow>
        <SetRow title="失败快速重试" desc="查询失败后隔 N 秒立即重试一次以尽快确认，不必等下次轮询（0 = 关闭）">
          <Input style={{ width: 90 }} value={errRetry} onChange={(e) => setErrRetry(e.target.value)} suffix="秒" />
        </SetRow>
        <SetRow title="保存规则" desc="应用阈值与间隔修改">
          <Button type="primary" loading={rulesSaving} onClick={saveRules}>
            保存
          </Button>
        </SetRow>
      </ProCard>

      {/* 每日日报 */}
      <ProCard
        title={<span style={{ whiteSpace: "nowrap", flexShrink: 0 }}>每日日报</span>}
        extra={
          <Text type="secondary" style={{ fontSize: 12, whiteSpace: "normal", textAlign: "right" }}>
            定时汇总昨日「我的站点」经营情况并推送（时间按服务器时区）
          </Text>
        }
        style={{ marginTop: 16 }}
      >
        <SetRow title="启用日报" desc="每天在设定时间生成并发送昨日报告">
          <Switch checked={drEnabled} onChange={setDrEnabled} />
        </SetRow>
        <SetRow title="发送时间" desc="服务器时区的每日时刻">
          <TimePicker
            style={{ width: 112 }}
            format="HH:mm"
            allowClear={false}
            value={drTime ? dayjs(drTime, "HH:mm") : null}
            onChange={(d) => setDrTime(d ? d.format("HH:mm") : "")}
          />
        </SetRow>
        <SetRow title="发送渠道" desc="不勾选 = 所有启用的渠道；日报较长，建议勾选邮件渠道">
          {channels.length ? (
            <Checkbox.Group
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
              value={drChannelIds}
              onChange={(ids) => setDrChannelIds(ids as string[])}
              options={channels.map((c) => ({ value: c.id, label: c.name }))}
            />
          ) : (
            <Text type="secondary">先添加通知渠道</Text>
          )}
        </SetRow>
        <SetRow title="保存与测试" desc="预览按当前数据生成的报告，或立即发送一次">
          <div style={{ display: "flex", gap: 8 }}>
            <Button loading={previewing} onClick={previewReport}>
              预览
            </Button>
            <Button loading={sending} onClick={sendReport}>
              立即发送
            </Button>
            <Button type="primary" loading={drSaving} onClick={saveDailyReport}>
              保存
            </Button>
          </div>
        </SetRow>
      </ProCard>

      {/* 通知渠道弹窗（对照 v1 chModal） */}
      <Modal
        open={chOpen}
        title={editingCh ? "编辑通知渠道" : "添加通知渠道"}
        onCancel={() => setChOpen(false)}
        footer={
          <div style={{ display: "flex", gap: 8 }}>
            <Button loading={chTesting} onClick={testChForm}>
              发送测试
            </Button>
            <span style={{ flex: 1 }} />
            <Button onClick={() => setChOpen(false)}>取消</Button>
            <Button type="primary" loading={chSaving} onClick={saveChannel}>
              保存
            </Button>
          </div>
        }
        destroyOnHidden
      >
        <Text type="secondary">默认接收所有告警；可在「告警规则」中按告警类型指定渠道。</Text>
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ marginBottom: 4 }}>名称</div>
            <Input placeholder="例如：运维 Telegram 群" value={chName} onChange={(e) => setChName(e.target.value)} />
          </div>
          <div>
            <div style={{ marginBottom: 4 }}>渠道类型</div>
            <Select
              style={{ width: "100%" }}
              value={chType || undefined}
              onChange={onChTypeChange}
              disabled={!!editingCh}
              options={channelTypes.map((t) => ({ value: t.value, label: t.label }))}
            />
          </div>
          {(curType?.fields || []).map((f: any) => (
            <div key={f.key}>
              <div style={{ marginBottom: 4 }}>{f.label}</div>
              <Input
                value={chConfig[f.key] || ""}
                onChange={(e) => setChConfig((cfg) => ({ ...cfg, [f.key]: e.target.value }))}
                placeholder={
                  SECRET_KEYS.includes(f.key) && editingCh?.config?.[f.key] ? "已配置，留空保持不变" : undefined
                }
              />
            </div>
          ))}
        </div>
      </Modal>

      {/* 日报预览弹窗（对照 v1 reportModal：HTML / 纯文本两个标签页） */}
      <Modal
        open={reportOpen}
        title="日报预览"
        width={720}
        onCancel={() => setReportOpen(false)}
        footer={<Button onClick={() => setReportOpen(false)}>关闭</Button>}
      >
        <Text type="secondary">按当前数据生成的昨日报告（实际发送时按设定时间的数据）</Text>
        <Tabs
          style={{ marginTop: 8 }}
          items={[
            {
              key: "html",
              label: "HTML（邮件效果）",
              children: (
                <iframe
                  title="日报 HTML 预览"
                  sandbox=""
                  srcDoc={report?.html || "<p>无 HTML 版本</p>"}
                  // 邮件 HTML 自带浅色底（server/report.js 的 C.bg），iframe 内不随站点主题，
                  // 白底是「邮件效果」的语义色，深色模式下保留；边框随主题 token
                  style={{
                    width: "100%",
                    height: 440,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: token.borderRadiusLG,
                    background: "#fff",
                  }}
                />
              ),
            },
            {
              key: "text",
              label: "纯文本（IM 渠道）",
              children: (
                <pre style={{ maxHeight: 440, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
                  {report?.text}
                </pre>
              ),
            },
          ]}
        />
      </Modal>
    </PageContainer>
  );
}
