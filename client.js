/**
 * dsh-plugin-quota-badges — Client half (v0.3.0)
 *
 * Renders an OpenCode subscription-quota badge in the composer bar's
 * `conversation.input.right` list slot, next to the model selector. Polls the
 * plugin's own same-origin routes served by the server half of this package:
 *
 *   GET  /api/quota-badges/status       cached snapshot
 *   POST /api/quota-badges/refresh      force one upstream fetch, then answer
 *
 * Clicking the badge toggles a detail popover: per-window percent bars with
 * reset countdowns, renewal/update stamps, an explicit refresh button, and —
 * when no API key is configured — configuration guidance instead of numbers.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-quota-badges",
  factory: (require) => {
    const exports = {};
    const React = require("react");
    const { useState, useEffect, useLayoutEffect, useCallback, useRef } = React;
    const { jsx, jsxs } = require("react/jsx-runtime");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    if (primitives && typeof primitives === "object") {
      for (const key of Object.keys(primitives)) {
        if (key.startsWith("Icon") && key.endsWith("Regular")) {
          const base = key.slice(0, -7);
          for (const suffix of ["12", "14", "16", "18", "20", "24", ""]) {
            if (!primitives[base + suffix]) primitives[base + suffix] = primitives[key];
          }
        }
      }
    }
    const IconChevronDownOutline14 = primitives.IconChevronDownOutlineRegular || primitives.IconChevronDownOutline14 || (() => null);
    const IconRefreshOutline14 = primitives.IconRefreshOutlineRegular || primitives.IconRefreshOutline14 || (() => null);

    /** Same-origin routes; keep in sync with cordis.patch.yml config defaults. */
    const STATUS_PATH = "/api/quota-badges/status";
    const REFRESH_PATH = "/api/quota-badges/refresh";
    /** Client-side refetch period for the cached JSON; upstream pacing is the server's job. */
    const POLL_MS = 60_000;
    /** Detail popover width in px; positioning clamps against it. */
    const POP_WIDTH = 320;

    // ── locale ────────────────────────────────────────────────────────────────

    const NS = "quota-badges";
    const zh = {
      badge5h: "5小时",
      badgeWeekly: "周",
      badgeMonthly: "月",
      badgeBalance: "余额",
      chipRemain: "剩",
      remaining: "剩余",
      used: "已用",
      unconfigured: "额度未配置",
      loading: "额度…",
      stale: "数据已过期",
      errorPrefix: "上游错误",
      resetIn: "重置剩余",
      updatedAt: "更新于",
      neverUpdated: "尚未获取",
      renewAt: "订阅续期",
      panelTitle: "订阅额度",
      refreshBtn: "立即刷新",
      closeBtn: "关闭",
      configTitle: "尚未配置 API Key",
      configEnvVar: "环境变量",
      configPatch: "或在本插件配置中填写 apiKey 字段",
      configRestart: "配置后重启 Web 服务生效",
      ageJustNow: "刚刚",
      ageMinutes: "{n} 分钟前",
      ageHours: "{n} 小时前",
      ageDays: "{n} 天前",
      syncWithModel: "跟随当前模型显示",
      syncWithModelHint: "仅当选中模型的提供商属于已配置的额度厂商时显示徽章",
      cardTitle: "订阅额度徽章",
      cardDesc: "查询 OpenCode Zen Go、MiniMax、Kimi Code 与 DeepSeek 订阅额度/余额；保存后立即生效，无需重启。",
      fieldApiKey: "OpenCode API Key",
      fieldApiKeyPlaceholder: "粘贴 opencode.ai 的 API Key",
      fieldApiKeyHint: "留空时回退读取环境变量 OPENCODE_API_KEY",
      fieldMiniMaxKey: "MiniMax API Key",
      fieldMiniMaxKeyPlaceholder: "粘贴 MiniMax 平台 API Token",
      fieldMiniMaxKeyHint: "留空时回退读取环境变量 MINIMAX_CN_API_KEY",
      fieldInterval: "轮询间隔（秒）",
      fieldTimeout: "请求超时（秒）",
      statusConfigured: "已配置",
      statusUnconfigured: "未配置",
      saveBtn: "保存",
      cardSaving: "保存中…",
      cardSaved: "已保存，正在生效",
      cardReadOnly: "当前部署的设置文档不可写（仅内存模式）",
      cardMemoryMode: "连接处于内存模式，设置不会持久化",
      providerOpenCode: "OpenCode（Zen Go）",
      providerMiniMax: "MiniMax",
      secGeneral: "通用设置",
      secProviders: "厂商接入",
      fieldMiniMaxRegion: "区域",
      fieldMiniMaxRegionHint: "cn（api.minimaxi.com）/ global（api.minimax.io）",
      regionCn: "中国（cn）",
      regionGlobal: "全球（global）",
      providerKimi: "Kimi Code",
      fieldKimiKey: "Kimi Code API Key",
      fieldKimiKeyPlaceholder: "粘贴 Kimi Code 控制台的 API Key",
      fieldKimiKeyHint: "Kimi For Coding 订阅密钥；留空时回退读取环境变量 KIMI_CODE_API_KEY",
      providerDeepSeek: "DeepSeek",
      fieldDeepSeekKey: "DeepSeek API Key",
      fieldDeepSeekKeyPlaceholder: "粘贴 platform.deepseek.com 的 API Key",
      fieldDeepSeekKeyHint: "余额型账户（无窗口配额）；留空时回退读取环境变量 DEEPSEEK_API_KEY 或 DEEPSEEK_KEY",
      balancePaid: "已充值",
      balanceGranted: "赠送",
      balanceUnavailable: "余额不可用，暂时无法调用 API",
      balanceEmpty: "余额为 0，请到平台充值",
      addProvider: "添加厂商",
      removeProvider: "移除",
      removeProviderHint: "移除该厂商并清除已保存的密钥",
      providersEmpty: "尚未接入任何厂商；点击右侧「添加厂商」选择要查询的订阅。",
    };
    const en = {
      badge5h: "5h",
      badgeWeekly: "Week",
      badgeMonthly: "Month",
      badgeBalance: "Balance",
      chipRemain: "",
      remaining: "left",
      used: "used",
      unconfigured: "Quota not configured",
      loading: "Quota…",
      stale: "Data is stale",
      errorPrefix: "Upstream error",
      resetIn: "Resets in",
      updatedAt: "Updated",
      neverUpdated: "Never fetched",
      renewAt: "Renews at",
      panelTitle: "Subscription quota",
      refreshBtn: "Refresh now",
      closeBtn: "Close",
      configTitle: "No API key configured",
      configEnvVar: "Environment variable",
      configPatch: "or set the apiKey field in this plugin's config",
      configRestart: "Restart the web server after configuring",
      ageJustNow: "just now",
      ageMinutes: "{n}m ago",
      ageHours: "{n}h ago",
      ageDays: "{n}d ago",
      syncWithModel: "Sync with selected model",
      syncWithModelHint: "Show the badge only while the selected model's provider is one of the configured quota vendors",
      cardTitle: "Quota badge",
      cardDesc:
        "Tracks OpenCode Zen Go, MiniMax, Kimi Code, and DeepSeek subscription usage/balance; edits apply live without a restart.",
      fieldApiKey: "OpenCode API key",
      fieldApiKeyPlaceholder: "Paste your opencode.ai API key",
      fieldApiKeyHint: "When empty, falls back to the OPENCODE_API_KEY environment variable",
      fieldMiniMaxKey: "MiniMax API key",
      fieldMiniMaxKeyPlaceholder: "Paste your MiniMax platform API token",
      fieldMiniMaxKeyHint: "When empty, falls back to the MINIMAX_CN_API_KEY environment variable",
      fieldInterval: "Poll interval (sec)",
      fieldTimeout: "Request timeout (sec)",
      statusConfigured: "configured",
      statusUnconfigured: "unconfigured",
      saveBtn: "Save",
      cardSaving: "Saving…",
      cardSaved: "Saved and applying",
      cardReadOnly: "The settings document is read-only on this deployment",
      cardMemoryMode: "Connection is in memory mode; settings will not persist",
      providerOpenCode: "OpenCode (Zen Go)",
      providerMiniMax: "MiniMax",
      secGeneral: "General",
      secProviders: "Providers",
      fieldMiniMaxRegion: "Region",
      fieldMiniMaxRegionHint: "cn (api.minimaxi.com) / global (api.minimax.io)",
      regionCn: "China (cn)",
      regionGlobal: "Global (global)",
      providerKimi: "Kimi Code",
      fieldKimiKey: "Kimi Code API key",
      fieldKimiKeyPlaceholder: "Paste the API key from the Kimi Code console",
      fieldKimiKeyHint: "Kimi For Coding subscription key; when empty, falls back to the KIMI_CODE_API_KEY environment variable",
      providerDeepSeek: "DeepSeek",
      fieldDeepSeekKey: "DeepSeek API key",
      fieldDeepSeekKeyPlaceholder: "Paste the API key from platform.deepseek.com",
      fieldDeepSeekKeyHint: "Balance-based account (no quota windows); when empty, falls back to DEEPSEEK_API_KEY or DEEPSEEK_KEY",
      balancePaid: "Paid",
      balanceGranted: "Granted",
      balanceUnavailable: "Balance unavailable for API calls",
      balanceEmpty: "Balance is empty - add credits",
      addProvider: "Add provider",
      removeProvider: "Remove",
      removeProviderHint: "Remove this provider and clear its saved key",
      providersEmpty: "No providers connected yet; use \"Add provider\" to pick a subscription.",
    };

    /**
     * Editable per-provider field schema for the plugins-page settings card.
     *
     * One entry per registered provider — it mirrors the server-side adapter
     * registry in index.js (providers/*). Each field declares where in the
     * settings document it reads (`read`) and, via `scope`, how it is written:
     * `"root"` fields write their own top-level settings key (the legacy
     * OpenCode `apiKey`), while `"providers"` fields merge into a single
     * `providers.<id>` write. Adding a provider requires exactly one block
     * here plus the server adapter; the card body stays generic.
     */
    const PROVIDER_FIELDS = [
      {
        id: "opencode",
        titleKey: "providerOpenCode",
        envVar: "OPENCODE_API_KEY",
        fields: [
          {
            key: "apiKey",
            scope: "root",
            type: "password",
            labelKey: "fieldApiKey",
            placeholderKey: "fieldApiKeyPlaceholder",
            hintKey: "fieldApiKeyHint",
            read: (value) => value?.apiKey ?? "",
          },
        ],
      },
      {
        id: "minimax",
        titleKey: "providerMiniMax",
        envVar: "MINIMAX_CN_API_KEY",
        fields: [
          {
            key: "apiKey",
            scope: "providers",
            type: "password",
            labelKey: "fieldMiniMaxKey",
            placeholderKey: "fieldMiniMaxKeyPlaceholder",
            hintKey: "fieldMiniMaxKeyHint",
            read: (value) => value?.providers?.minimax?.apiKey ?? "",
          },
          {
            key: "region",
            scope: "providers",
            type: "select",
            labelKey: "fieldMiniMaxRegion",
            hintKey: "fieldMiniMaxRegionHint",
            options: ["cn", "global"],
            optionLabels: { cn: "regionCn", global: "regionGlobal" },
            read: (value) => value?.providers?.minimax?.region ?? "cn",
          },
        ],
      },
      {
        id: "kimi",
        titleKey: "providerKimi",
        envVar: "KIMI_CODE_API_KEY",
        fields: [
          {
            key: "apiKey",
            scope: "providers",
            type: "password",
            labelKey: "fieldKimiKey",
            placeholderKey: "fieldKimiKeyPlaceholder",
            hintKey: "fieldKimiKeyHint",
            read: (value) => value?.providers?.kimi?.apiKey ?? "",
          },
        ],
      },
      {
        id: "deepseek",
        titleKey: "providerDeepSeek",
        envVar: "DEEPSEEK_API_KEY",
        fields: [
          {
            key: "apiKey",
            scope: "providers",
            type: "password",
            labelKey: "fieldDeepSeekKey",
            placeholderKey: "fieldDeepSeekKeyPlaceholder",
            hintKey: "fieldDeepSeekKeyHint",
            read: (value) => value?.providers?.deepseek?.apiKey ?? "",
          },
        ],
      },
    ];

    /** Every provider's env-var fallback, joined for the unconfigured hint. */
    const ENV_VAR_LIST = PROVIDER_FIELDS.map((p) => p.envVar).join(" / ");

    /**
     * Human D/H/M duration for reset countdowns, highest unit first and
     * zero-value units elided (e.g. "5d 1h 33m", "2h 5m", "40s").
     * @param {number} sec - seconds until reset.
     */
    function formatDuration(sec) {
      if (!Number.isFinite(sec) || sec <= 0) return "0s";
      let s = Math.round(sec);
      if (s < 60) return s < 10 ? "0s" : `${s}s`;
      const minutes = Math.floor(s / 60);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const mins = minutes % 60;
      const parts = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (mins > 0) parts.push(`${mins}m`);
      return parts.join(" ");
    }

    /**
     * Relative age label from the server's ageSec ("5 分钟前" / "5m ago").
     * @returns {string | null} null when the age is unknown.
     */
    function formatAge(sec, t) {
      if (!Number.isFinite(sec) || sec < 0) return null;
      if (sec < 60) return t("ageJustNow");
      const fill = (key, n) => t(key).replace("{n}", String(n));
      if (sec < 3600) return fill("ageMinutes", Math.floor(sec / 60));
      if (sec < 86400) return fill("ageHours", Math.floor(sec / 3600));
      return fill("ageDays", Math.floor(sec / 86400));
    }

    /**
     * Local "YYYY-MM-DD HH:mm" clock text from an ISO stamp; returns the raw
     * value unchanged when it is not a parseable date.
     */
    function formatClock(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      const pad = (x) => String(x).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** "更新于 5 分钟前" prose line, or the never-fetched fallback. */
    function updatedLine(payload, t) {
      if (!payload?.fetchedAt) return `${t("updatedAt")} ${t("neverUpdated")}`;
      const age = formatAge(payload.ageSec, t);
      return age !== null ? `${t("updatedAt")} ${age}` : t("neverUpdated");
    }

    /** Full local clock for hover attribution (never shown inline). */
    function updatedClock(payload) {
      return payload?.fetchedAt ? formatClock(payload.fetchedAt) : undefined;
    }

    /**
     * Text-block progress bar (ChatGPT-style): solid blocks for the remaining
     * share, light blocks for the used share.
     * @param {number} remainPct - remaining percentage 0..100.
     * @param {number} blocks - total glyph count.
     */
    function asciiBar(remainPct, blocks = 10) {
      let filled = Math.round((Math.max(0, Math.min(100, remainPct)) / 100) * blocks);
      if (remainPct > 0 && filled === 0) filled = 1;
      if (remainPct < 100 && filled === blocks) filled = blocks - 1;
      return "█".repeat(filled) + "░".repeat(blocks - filled);
    }

    // ── styling ───────────────────────────────────────────────────────────────

    /** Inject the badge stylesheet once per page. */
    function ensureStyles() {
      if (document.getElementById("ocq-badge-styles")) return;
      const style = document.createElement("style");
      style.id = "ocq-badge-styles";
      style.textContent = `
        /* Dock column: the GoalBar width formula - aligned with the composer
           card cap minus the shared side clearance and dock insets. */
        .ocq-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          width: calc(
            100% -
            var(--dsh-composer-side-clearance, 0px) -
            var(--dsh-composer-side-clearance, 0px) -
            var(--dsh-composer-dock-inset, 0px) -
            var(--dsh-composer-dock-inset, 0px) -
            var(--dsh-composer-dock-inset, 0px) -
            var(--dsh-composer-dock-inset, 0px)
          );
          max-width: calc(var(--dsh-composer-card-max-width, 720px) - 4 * var(--dsh-composer-dock-inset, 0px));
          margin: 0 auto;
          overflow-x: auto;
          scrollbar-width: none;
          box-sizing: border-box;
          justify-content: flex-start;
          appearance: none;
          border: none;
          padding: 2px 4px;
          background: transparent;
          font: inherit;
          color: inherit;
          font-size: 11px;
          line-height: 16px;
          cursor: pointer;
          user-select: none;
          white-space: nowrap;
        }
        .ocq-chip.ocq-ok { color: var(--dsw-alias-label-primary, inherit); }
        .ocq-chip.ocq-warn { color: var(--dsw-alias-state-warn-label, #b45309); border-color: currentColor; }
        .ocq-chip.ocq-danger { color: var(--dsw-alias-state-error-primary, #ef4444); border-color: currentColor; }
        .ocq-chip.ocq-muted { opacity: 0.65; }
        .ocq-chip .ocq-label { opacity: 0.75; margin-right: 2px; }
        .ocq-chip .ocq-ascii { display: inline-flex; align-items: baseline; gap: 5px; font-variant-numeric: tabular-nums; }
        .ocq-chip .ocq-bar-text,
        .ocq-pop .ocq-bar-text {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          letter-spacing: 0.5px;
          opacity: 0.9;
          white-space: pre;
        }
        .ocq-chip .ocq-bar-text { font-size: 10px; }
        .ocq-chip .ocq-reset { opacity: 0.55; font-size: 11px; }
        .ocq-chip .ocq-sep { opacity: 0.35; margin: 0 2px; }
        .ocq-spin {
          display: inline-block;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          border: 1.5px solid currentColor;
          border-top-color: transparent;
          animation: ocq-spin 0.8s linear infinite;
        }
        @keyframes ocq-spin { to { transform: rotate(360deg); } }

        .ocq-pop {
          position: fixed;
          z-index: 999990;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-variant-numeric: tabular-nums;
          width: min(${POP_WIDTH}px, calc(100vw - 16px));
          max-height: calc(100vh - 16px);
          overflow-y: auto;
          box-sizing: border-box;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(127, 137, 155, 0.4));
          background: var(--dsw-alias-bg-layer-2, #ffffff);
          color: var(--dsw-alias-label-primary, inherit);
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
          font-size: 12px;
          line-height: 18px;
        }
        .ocq-pop-title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-weight: 600;
          margin-bottom: 6px;
        }
        .ocq-pop-close {
          background: none;
          border: none;
          color: var(--dsw-alias-label-tertiary, inherit);
          opacity: 0.6;
          cursor: pointer;
          font-size: 13px;
          padding: 0 2px;
        }
        .ocq-pop-close:hover { opacity: 1; }
        .ocq-panel-prompt { color: var(--dsw-alias-brand-primary, #60a5fa); }
        .ocq-foot-rule {
          color: var(--dsw-alias-label-tertiary, #9ca3af);
          opacity: 0.5;
          flex: 1;
          overflow: hidden;
          white-space: nowrap;
          user-select: none;
        }
        .ocq-row {
          display: grid;
          grid-template-columns: 6ch auto auto auto;
          align-items: baseline;
          gap: 10px;
          margin: 6px 0;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .ocq-row-label { min-width: 6ch; opacity: 0.8; }
        .ocq-row-reset {
          opacity: 0.55;
          text-align: right;
          font-size: 11px;
          min-width: 8ch;
          white-space: nowrap;
        }
        .ocq-bar {
          height: 5px;
          border-radius: 3px;
          background: var(--dsw-alias-border-l2, rgba(127, 137, 155, 0.35));
          overflow: hidden;
        }
        .ocq-bar > i {
          display: block;
          height: 100%;
          border-radius: 3px;
          background: var(--dsw-alias-brand-primary, #60a5fa);
        }
        .ocq-bar.ocq-warn > i { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
        .ocq-bar.ocq-danger > i { background: var(--dsw-alias-state-error-primary, #ef4444); }
        .ocq-meta { opacity: 0.65; margin-top: 6px; word-break: break-all; }
        .ocq-provider {
          margin-top: 8px;
          padding: 1px 6px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: var(--dsw-alias-label-secondary, #d1d5db);
          background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04));
          align-self: flex-start;
        }
        .ocq-provider:first-child { margin-top: 0; }
        .ocq-pop-error { color: var(--dsw-alias-state-error-primary, #ef4444); margin-top: 6px; }
        .ocq-pop-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
        .ocq-btn {
          padding: 3px 10px;
          border-radius: 7px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(127, 137, 155, 0.4));
          background: transparent;
          color: inherit;
          font-size: 12px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .ocq-btn:hover { filter: brightness(0.96); }
        .ocq-btn[disabled] { opacity: 0.55; cursor: default; }
        .ocq-icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 7px;
          border: none;
          background: transparent;
          color: var(--dsw-alias-label-secondary, inherit);
          cursor: pointer;
        }
        .ocq-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,137,155,0.14)); }
        .ocq-icon-btn[disabled] { opacity: 0.5; cursor: default; }

        .ocq-row-pct {
          min-width: 7ch;
          font-weight: 600;
          color: var(--dsw-alias-label-primary, inherit);
          white-space: nowrap;
        }
        .ocq-bar-text.ocq-warn { color: var(--dsw-alias-state-warn-label, #b45309); }
        .ocq-bar-text.ocq-danger { color: var(--dsw-alias-state-error-primary, #ef4444); }
        .ocq-config-hint { margin-top: 4px; opacity: 0.85; }
        .ocq-config-hint code {
          font-size: 11px;
          padding: 0 4px;
          border-radius: 4px;
          background: var(--dsw-alias-bg-layer-3, rgba(127, 137, 155, 0.15));
        }

        .ocq-field { display: flex; flex-direction: column; gap: 3px; }
        .ocq-field-row { display: flex; gap: 12px; }
        .ocq-field-num { flex: 1; }
        .ocq-field-label { opacity: 0.8; }
        .ocq-field-hint { opacity: 0.55; font-size: 11px; }
        .ocq-input {
          box-sizing: border-box;
          width: 100%;
          padding: 5px 8px;
          border-radius: 7px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(127, 137, 155, 0.4));
          background: transparent;
          color: inherit;
          font-size: 12px;
        }
        .ocq-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #60a5fa); }
        .ocq-input[disabled] { opacity: 0.55; }
        .ocq-card-status { opacity: 0.65; }
        .ocq-check {
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
        }
        .ocq-check input { accent-color: var(--dsw-alias-brand-primary, #60a5fa); }
        .ocq-check .ocq-field-hint { margin-left: auto; }

        /* Grouped settings-card sections (General / Providers / Model). */
        .ocq-section { display: flex; flex-direction: column; gap: 8px; }
        .ocq-section-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--dsw-alias-label-tertiary, #9ca3af);
        }
        .ocq-section-title::after {
          content: "";
          flex: 1;
          height: 1px;
          background: var(--dsw-alias-border-l2, #333);
          opacity: 0.5;
        }
        .ocq-divider {
          height: 1px;
          background: var(--dsw-alias-border-l2, #333);
          opacity: 0.45;
        }
        .ocq-provider-block {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid var(--dsw-alias-border-l2, #333);
          background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03));
        }
        .ocq-provider-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .ocq-provider-name { font-weight: 600; font-size: 12px; }
        .ocq-provider-env {
          margin-left: auto;
          font-size: 10px;
          opacity: 0.55;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .ocq-select {
          box-sizing: border-box;
          width: 100%;
          padding: 5px 8px;
          border-radius: 7px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(127, 137, 155, 0.4));
          background: transparent;
          color: inherit;
          font-size: 12px;
        }
        .ocq-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #60a5fa); }
        .ocq-select[disabled] { opacity: 0.55; }

        /* Providers-section header: title rule plus the add-provider picker. */
        .ocq-sec-head { display: flex; align-items: center; gap: 8px; }
        .ocq-sec-head .ocq-section-title { flex: 1; min-width: 0; }
        .ocq-picker { position: relative; flex: none; }
        .ocq-picker-menu {
          position: absolute;
          top: calc(100% + 4px);
          right: 0;
          z-index: 30;
          min-width: 210px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 4px;
          border-radius: 8px;
          border: 1px solid var(--dsw-alias-border-l2, rgba(127, 137, 155, 0.4));
          background: var(--dsw-alias-bg-layer-2, #1e1e1e);
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
        }
        .ocq-picker-item {
          display: flex;
          flex-direction: column;
          gap: 1px;
          text-align: left;
          padding: 6px 8px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: inherit;
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }
        .ocq-picker-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 137, 155, 0.14)); }
        .ocq-picker-item .ocq-picker-env {
          font-size: 10px;
          opacity: 0.55;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .ocq-remove-btn {
          flex: none;
          padding: 1px 8px;
          border-radius: 6px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--dsw-alias-label-tertiary, #9ca3af);
          font-size: 11px;
          cursor: pointer;
        }
        .ocq-remove-btn:hover {
          color: var(--dsw-alias-state-error-primary, #ef4444);
          border-color: var(--dsw-alias-state-error-primary, #ef4444);
        }
        .ocq-remove-btn[disabled] { opacity: 0.5; cursor: default; }
        .ocq-empty-hint { opacity: 0.6; font-size: 12px; }

        /* Balance-model provider (DeepSeek): amount block in the popover. */
        .ocq-balance-block {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin: 6px 0;
        }
        .ocq-balance-total {
          font-size: 20px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--dsw-alias-label-primary, inherit);
        }
        .ocq-balance-warn {
          color: var(--dsw-alias-state-error-primary, #ef4444);
          font-size: 11px;
        }
      `;
      document.head.append(style);
    }

    // ── shared fetch layer ────────────────────────────────────────────────────

    /** Module-level last payload so remounts render instantly across sessions. */
    let lastPayload = null;

    async function fetchStatus() {
      const response = await fetch(STATUS_PATH, { method: "GET" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      lastPayload = await response.json();
      return lastPayload;
    }

    async function postRefresh() {
      const response = await fetch(REFRESH_PATH, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      lastPayload = await response.json();
      return lastPayload;
    }

    // ── presentation helpers ──────────────────────────────────────────────────

    /** Severity bucket name for a usage percent. */
    function severity(percent) {
      if (percent >= 90) return "ocq-danger";
      if (percent >= 70) return "ocq-warn";
      return "ocq-ok";
    }

    /**
     * One window row inside the popover: label + percent + reset countdown
     * over a severity-tinted progress bar.
     * @param {{ label: string, window: { percent: number, resetInSec: number }, t: (key: string) => string }} props
     */
    function WindowRow({ label, window, t }) {
      const pct = Math.round(window.percent);
      const remain = Math.max(0, 100 - pct);
      const remainLabel = t("chipRemain");
      return jsxs("div", {
        className: "ocq-row",
        children: [
          jsx("span", { className: "ocq-row-label", children: label }),
          jsx(
            "span",
            {
              className: `ocq-bar-text ocq-${severity(pct)}`,
              title: `${t("used")} ${pct}% · ${t("remaining")} ${remain}%`,
              children: asciiBar(remain, 10),
            },
            "bar",
          ),
          jsx(
            "span",
            {
              className: "ocq-row-pct",
              children: remainLabel === "" ? `${remain}%` : `${remainLabel} ${remain}%`,
            },
            "pct",
          ),
          jsx(
            "span",
            {
              className: "ocq-row-reset",
              title: t("resetIn"),
              children: formatDuration(window.resetInSec),
            },
            "reset",
          ),
        ],
      });
    }

    /**
     * The quota badge + detail popover. Receives the slot standard kit; only
     * `t` is used. Owner props (session/input) are irrelevant — quota data is
     * session-global.
     */
    function QuotaBadge({ t, useQuotaModel, useQuotaSettings }) {
      const [payload, setPayload] = useState(lastPayload);
      // The session's model-directory snapshot: current.provider drives the
      // sync-with-model visibility rule. Absent hook (service missing) keeps
      // the badge always visible.
      const dirSnap = useQuotaModel ? useQuotaModel((s) => s) : undefined;
      // Live settings snapshot; undefined while loading or when the settings
      // surface is absent.
      const settingsSnap = useQuotaSettings ? useQuotaSettings((s) => s) : undefined;
      const [busy, setBusy] = useState(false);
      /** Popover anchor facts captured at toggle time, or null while closed. */
      const [popAnchor, setPopAnchor] = useState(null);
      /** Measured, viewport-clamped popover position; null until first measure. */
      const [popPos, setPopPos] = useState(null);
      const chipRef = useRef(null);
      const popRef = useRef(null);
      const wrapRef = useRef(null);

      useEffect(() => {
        let alive = true;
        const load = () =>
          fetchStatus()
            .then((body) => {
              if (alive) setPayload(body);
            })
            .catch(() => {});
        const loadVision = () =>
          fetchVisionIds()
            .then((ids) => {
              if (alive) setVisionIds(ids);
            })
            .catch(() => {});
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      const doRefresh = useCallback(async () => {
        setBusy(true);
        try {
          setPayload(await postRefresh());
        } catch {
          // keep showing whatever we have; the next poll retries
        } finally {
          setBusy(false);
        }
      }, []);

      const open = popAnchor !== null;

      // Close the popover on any pointer press outside the badge AND the card
      // (the wrap ref covers both; testing only the chip would close the card
      // the moment its own refresh button is pressed).
      useEffect(() => {
        if (!open) return undefined;
        const onOutside = (event) => {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) {
            setPopAnchor(null);
          }
        };
        document.addEventListener("pointerdown", onOutside);
        return () => document.removeEventListener("pointerdown", onOutside);
      }, [open]);

      const togglePopover = useCallback(() => {
        setPopAnchor((current) => {
          if (current !== null) return null;
          const rect = chipRef.current?.getBoundingClientRect?.();
          return {
            chipTop: rect ? rect.top : 200,
            chipBottom: rect ? rect.bottom : 220,
            anchorLeft: rect ? rect.right : 300,
          };
        });
      }, []);

      // Measure the rendered card and clamp it inside the viewport: prefer
      // opening above the chip; flip below when there is no headroom. Re-runs
      // when the content height changes (windows appear, error line added).
      useLayoutEffect(() => {
        if (!open || !popRef.current || !popAnchor) {
          setPopPos(null);
          return undefined;
        }
        const vh = window.innerHeight || 800;
        const vw = window.innerWidth || 1200;
        const r = popRef.current.getBoundingClientRect();
        let top = popAnchor.chipTop - r.height - 8;
        if (top < 8) top = Math.min(popAnchor.chipBottom + 8, vh - r.height - 8);
        top = Math.max(8, Math.min(top, vh - r.height - 8));
        const panelW = Math.min(r.width || POP_WIDTH, vw - 16);
        const left = Math.max(8, Math.min(popAnchor.anchorLeft - panelW, vw - panelW - 8));
        setPopPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
        return undefined;
      }, [open, popAnchor, payload]);

      // Reposition on viewport resize / rotation — the fixed anchor facts are
      // stale once the viewport changes, so re-read the chip rect and re-clamp.
      useEffect(() => {
        if (!open) return undefined;
        const onResize = () => {
          const rect = chipRef.current?.getBoundingClientRect?.();
          if (!rect) return;
          setPopAnchor({
            chipTop: rect.top,
            chipBottom: rect.bottom,
            anchorLeft: rect.right,
          });
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, [open]);

      const data = payload?.data ?? null;
      const error = payload?.error ?? null;
      const syncOn = settingsSnap?.value
        ? settingsSnap.value.syncWithModel !== false
        : true;

      // ── model-following provider selection ────────────────────────────────
      // The badge follows the CURRENT model's provider: the quota is a
      // per-VENDOR subscription, so matching the model's provider to a vendor
      // is enough — that vendor's windows are shown with the original
      // vendor-agnostic labels (no vendor prefix). `all` (new wire) carries
      // every vendor's entry; when absent, fall back to the single-provider
      // top-level fields.
      const rawAll = payload?.all && typeof payload?.all === "object" ? payload.all : null;
      const vendorIds = rawAll ? Object.keys(rawAll) : ["opencode"];
      const currentModelProvider = (dirSnap?.current?.provider ?? "").trim() || "opencode";
      // The registered vendor whose id matches the current model's provider
      // (e.g. opencode-go → opencode, minimax-cn → minimax).
      const matchedVendor = vendorIds.find((id) => {
        let re = null;
        try {
          re = new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        } catch {
          re = null;
        }
        return re ? re.test(currentModelProvider) : false;
      });
      const hasMatch = matchedVendor !== undefined;

      // The entry shown on the chip: the matched vendor's. When matching is
      // off (syncWithModel=false) or the model info is absent, fall back to
      // the top-level active entry for a stable display.
      let activeEntry;
      if (hasMatch && rawAll) {
        activeEntry = rawAll[matchedVendor];
      } else {
        activeEntry = { provider: payload?.provider, displayName: payload?.displayName, data, error };
      }

      const shownData = activeEntry?.data ?? null;
      const shownError = activeEntry?.error ?? null;
      const unconfigured = shownData === null && shownError?.code === "unconfigured";

      // Collect the matched vendor's windows with the ORIGINAL window labels
      // (no vendor prefix) so the chip looks like the single-provider version.
      const windows = [];
      const d = shownData;
      if (d?.rolling) windows.push({ key: "roll", label: t("badge5h"), window: d.rolling });
      if (d?.weekly) windows.push({ key: "week", label: t("badgeWeekly"), window: d.weekly });
      if (d?.monthly) windows.push({ key: "month", label: t("badgeMonthly"), window: d.monthly });
      const aggregated = windows.length > 0 || d?.balance != null;
      const anyError = shownData === null && shownError !== null && shownError.code !== "unconfigured";

      // Chip face -----------------------------------------------------------------
      let chipBody;
      let extraClass;

      if (busy && !open) {
        chipBody = jsx("span", { className: "ocq-spin", "aria-label": t("loading") });
        extraClass = "ocq-muted";
      } else if (unconfigured) {
        chipBody = jsx("span", { children: t("unconfigured") });
        extraClass = "ocq-muted";
      } else if (!aggregated && !anyError) {
        // Never fetched / fetch in flight: animate, no prose.
        chipBody = jsx("span", { className: "ocq-spin", "aria-label": t("loading") });
        extraClass = "ocq-muted";
      } else if (!aggregated) {
        // Upstream failed before any success: minimal glyph, details on hover.
        chipBody = jsx("span", { "aria-label": t("errorPrefix"), children: "⚠" });
        extraClass = "ocq-warn";
      } else if (windows.length > 0) {
        const worst = windows.reduce(
          (acc, w) => (w.window.percent > acc.window.percent ? w : acc),
          windows[0] ?? { window: { percent: 0 } },
        );
        extraClass = anyError ? "ocq-warn" : severity(worst.window.percent);
        chipBody = jsxs("span", {
          className: "ocq-ascii",
          children: windows.flatMap((w, index) => {
            const remain = Math.max(0, 100 - Math.round(w.window.percent));
            const remainLabel = t("chipRemain");
            return [
              index > 0 ? jsx("span", { className: "ocq-sep", children: "·" }, `sep${w.key}`) : null,
              jsx("span", { className: "ocq-label", children: w.label }, `label${w.key}`),
              jsx("span", { className: "ocq-bar-text", children: asciiBar(remain) }, `bar${w.key}`),
              jsx(
                "span",
                { children: remainLabel === "" ? `${remain}%` : `${remainLabel} ${remain}%` },
                `pct${w.key}`,
              ),
              // The dock row has width to spare: the reset countdown rides
              // along instead of hiding in the popover.
              jsx(
                "span",
                { className: "ocq-reset", children: formatDuration(w.window.resetInSec) },
                `reset${w.key}`,
              ),
            ];
          }),
        });
      } else {
        // Balance-model vendor (DeepSeek): no quota windows, just credit. The
        // bar is a usability gauge - full while there is usable balance,
        // empty once it runs out - and the amount rides in place of a percent.
        const bal = d?.balance;
        const usable = bal?.isAvailable === true && bal?.total > 0;
        extraClass = usable ? "ocq-ok" : "ocq-danger";
        const symbol = bal?.currency === "CNY" ? "¥" : "$";
        chipBody = jsxs("span", {
          className: "ocq-ascii",
          children: [
            jsx("span", { className: "ocq-label", children: t("badgeBalance") }, "label"),
            jsx("span", { className: "ocq-bar-text", children: asciiBar(usable ? 100 : 0) }, "bar"),
            jsx("span", { children: `${symbol}${(bal?.total ?? 0).toFixed(2)}` }, "amt"),
          ],
        });
      }

      // Sync-with-model gate: hide entirely unless the current model's
      // provider matches one of the registered quota vendors.
      if (syncOn) {
        if (!hasMatch) return null;
      }

      const chip = jsx("button", {
        type: "button",
        ref: chipRef,
        className: `ocq-chip ${extraClass ?? ""}`,
        title:
          unconfigured
            ? `${t("configTitle")}\n${t("configEnvVar")}: ${ENV_VAR_LIST}\n${t("configPatch")}`
            : shownData === null && shownError !== null && shownError.code !== "unconfigured"
              ? `${t("errorPrefix")}: ${shownError.message}`
              : `${t("panelTitle")} · ${activeEntry?.displayName ?? ""} · ${updatedLine(payload, t)}`,
        onClick: togglePopover,
        children: chipBody,
      });

      // Popover body --------------------------------------------------------------
      let popContent;
      if (unconfigured) {
        popContent = jsxs("div", {
          children: [
            jsx("div", { className: "ocq-pop-title", children: t("configTitle") }),
            jsxs("div", {
              className: "ocq-config-hint",
              children: [
                `${t("configEnvVar")}: `,
                jsx("code", { children: ENV_VAR_LIST }),
                jsx("br", {}),
                t("configPatch"),
                jsx("br", {}),
                t("configRestart"),
              ],
            }),
            shownError !== null
              ? jsx("div", { className: "ocq-pop-error", children: `[${activeEntry?.displayName ?? ""}] ${shownError.message}` })
              : null,
          ],
        });
      } else {
        const rows = [];
        if (shownData !== null) {
          if (shownData.rolling) rows.push(jsx(WindowRow, { label: t("badge5h"), window: shownData.rolling, t }, "roll"));
          if (shownData.weekly) rows.push(jsx(WindowRow, { label: t("badgeWeekly"), window: shownData.weekly, t }, "week"));
          if (shownData.monthly) rows.push(jsx(WindowRow, { label: t("badgeMonthly"), window: shownData.monthly, t }, "month"));
          if (shownData.balance != null) {
            const bal = shownData.balance;
            const symbol = bal.currency === "CNY" ? "¥" : "$";
            rows.push(
              jsx("div", {
                className: "ocq-balance-block",
                children: [
                  jsx("div", { className: "ocq-balance-total", children: `${symbol}${bal.total.toFixed(2)}` }),
                  jsx("div", {
                    className: "ocq-meta",
                    children: `${t("balancePaid")} ${symbol}${bal.toppedUp.toFixed(2)} · ${t("balanceGranted")} ${symbol}${bal.granted.toFixed(2)}`,
                  }),
                  !bal.isAvailable
                    ? jsx("div", { className: "ocq-balance-warn", children: t("balanceUnavailable") })
                    : null,
                  bal.total <= 0
                    ? jsx("div", { className: "ocq-balance-warn", children: t("balanceEmpty") })
                    : null,
                ],
              }, "balance"),
            );
          }
          if (shownData.renewsAt) {
            rows.push(
              jsx("div", { className: "ocq-meta", children: `${t("renewAt")}: ${formatClock(shownData.renewsAt)}` }, "renew"),
            );
          }
        }
        popContent = jsxs("div", {
          children: [
            jsxs("div", {
              className: "ocq-pop-title",
              children: [
                jsx("span", { className: "ocq-panel-prompt", children: "▸ " + t("panelTitle") }),
                jsx("button", {
                  type: "button",
                  className: "ocq-pop-close",
                  title: t("closeBtn"),
                  onClick: togglePopover,
                  children: "✕",
                }),
              ],
            }),
            ...(rows.length > 0
              ? rows
              : shownData === null && shownError === null
                ? [
                    jsx("div", {
                      className: "ocq-row",
                      children: jsx("span", { className: "ocq-spin", "aria-label": t("loading") }),
                    }, "spin"),
                  ]
                : [jsx("div", { className: "ocq-meta", children: t("neverUpdated") }, "none")]),
            jsx("div", {
              className: "ocq-meta",
              title: updatedClock(payload),
              children: updatedLine(payload, t),
            }),
            shownError !== null && shownError.code !== "unconfigured"
              ? jsx("div", { className: "ocq-pop-error", children: `⚠ ${t("stale")} — ${shownError.message}` })
              : null,
            jsxs("div", {
              className: "ocq-pop-foot",
              children: [
                jsx("span", { className: "ocq-foot-rule", "aria-hidden": true, children: "──" }),
                jsx("button", {
                  type: "button",
                  className: "ocq-icon-btn",
                  disabled: busy,
                  "aria-label": t("refreshBtn"),
                  title: t("refreshBtn"),
                  onClick: doRefresh,
                  children: busy ? jsx("span", { className: "ocq-spin" }) : jsx(IconRefreshOutline14, {}),
                }),
              ],
            }),
          ],
        });
      }

      const popover =
        open && popAnchor !== null
          ? jsx("div", {
              ref: popRef,
              className: "ocq-pop",
              style: {
                visibility: popPos === null ? "hidden" : "visible",
                ...(popPos !== null
                  ? { top: `${popPos.top}px`, left: `${popPos.left}px` }
                  : { top: "-9999px", left: "-9999px" }),
              },
              children: popContent,
            })
          : null;

      return jsxs("span", {
        ref: wrapRef,
        style: { display: "inline-flex", position: "relative" },
        children: [chip, popover],
      });
    }

    // ── settings card ───────────────────────────────────────────────────────

    /** Small inline gauge glyph for the card header (self-contained SVG). */
    function GaugeIcon(props) {
      return jsx("svg", {
        width: 18,
        height: 18,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className: "ocq-card-icon",
        "aria-hidden": true,
        children: [
          jsx("path", { d: "M12 14 15.5 9.5" }),
          jsx("path", { d: "M4 17.5a8 8 0 1 1 16 0" }),
        ],
      });
    }

    /**
     * Plugins-page settings card. Reads the bound namespace snapshot through
     * the renderer-bound `useQuotaSettings` hook (the scope is a bare
     * observable source) and writes single fields through scope.set.
     */
    function QuotaSettingsCard(props) {
      const { t, useQuotaSettings } = props;
      const snap = typeof useQuotaSettings === 'function' ? useQuotaSettings((s) => s) : (typeof props.scope?.getSnapshot === 'function' ? props.scope.getSnapshot() : {});
      const value = snap.value ?? {};
      const writable = snap.writable === true;

      const [open, setOpen] = useState(props && props.view === "page");
      const [intervalDraft, setIntervalDraft] = useState("");
      const [timeoutDraft, setTimeoutDraft] = useState("");
      // Provider-editable field drafts, keyed `${providerId}::${fieldKey}`.
      const [fieldDrafts, setFieldDrafts] = useState({});
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [savedTick, setSavedTick] = useState(false);
      const [error, setError] = useState(null);
      /** "Add provider" picker menu visibility (providers-section header). */
      const [pickerOpen, setPickerOpen] = useState(false);
      const pickerRef = useRef(null);

      const markDirty = () => {
        setDirty(true);
        setSavedTick(false);
        setError(null);
      };

      // Resolve the display value for one provider field: the in-progress
      // draft once the user has edited it, otherwise the live settings value.
      const resolveField = (p, f) => {
        const draft = fieldDrafts[`${p.id}::${f.key}`];
        return draft !== undefined ? draft : String(f.read(value) ?? (f.default ?? ""));
      };

      const setFieldDraft = (p, f, next) => {
        setFieldDrafts((prev) => ({ ...prev, [`${p.id}::${f.key}`]: next }));
        markDirty();
      };

      // Sync drafts from the Host view until the user starts editing.
      useEffect(() => {
        if (snap.status !== "ready" || dirty) return;
        const next = {};
        for (const p of PROVIDER_FIELDS) {
          for (const f of p.fields) next[`${p.id}::${f.key}`] = String(f.read(value) ?? (f.default ?? ""));
        }
        setFieldDrafts(next);
        setIntervalDraft(value.intervalSec !== undefined ? String(value.intervalSec) : "60");
        setTimeoutDraft(value.timeoutSec !== undefined ? String(value.timeoutSec) : "10");
      }, [snap.status, snap.revision, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

      // Close the add-provider menu on any pointer press outside of it.
      useEffect(() => {
        if (!pickerOpen) return undefined;
        const onPointerDown = (event) => {
          if (pickerRef.current && !pickerRef.current.contains(event.target)) setPickerOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
      }, [pickerOpen]);

      const onSave = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
          const nextInterval = Math.max(15, Number(intervalDraft) || 60);
          if (nextInterval !== value.intervalSec) await props.quotaSet("intervalSec", nextInterval);
          const nextTimeout = Math.max(1, Number(timeoutDraft) || 10);
          if (nextTimeout !== value.timeoutSec) await props.quotaSet("timeoutSec", nextTimeout);
          // Provider fields: root-scope fields write their own top-level key;
          // provider-scope fields merge into a single `providers` write.
          const nextProviders = { ...(value.providers ?? {}) };
          let providersChanged = false;
          for (const p of PROVIDER_FIELDS) {
            for (const f of p.fields) {
              const current = f.read(value);
              const raw = resolveField(p, f);
              const normalized =
                f.type === "select"
                  ? (f.options?.includes(raw) ? raw : current)
                  : String(raw).trim();
              if (normalized === current) continue;
              if (f.scope === "root") {
                await props.quotaSet(f.key, normalized);
              } else {
                nextProviders[p.id] = { ...(nextProviders[p.id] ?? {}), [f.key]: normalized };
                providersChanged = true;
              }
            }
          }
          if (providersChanged) await props.quotaSet("providers", nextProviders);
          setDirty(false);
          setSavedTick(true);
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        } finally {
          setSaving(false);
        }
      }, [intervalDraft, timeoutDraft, fieldDrafts, value]); // eslint-disable-line react-hooks/exhaustive-deps

      // Providers pinned as blocks. Unset storage shows every registered
      // provider (the pre-picker behavior); "Remove" clears the saved config
      // and unpins the id, "Add" re-pins it with a blank block.
      const storedVisible = value.visibleProviders;
      const visibleIds =
        Array.isArray(storedVisible) && storedVisible.every((id) => typeof id === "string")
          ? storedVisible
          : PROVIDER_FIELDS.map((p) => p.id);
      const visibleProviderList = PROVIDER_FIELDS.filter((p) => visibleIds.includes(p.id));
      const remainingProviders = PROVIDER_FIELDS.filter((p) => !visibleIds.includes(p.id));

      const configured = visibleProviderList.some((p) =>
        p.fields.some((f) => f.key === "apiKey" && String(f.read(value)).trim() !== ""),
      );
      const statusText = configured ? t("statusConfigured") : t("statusUnconfigured");
      const statusActive = configured;

      const statusLine =
        snap.mode === "memory"
          ? t("cardMemoryMode")
          : snap.writable
            ? savedTick
              ? t("cardSaved")
              : ""
            : t("cardReadOnly");

      // Pin one more provider block (picker item click).
      const addProvider = async (p) => {
        setPickerOpen(false);
        setError(null);
        try {
          if (!visibleIds.includes(p.id)) {
            await props.quotaSet("visibleProviders", [...visibleIds, p.id]);
          }
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        }
      };

      // Unpin a provider block AND delete its saved configuration: root-scope
      // fields are reset to empty, the providers.<id> slice is dropped, and
      // stale drafts are cleared so a re-added block starts blank.
      const removeProvider = async (p) => {
        setSaving(true);
        setError(null);
        try {
          for (const f of p.fields) {
            if (f.scope === "root") await props.quotaSet(f.key, "");
          }
          const providers = { ...(value.providers ?? {}) };
          if (providers[p.id] !== undefined) {
            delete providers[p.id];
            await props.quotaSet("providers", providers);
          }
          setFieldDrafts((prev) => {
            const next = { ...prev };
            for (const f of p.fields) delete next[`${p.id}::${f.key}`];
            return next;
          });
          await props.quotaSet("visibleProviders", visibleIds.filter((id) => id !== p.id));
        } catch (cause) {
          setError(cause?.message ?? String(cause));
        } finally {
          setSaving(false);
        }
      };

      if (props && props.view === "summary") {
        return t("cardDesc");
      }

      return jsx("li", {
        style: {
          listStyle: "none",
          border: "1px solid " + (open ? "var(--dsw-alias-label-dimmed, #4b5563)" : "var(--dsw-alias-border-l2, #333)"),
          borderRadius: "12px",
          background: open ? "var(--dsw-alias-bg-layer-2, #1e1e1e)" : "var(--dsw-alias-bg-layer-3, #242424)",
          transition: "border-color .16s, background .16s",
        },
        children: jsxs("div", {
          children: [
            jsxs("button", {
              type: "button",
              onClick: () => setOpen(!open),
              style: {
                width: "100%",
                appearance: "none",
                border: 0,
                background: "none",
                font: "inherit",
                color: "inherit",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "14px 16px",
                borderRadius: "12px",
              },
              children: [
                jsxs("span", {
                  style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "4px" },
                  children: [
                    jsxs("span", {
                      style: {
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "15px",
                        fontWeight: "600",
                        lineHeight: 1.4,
                        color: "var(--dsw-alias-label-primary, #f3f4f6)",
                      },
                      children: [jsx(GaugeIcon, {}), jsx("span", { children: t("cardTitle") })],
                    }),
                    jsx("span", {
                      style: { fontSize: "13px", lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary, #9ca3af)" },
                      children: t("cardDesc"),
                    }),
                  ],
                }),
                jsx("span", {
                  style: {
                    flex: "none",
                    borderRadius: "999px",
                    padding: "1px 8px",
                    fontSize: "11px",
                    lineHeight: "17px",
                    fontWeight: "500",
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    background: statusActive ? "rgba(16, 185, 129, 0.12)" : "rgba(148, 163, 184, 0.14)",
                    color: statusActive ? "#10b981" : "#94a3b8",
                    border: statusActive ? "1px solid rgba(16, 185, 129, 0.25)" : "1px solid rgba(148, 163, 184, 0.3)",
                  },
                  children: [
                    jsx("span", {
                      style: {
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: statusActive ? "#10b981" : "#94a3b8",
                        display: "inline-block",
                      },
                    }),
                    jsx("span", { children: statusText }),
                  ],
                }),
                jsx(IconChevronDownOutline14, {
                  style: {
                    flex: "none",
                    color: "var(--dsw-alias-label-tertiary, #9ca3af)",
                    transform: open ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform .16s",
                  },
                }),
              ],
            }),
            open
              ? jsxs("div", {
                  style: {
                    borderTop: "1px solid var(--dsw-alias-border-l2, #333)",
                    margin: "0 16px",
                    paddingTop: "14px",
                    paddingBottom: "12px",
                    fontSize: "13px",
                    color: "var(--dsw-alias-label-secondary, #d1d5db)",
                    lineHeight: 1.6,
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                  },
                  children: [
                    jsxs("div", {
                      className: "ocq-section",
                      children: [
                        jsx("div", { className: "ocq-section-title", children: t("secGeneral") }),
                        jsx("label", {
                          className: "ocq-check",
                          children: [
                            jsx("input", {
                              type: "checkbox",
                              checked: value.syncWithModel !== false,
                              disabled: !writable || saving,
                              onChange: (e) => {
                                // Applies immediately — no Save staging for a boolean.
                                void props.quotaSet("syncWithModel", e.target.checked);
                              },
                            }),
                            jsx("span", { children: t("syncWithModel") }),
                            jsx("span", { className: "ocq-field-hint", children: t("syncWithModelHint") }),
                          ],
                        }),
                        jsxs("div", {
                          className: "ocq-field-row",
                          children: [
                            jsxs("label", {
                              className: "ocq-field ocq-field-num",
                              children: [
                                jsx("span", { className: "ocq-field-label", children: t("fieldInterval") }),
                                jsx("input", {
                                  type: "number",
                                  min: 15,
                                  className: "ocq-input",
                                  value: intervalDraft,
                                  disabled: !writable || saving,
                                  onChange: (e) => {
                                    setIntervalDraft(e.target.value);
                                    markDirty();
                                  },
                                }),
                              ],
                            }),
                            jsxs("label", {
                              className: "ocq-field ocq-field-num",
                              children: [
                                jsx("span", { className: "ocq-field-label", children: t("fieldTimeout") }),
                                jsx("input", {
                                  type: "number",
                                  min: 1,
                                  className: "ocq-input",
                                  value: timeoutDraft,
                                  disabled: !writable || saving,
                                  onChange: (e) => {
                                    setTimeoutDraft(e.target.value);
                                    markDirty();
                                  },
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                    jsx("div", { className: "ocq-divider" }),
                    jsxs("div", {
                      className: "ocq-section",
                      children: [
                        jsxs("div", {
                          className: "ocq-sec-head",
                          children: [
                            jsx("div", { className: "ocq-section-title", children: t("secProviders") }),
                            remainingProviders.length > 0
                              ? jsxs("div", {
                                  className: "ocq-picker",
                                  ref: pickerRef,
                                  children: [
                                    jsx("button", {
                                      type: "button",
                                      className: "ocq-btn",
                                      disabled: !writable,
                                      onClick: () => setPickerOpen((o) => !o),
                                      children: "＋ " + t("addProvider"),
                                    }),
                                    pickerOpen
                                      ? jsxs("div", {
                                          className: "ocq-picker-menu",
                                          children: remainingProviders.map((p) =>
                                            jsxs("button", {
                                              type: "button",
                                              className: "ocq-picker-item",
                                              onClick: () => {
                                                void addProvider(p);
                                              },
                                              children: [
                                                jsx("span", { children: t(p.titleKey) }),
                                                jsx("span", { className: "ocq-picker-env", children: p.envVar }),
                                              ],
                                            }, p.id),
                                          ),
                                        })
                                      : null,
                                  ],
                                })
                              : null,
                          ],
                        }),
                        visibleProviderList.length > 0 ? (
                          visibleProviderList.map((p) =>
                            jsxs("div", {
                              className: "ocq-provider-block",
                              children: [
                                jsxs("div", {
                                  className: "ocq-provider-head",
                                  children: [
                                    jsx("span", { className: "ocq-provider-name", children: t(p.titleKey) }),
                                    jsx("span", { className: "ocq-provider-env", children: p.envVar }),
                                    jsx("button", {
                                      type: "button",
                                      className: "ocq-remove-btn",
                                      title: t("removeProviderHint"),
                                      disabled: !writable || saving,
                                      onClick: () => {
                                        void removeProvider(p);
                                      },
                                      children: t("removeProvider"),
                                    }),
                                  ],
                                }),
                                ...p.fields.map((f) => {
                                  const current = resolveField(p, f);
                                  if (f.type === "select") {
                                    return jsxs("label", {
                                      className: "ocq-field",
                                      children: [
                                        jsx("span", { className: "ocq-field-label", children: t(f.labelKey) }),
                                        jsx("select", {
                                          className: "ocq-select",
                                          value: current,
                                          disabled: !writable || saving,
                                          onChange: (e) => setFieldDraft(p, f, e.target.value),
                                          children: f.options.map((o) =>
                                            jsx("option", { value: o, children: t(f.optionLabels?.[o] ?? o) }, o),
                                          ),
                                        }),
                                        jsx("span", { className: "ocq-field-hint", children: t(f.hintKey) }),
                                      ],
                                    }, f.key);
                                  }
                                  return jsxs("label", {
                                    className: "ocq-field",
                                    children: [
                                      jsx("span", { className: "ocq-field-label", children: t(f.labelKey) }),
                                      jsx("input", {
                                        type: f.type ?? "text",
                                        className: "ocq-input",
                                        value: current,
                                        disabled: !writable || saving,
                                        placeholder: t(f.placeholderKey),
                                        autoComplete: "off",
                                        onChange: (e) => setFieldDraft(p, f, e.target.value),
                                      }),
                                      jsx("span", { className: "ocq-field-hint", children: t(f.hintKey) }),
                                    ],
                                  }, f.key);
                                }),
                              ],
                            }, p.id),
                          )
                        ) : (
                          jsx("div", { className: "ocq-empty-hint", children: t("providersEmpty") })
                        ),
                      ],
                    }),
                    statusLine !== "" ? jsx("div", { className: "ocq-card-status", children: statusLine }) : null,
                    error !== null ? jsx("div", { className: "ocq-pop-error", children: error }) : null,
                    jsxs("div", {
                      className: "ocq-pop-foot",
                      children: [
                        jsx("button", {
                          type: "button",
                          className: "ocq-btn",
                          disabled: !writable || saving || !dirty,
                          onClick: onSave,
                          children: saving ? t("cardSaving") : t("saveBtn"),
                        }),
                      ],
                    }),
                  ],
                })
              : null,
          ],
        }),
      });
    }

    // ── registration ──────────────────────────────────────────────────────────

    exports.inject = ["locale", "slots", "configForms", "modelDirectories"];
    exports.apply = function apply(ctx) {
      ensureStyles();
      ctx.locale.register(NS, { zh, en });
      // Live settings snapshot reader for the badge's visibility toggle and
      // the per-session model directory service, both consumed by the badge's
      // slot entry below.
      // The bound scope doubles as the badge's reactive settings source;
      // undefined keeps the always-visible fallback when binding is impossible.
      const configForms = ctx.get ? ctx.get("configForms") : ctx.configForms;
      const settingsScope = ctx.get ? ctx.get("settingsScope") : ctx.settingsScope;
      let badgeSettings;
      try {
        if (configForms?.get) {
          badgeSettings = configForms.get(NS);
        } else if (settingsScope?.bind) {
          badgeSettings = settingsScope.bind({ namespace: NS });
        }
      } catch {
        badgeSettings = undefined;
      }
      ctx.inject(["modelDirectories", "remote.session"], (scope) => {
        const modelDirectories = scope.modelDirectories;
        // A full-width row of its own, stacked ABOVE the composer card (the
        // GoalBar's seat): the quota line gets a whole line for the bars,
        // remaining percents, and reset countdowns.
        ctx.slots.inject("conversation.input.dock", function* () {
        yield ctx.slots.register(
          {
            name: "conversation.input.dock",
            key: "quota-badges",
            id: "quota-badges",
            order: 20,
            locale: NS,
            inject: (sessionId) => ({
              hooks: {
                quotaModel: (() => { try { return modelDirectories?.directoryFor(sessionId)?.store; } catch(e) { return undefined; } })(),
                quotaSettings: badgeSettings,
              },
            }),
          },
          QuotaBadge,
        );
        });
      });

      // Settings card on the Plugins page: bind this plugin's namespace so the
      // API key and poll tuning are editable in the GUI, applied live.
      const quotaSettings = badgeSettings;
      const injectSettings = () => ({
        hooks: { quotaSettings },
        quotaSet: (field, value) => quotaSettings?.set?.(field, value),
      });

      function safeSlotRegister(ctx, options, component) {
        try {
          return ctx.slots.register(options, component);
        } catch (error) {
          console.warn(`[quota-badges] slot "${options.name}" registration skipped:`, error);
          return undefined;
        }
      }

      // 1. DSH 0.1.6+ Plugin Manager: bundle-level configuration
      ctx.slots.inject("plugins.bundle.config", function* () {
        const registration = safeSlotRegister(ctx, {
          name: "plugins.bundle.config",
          key: "dsh-plugin-quota-badges",
          locale: NS,
          inject: injectSettings,
        }, QuotaSettingsCard);
        if (registration !== undefined) yield registration;
      });

      // 2. DSH 0.1.6+ Plugin Manager: row-level configuration
      ctx.slots.inject("plugins.row.config", function* () {
        const registration = safeSlotRegister(ctx, {
          name: "plugins.row.config",
          key: "dsh-plugin-quota-badges#quota-badges",
          locale: NS,
          inject: injectSettings,
        }, QuotaSettingsCard);
        if (registration !== undefined) yield registration;
      });

      // 3. Legacy DSH (< 0.1.6) Settings modal slot
      ctx.slots.inject("settings.plugin.item", function* () {
        const registration = safeSlotRegister(ctx, {
          name: "settings.plugin.item",
          key: "quota-badges",
          id: "quota-badges",
          order: 20,
          locale: NS,
          inject: injectSettings,
        }, QuotaSettingsCard);
        if (registration !== undefined) yield registration;
      });
    };

    return exports;
  },
});
