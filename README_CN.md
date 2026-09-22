# dsh-plugin-quota-badges

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Multi-Vendor Quota](https://img.shields.io/badge/Vendors-OpenCode%20|%20MiniMax%20|%20Kimi%20|%20DeepSeek-brightgreen.svg)]()
[![Platform: Web](https://img.shields.io/badge/Platform-Web-orange.svg)]()

DeepSeek Harness 原生外挂插件：**多厂商订阅额度与余额徽章**。支持 **OpenCode（Zen Go）**、**MiniMax**、**Kimi Code** 与 **DeepSeek** 四家厂商，实时查询各厂商的限流额度窗口、订阅配额及账户余额，并在输入框模型选择器旁直观渲染微型额度徽章，配套完善的 Web 设置卡片。

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  输入栏（第二行）   [＋] [模式] [OpenCode 5h ████░░ 剩78% · 周 ██░░ 剩20%] … [模型 ▾] │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ 功能特性

- **🌐 多厂商一站式支持**
  - **OpenCode (Zen Go)**：5 小时滚动限流窗口 + 每周订阅配额池，带实时剩余百分比与重置倒计时。
  - **MiniMax**：滚动间隔限流 + 每周会员用量配额。
  - **Kimi Code**：5 小时限流窗口 (`limits[0]`) + 每周会员额度池。
  - **DeepSeek**：账户余额实时监控（USD / CNY 金额与可用性条）。
- **📊 原生输入栏额度徽章**
  - 挂载于 `conversation.input.right` 扩展槽，紧邻模型选择器；
  - 采用紧凑的文本块进度条（`████░░░░ 剩78% · 周 ██ 剩20%`）；
  - 智能三色状态预警：
    - 🟢 **健康状态**：剩余额度 > 30%
    - 🟡 **警告状态**：剩余额度 10% ~ 30%
    - 🔴 **危险状态**：剩余额度 < 10%
- **🎯 跟随当前选中模型动态显示（自动过滤）**
  - 开启后（默认开启），仅当当前会话选中的模型属于已配置厂商（如 OpenCode、MiniMax、Kimi、DeepSeek 系）时徽章才显示，切换到其他供应商自动隐藏。
- **🔍 详情弹窗与即时刷新**
  - 点击徽章可弹出详情面板，展示各厂商各窗口精确百分比进度条、重置倒计时、订阅续期时间与更新时间，并提供一键「立即刷新」按钮。
- **🛡️ 服务端代理转发（免 CORS 与密钥安全）**
  - 由 Node.js 服务端定时后台轮询（默认 60s），多开浏览器标签页不增加上游请求，完美绕过浏览器 CORS 跨域限制，且敏感 API Key 绝不出服务端。
- **⚙️ 原生 Web 设置管理卡片**
  - 深度集成于 **设置 → 插件 → 订阅额度徽章**，提供通用设置、厂商动态添加/移除与密钥管理。

> 模型能力（OpenCode 实时模型列表同步、容量/模态补全、强制视觉/纯文本）已迁至 **dsh-plugin-toolkit** 的 `modelCapability` 优化项；本插件不再包含该功能。

---

## 🏗️ 工作原理与架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH Web 前端 (浏览器)                     │
│  - 输入框插槽 (conversation.input.right): 额度进度条徽章        │
│  - 点击弹出详情卡片 (各厂商重置倒计时 / 刷新按钮)                │
│  - 设置卡片: 通用设置 / 厂商密钥配置                          │
└──────────────────────────────▲──────────────────────────────┘
                               │ GET /api/quota-badges/status
┌──────────────────────────────▼──────────────────────────────┐
│                    DSH 服务端插件层                          │
│  - 定时后台轮询 Worker (默认 60 秒可调)                       │
│  - 厂商适配器 (OpenCode / MiniMax / Kimi / DeepSeek)         │
└──────────────────────────────▲──────────────────────────────┘
                               │ 上游 HTTPS
┌──────────────────────────────┴──────────────────────────────┐
│                    各 AI 厂商官方接口                        │
│   - opencode.ai / api.minimax.chat / kimi.moonshot / deepseek│
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 环境要求

- 带有 Web profile 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)。
- [pnpm](https://pnpm.io)（用于 DSH 插件依赖管理）。

---

## 🚀 安装步骤

### 方式 1：直接从 GitHub 安装（推荐）

```sh
# 安装插件至 web profile
dsh plugin --profile web add github:kolawong/dsh-plugin-quota-badges

# 重启 DSH Web 服务
dsh web
```

### 方式 2：从本地源码目录安装

```sh
git clone https://github.com/kolawong/dsh-plugin-quota-badges.git
dsh plugin --profile web add ./dsh-plugin-quota-badges
dsh web
```

### 验证插件加载

```sh
dsh --profile web --dump-config | grep quota-badges
```

### 卸载

```sh
dsh plugin --profile web remove dsh-plugin-quota-badges
```

---

## ⚙️ 配置与 Web 设置卡片

所有配置均可在网页端图形化完成，保存后**立即生效，无需重启**：
👉 打开 **「设置」 → 「插件」 → 「订阅额度徽章」**

### 设置分区说明：
1. **通用设置**：
   - 轮询间隔（秒，默认 `60s`）
   - 请求超时（秒，默认 `15s`）
   - 跟随当前模型显示开关（默认开启）
2. **厂商接入**：
   - 点击「＋ 添加厂商」可按需接入 **OpenCode**、**MiniMax**、**Kimi Code** 或 **DeepSeek**；
   - 支持自定义 API 基础域名（如 OpenCode 全球节点与国内节点切换）；
   - 点击右上角「移除」可取消固定并安全清除对应厂商密钥。

### 补丁配置（可选，`cordis.patch.yml`）

也可以在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中静态声明：

```yaml
- insert:
    - id: quota-badges
      name: 'dsh-plugin-quota-badges'
      inject:
        - webServer
      config:
        pollIntervalSeconds: 60
        timeoutSeconds: 15
        onlyWhenSelectedVendor: true
        opencodeApiKey: 'your_opencode_key'
        minimaxApiKey: 'your_minimax_token'
        kimiApiKey: 'your_kimi_key'
        deepseekApiKey: 'your_deepseek_key'
```

---

## 📡 接口定义 (API Reference)

插件通过 DSH 内部 WebServer 注册同源 HTTP 路由：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/quota-badges/status` | 获取所有已配置厂商的最新缓存额度快照。 |
| `POST` | `/api/quota-badges/refresh` | 立即触发一次全厂商上游实时刷新。 |

#### `/api/quota-badges/status` 响应示例：

```jsonc
{
  "ok": true,
  "data": {
    "all": {
      "opencode": {
        "status": "ok",
        "vendor": "opencode",
        "displayName": "OpenCode",
        "rollingRemainingPercent": 78,
        "rollingResetInSec": 7200,
        "weeklyRemainingPercent": 20,
        "weeklyResetInSec": 259200
      },
      "deepseek": {
        "status": "ok",
        "vendor": "deepseek",
        "displayName": "DeepSeek",
        "currency": "USD",
        "totalBalance": "15.80",
        "grantedBalance": "0.00",
        "toppedUpBalance": "15.80"
      }
    }
  }
}
```

---

## 🛠️ 本地开发与测试

本插件包含 50 余项单元测试，全面覆盖厂商协议解析与容错降级：

```sh
# 运行全部单元测试
npm test
```

---

## 📄 开源许可证

[MIT](LICENSE) © [kola](https://github.com/kolawong)
