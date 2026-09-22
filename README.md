# dsh-plugin-quota-badges

English | [简体中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Multi-Vendor Quota](https://img.shields.io/badge/Vendors-OpenCode%20|%20MiniMax%20|%20Kimi%20|%20DeepSeek-brightgreen.svg)]()
[![Platform: Web](https://img.shields.io/badge/Platform-Web-orange.svg)]()

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin providing real-time multi-vendor subscription quota and balance monitoring. Displays compact quota bars directly in the composer bar next to the model selector, with a full Web settings interface.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Composer (Line 2)   [+] [Mode] [OpenCode 5h ████░░ 78% · Wk ██░░ 20%] … [Model ▾]│
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## ✨ Key Features

- **🌐 Multi-Vendor Support**
  - **OpenCode (Zen Go)**: 5-Hour rolling rate-limit window & Weekly subscription quota pool with auto-reset countdown.
  - **MiniMax**: Rolling interval usage & Weekly membership limit.
  - **Kimi Code**: 5-Hour limit (`limits[0]`) & Weekly quota pool.
  - **DeepSeek**: Real-time account balance tracking (USD / CNY) with availability indicators.
- **📊 Real-time Composer Badge**
  - Mounted on the `conversation.input.right` slot, right beside the model selector.
  - Renders compact visual progress bars (`████░░░░ 78% · Wk ██ 20%`).
  - Intelligent tri-color threshold status:
    - 🟢 **Healthy**: > 30% quota remaining
    - 🟡 **Warning**: 10% – 30% quota remaining
    - 🔴 **Critical**: < 10% quota remaining
- **🎯 Dynamic Active-Model Sync (Auto-Filter)**
  - When enabled (default), the badge automatically appears when the active session model belongs to a configured vendor (e.g. OpenCode, MiniMax, Kimi, DeepSeek) and hides when switched to other providers.
- **🔍 Rich Popover Details & Instant Refresh**
  - Click on the badge to expand a detailed popover displaying per-vendor progress bars, exact reset timestamps, subscription renewal dates, and an instant **"Refresh Now"** button.
- **🛡️ Secure Server-Side Proxy (CORS Bypass & Key Safety)**
  - Background polling worker (default 60s) avoids browser CORS preflight restrictions, caches snapshots across multiple open browser tabs, and never exposes API keys to client-side network inspectors.
- **⚙️ Native Web Settings Card**
  - Integrates into **Settings → Plugins → Quota Badges**, providing a clean card to configure API Keys, polling intervals, timeouts, and manage enabled providers.

> Model capabilities (OpenCode live model-list sync, capacity/modality enrichment, forced vision / text-only) moved to the `modelCapability` optimization in **dsh-plugin-toolkit**; this plugin no longer ships it.

---

## 🏗️ Architecture & How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH Web Client (Browser)                 │
│  - Composer Slot (conversation.input.right): Quota Badges   │
│  - Interactive Popover Detail Modal                         │
│  - Settings Card: General / Providers / Model Sync          │
└──────────────────────────────▲──────────────────────────────┘
                               │ GET /api/quota-badges/status
┌──────────────────────────────▼──────────────────────────────┐
│                    DSH Server Plugin Layer                  │
│  - Background Poller (Configurable Interval, Default 60s)   │
│  - Provider Adapters (OpenCode / MiniMax / Kimi / DeepSeek) │
└──────────────────────────────▲──────────────────────────────┘
                               │ Upstream HTTPS
┌──────────────────────────────┴──────────────────────────────┐
│                  Upstream AI Vendor APIs                    │
│   - opencode.ai / api.minimax.chat / kimi.moonshot / deepseek│
└─────────────────────────────────────────────────────────────┘
```

---

## 📋 Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) with the `web` profile.
- [pnpm](https://pnpm.io) (used by `dsh plugin` to link profile dependencies).

---

## 🚀 Installation

### Option 1: Install from GitHub (Recommended)

```sh
# Add plugin to the web profile
dsh plugin --profile web add github:kolawong/dsh-plugin-quota-badges

# Restart DSH Web service
dsh web
```

### Option 2: Install from a local directory

```sh
git clone https://github.com/kolawong/dsh-plugin-quota-badges.git
dsh plugin --profile web add ./dsh-plugin-quota-badges
dsh web
```

### Verification

Check that the plugin layer is loaded:
```sh
dsh --profile web --dump-config | grep quota-badges
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-quota-badges
```

---

## ⚙️ Configuration & Web Settings

All configurations can be managed visually directly within the Web interface:
👉 Open **Settings (`设置`) → Plugins (`插件`) → Subscription Quota Badges (`订阅额度徽章`)**

### Configuration Sections:
1. **General Settings**:
   - Polling Interval (seconds, default: `60s`)
   - Request Timeout (seconds, default: `15s`)
   - Follow Selected Model toggle (`true`/`false`)
2. **Provider Integration (`厂商接入`)**:
   - Click `+ Add Provider` to configure API Keys for **OpenCode**, **MiniMax**, **Kimi Code**, or **DeepSeek**.
   - Custom API Base URLs (e.g. OpenCode Global vs. CN endpoint).

### Overriding via `cordis.patch.yml` (Optional)

You can also customize the plugin in `$DSH_HOME/profiles/web/cordis.patch.yml`:

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

## 📡 HTTP API Reference

The plugin registers same-origin HTTP routes through DSH's internal Web server:

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/quota-badges/status` | Returns the latest cached snapshot for all configured vendors. |
| `POST` | `/api/quota-badges/refresh` | Triggers an immediate upstream polling cycle across all vendors. |

#### Example `/api/quota-badges/status` Response:

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

## 🛠️ Development & Unit Tests

The codebase is written in modern ES Modules with 50+ unit and integration tests covering vendor parsing and fallback heuristics.

```sh
# Run all unit tests
npm test
```

---

## 📄 License

[MIT](LICENSE) © [kola](https://github.com/kolawong)
