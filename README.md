# dsh-plugin-quota-badges

> **Rename note**: this plugin was renamed from `dsh-plugin-opencode-quota` to
> `dsh-plugin-quota-badges` (plugin id, settings namespace, HTTP route prefix and
> client module id all switched to `quota-badges`). The source directory keeps
> its old name `dsh-opencode-quota`; the install command below still points at
> that real directory.

DeepSeek Harness bundle: a **multi-vendor subscription-quota badge** for the
Web GUI. Currently supports OpenCode (Zen Go), MiniMax, Kimi Code, and
DeepSeek, querying each vendor's usage windows (or credit balance) and
rendering compact chips in the composer bar next to the model selector.

```
┌──────────────────────────────────────────────────────────────┐
│  composer row 2   [+] [mode] [OpenCode 5h █░░ 78% · Week █ 20%] … [model ▾] │
└──────────────────────────────────────────────────────────────┘
```

The badge occupies the `conversation.input.right` extension slot, immediately
right of the model selector; a text-block progress bar (████░░░░) shows the
remaining share at a glance, and clicking opens the detail popover.

- The badge **aggregates every configured vendor**'s windows (rolling 5-hour /
  weekly; monthly when the vendor reports it) showing the **remaining**
  percentage (remaining-first is easier to act on); color escalates as
  remaining falls below 30% (warn) and 10% (danger).
- Clicking the badge toggles a detail popover: per-vendor sections with percent
  bars per window, reset countdowns, renewal/update stamps, an explicit refresh
  button (refreshes all vendors), and — while a vendor has no API key —
  configuration guidance instead of numbers.
- The server polls every upstream on its own timer (default 60s), so multiple
  open tabs cost nothing extra.
- **Sync with selected model** (on by default): the badge renders only while
  the session's selected model comes from one of the registered quota vendors
  (opencode-family / minimax-family / kimi-family / deepseek-family); switch to
  any other provider and it disappears until you switch back.
- **Architecture**: one provider adapter per vendor (`providers/opencode.js`,
  `providers/minimax.js`, `providers/kimi.js`, `providers/deepseek.js`); each
  normalizes to the shared snapshot shape. The `/status` route carries every
  vendor's state under `all` while keeping the single-provider top-level fields
  for compatibility.
- OpenCode window parsing is ported from
  [CodexBar](https://github.com/) `Sources/CodexBarCore/Providers/OpenCodeGo/OpenCodeGoUsageFetcher.swift`
  (`usage-core.js`, dependency-free and unit-tested); MiniMax parsing is a
  simplified port of the **API-token / JSON path** of
  `Sources/CodexBarCore/Providers/MiniMax/MiniMaxUsageFetcher.swift`
  (`providers/minimax.js`); Kimi Code parsing is a port of the **API-key
  path** of `Sources/CodexBarCore/Providers/Kimi/KimiUsageFetcher.swift`
  (`providers/kimi.js`: the weekly membership pool is the top-level `usage`
  detail, the 5-hour rate lane is `limits[0]`, counts arrive as strings with
  `used` authoritative and `remaining` the fallback). DeepSeek is a
  **balance-model** vendor (no quota windows): the adapter is a port of the
  **API-key balance path** of
  `Sources/CodexBarCore/Providers/DeepSeek/DeepSeekUsageFetcher.swift`
  (`providers/deepseek.js`: `/user/balance` `balance_infos[]`, preferring a
  funded USD entry, then any funded currency, then USD; the client renders a
  balance lane - amount plus an availability bar - instead of percent windows).
- **Model-list sync** (OpenCode-only): fixes dsh's "fetch available models"
  showing a stale pinned catalog for the OpenCode route — the endpoint's live
  `/models` listing is merged with the installed catalog and written into the
  `llm-pi-ai` settings, so new models appear in the selector immediately
  (see the dedicated section below).

## Why a server-side proxy

The browser cannot call opencode.ai directly: the endpoint answers CORS
preflights with a plain 404 HTML page, so cross-origin requests fail. The
plugin's server half therefore polls upstream from Node and serves the cached
snapshot over same-origin routes registered through the shared `webServer`
service — no ports, no CORS, no token in the browser.

## Install

```sh
node /path/to/deepseek-harness/apps/cli/lib/bin.js plugin --profile web \
  add "file:/root/dsh-opencode-quota"
# then restart the web server
```

The command adds the package as a profile dependency, appends it to the
profile's bundle stack (it declares `dsh.bundle.patch`), and the inserted row
is live after the next server restart. Verify composition without booting:

```sh
dsh --profile web --dump-config | grep -A8 quota-badges
```

## Configuration

**Recommended: everything through the Web UI** — open Settings → Plugins and
use the "OpenCode subscription quota" card: paste the API key, tune the poll
interval and timeout, hit Save; edits apply live without a restart.

The card is laid out in three grouped sections - **General / Providers / Model
behavior**. "Providers" shows only the vendors you connect: the "＋ Add provider"
control on the section header lists the not-yet-connected ones, and each block's
"Remove" button unpins it **and clears its saved key** (re-add it later if
needed). The selection persists in `visibleProviders`; vendors added by future
plugin versions are opt-in, so the card never grows with the catalog. Under the
hood the section stays driven by the client-side `PROVIDER_FIELDS` registry: a
new vendor is one server adapter under `providers/` plus one registry entry.

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `''` | Explicit OpenCode API key; empty falls back to the env var below. |
| `apiKeyEnvVar` | `OPENCODE_API_KEY` | Environment variable read when `apiKey` is empty (composition layer only). |
| `providers.minimax.apiKey` | `''` | MiniMax API token; empty falls back to `MINIMAX_CN_API_KEY`. |
| `providers.minimax.region` | `cn` | MiniMax region: `cn` (api.minimaxi.com) or `global` (api.minimax.io). |
| `providers.kimi.apiKey` | `''` | Kimi Code (Kimi For Coding subscription) API key; empty falls back to `KIMI_CODE_API_KEY`. |
| `providers.deepseek.apiKey` | `''` | DeepSeek API key (balance-model account, no quota windows); empty falls back to `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY`. |
| `providers.kimi.baseURL` | `https://api.kimi.com` | Kimi usage endpoint base (`/coding/v1/usages`; change only to test a compatible proxy). |
| `visibleProviders` | `['opencode', 'minimax']` | Providers pinned as blocks in the settings card; the rest wait behind the "add provider" picker (UI-only; the server still polls every registered provider). |
| `intervalSec` | `60` | Upstream poll period (floored at 15). |
| `timeoutSec` | `10` | Per-request upstream timeout. |
| `statusPath` | `/api/quota-badges/status` | GET route serving the cached snapshot (restart to change). |
| `refreshPath` | `/api/quota-badges/refresh` | POST route forcing one refresh of all vendors (restart to change). |
| `modelsSyncEnabled` | `true` | Master switch for the model-list fix (discovery enrichment + sync button; OpenCode-only). |
| `modelsRouteKey` | `opencode-go` | The llm-pi-ai provider route this plugin keeps current. |
| `modelsBaseURL` | `https://opencode.ai/zen/go/v1` | Endpoint probed for the live model listing. |
| `syncModelsPath` | `/api/quota-badges/sync-models` | POST route forcing one model-list sync (restart to change). |

### Multi-vendor configuration

The top-level flat keys (`apiKey`, `modelsRouteKey`, …) act as the **OpenCode
compatibility layer** (used by the legacy settings document); a nested
`providers.<id>.*` block overrides per-vendor config. MiniMax supports:

- `providers.minimax.apiKey` — API token (Bearer); empty falls back to the
  `MINIMAX_CN_API_KEY` env var.
- `providers.minimax.region` — `cn` (default, api.minimaxi.com) or `global`
  (api.minimax.io).

Kimi Code (the Kimi For Coding subscription, distinct from the Moonshot/Kimi
Open Platform) supports:

- `providers.kimi.apiKey` — Kimi Code API key (Bearer); empty falls back to
  the `KIMI_CODE_API_KEY` env var.
- `providers.kimi.baseURL` — usage endpoint base (default
  `https://api.kimi.com`, endpoint `/coding/v1/usages`; only for testing a
  compatible proxy).

DeepSeek is a balance-model account (no quota windows) and supports:

- `providers.deepseek.apiKey` — DeepSeek API key (Bearer); empty falls back
  to the `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` env vars. The client renders a
  balance card: the amount with a Paid/Granted split, a full availability
  bar while there is usable balance and an empty one once it runs out.

The `/status` top-level fields always describe the *active* vendor (the first
registered one, opencode); the new `all` field carries every vendor's
`{provider, displayName, data, error, fetchedAt, ageSec}` for the client's
aggregate view.

## Model-list sync (v0.5.0)

For a built-in catalog provider such as `opencode-go`, dsh's "fetch available
models" action answers from the pi-ai model catalog pinned at install time and
never contacts the endpoint, so models the upstream adds later stay invisible.
This plugin fixes that from two directions:

1. **Discovery enrichment**: wraps the `llm-pi-ai` discovery registered in the
   llm runtime so "fetch available models" returns *live listing ∪ catalog
   metadata* — live ids first in endpoint order, catalog-only ids appended,
   catalog entries keeping their names and capacities. Best-effort: when the
   internal registration cannot be found it disables itself with one warning.
2. **Explicit sync**: the card's "Sync model list" button (or
   `POST <syncModelsPath>`) probes the live `/models` listing, merges it with
   the route's current models via `ctx.llm.listModels()`, and writes the union
   into the `llm-pi-ai` user settings layer at
   `providers.<modelsRouteKey>.models` through the public settings write API.
   The write validates against llm-pi-ai's own schema and the adapter
   re-resolves profiles per request, so new models are selectable without a
   restart.

Note: an explicit sync **replaces** that route's `models` list with the merged
result (other route fields are untouched). Models unknown to the catalog are
written as bare ids and inherit dsh's defaults (262144 context / 32768 output,
text-only); declare `input` manually for vision-class models when needed.

### v0.6.0: route api + registry capacity enrichment

- A sync also writes `modelsRouteApi` (default `openai-completions`) as the
  route-level wire protocol — without it dsh refuses to save a listing that
  contains catalog-unknown ids (the "needs an api" validation).
- New `modelsEnrichFromRegistry` (on by default): both the sync and "fetch
  available models" pull each new model's context length, max output, display
  name, and image modality from the models.dev registry (OpenCode's model
  database); alias entries resolve through their canonical file. The few very
  fresh models the registry lacks stay bare and take dsh defaults, editable by
  hand at any time.

### v0.6.2: fast fetch + deeper registry coverage

- "Fetch available models" never blocks on the registry for more than three
  seconds: a slow first scan finishes in the background and the next fetch is
  served instantly from cache (answers now cache six hours; empty scans retry
  after one minute). Registry requests use their own four-second timeout and a
  concurrency cap of five.
- Alias entries now follow their whole `base_model` chain (cycle-safe), and an
  id the registry cannot size inherits capacities from its closest sized
  dash-boundary sibling in the route's catalog (e.g.
  `deepseek-v4-flash-vision-exp` from `deepseek-v4-flash`). Modalities are
  still never guessed.

### v0.6.3: vision input for the OpenCode route

- Why the same vision model worked on the official DeepSeek route but not on
  this one: the official adapter's catalog declares
  `deepseek-v4-flash-vision-exp` with `inputModalities: ["text", "image"]`,
  while an entry this plugin writes carries no `input` field and falls back
  to text-only - so attachments get refused.
- A sync now grants `input: ["text", "image"]` to every route model whose
  exact id another registered provider in the same process declares
  multimodal (exact-id cross-provider match is data, not a guess; video/pdf
  modalities are ignored). The sync reply reports the count as
  `grantedImageInput`.
- Startup heals the same field on already-saved models once, because the
  GUI's own save path sends no per-model input field and would otherwise drop
  image support until the next sync. Re-saving an adopted listing in the GUI
  still strips `input` - one sync click (or a restart) restores it.
- Registry 404s are now treated as definitive absence instead of falling
  through to the raw mirror, which keeps cold scans fast when the endpoint
  lists ids the registry has never heard of.

### v0.6.4: explicit vision whitelist

- New config `modelsVision` (array of model ids) forces `input: ["text",
  "image"]` on those models regardless of auto-detection; `modelsTextOnly`
  strips image input instead. Vision wins when an id is in both lists. The
  sync reply reports `forcedVision` / `forcedTextOnly` counts.
- dsh already refuses an image attachment to a model whose `input` lacks
  `image` at request time, so these lists are about explicit control and
  discoverability, not the only safety net. Empty by default.

UI saves land in the user settings layer and take effect immediately;
composition-layer defaults can still be declared in the profile patch. Route
paths are boot-time composition values — changing them requires a restart.

## HTTP API

- `GET <statusPath>` → `{ ok, provider, displayName, data, error, fetchedAt, ageSec, providers, all }`;
  never touches upstream. Top-level fields describe the active (first
  registered) provider; `all` carries every vendor's
  `{ provider, displayName, data, error, fetchedAt, ageSec }`.
- `POST <refreshPath>` → forces one upstream fetch for **every** vendor, then
  returns the same body.
- `POST <syncModelsPath>` → syncs the model listing (OpenCode-only) and answers
  `{ ok, routeKey, total, added[], removed[], syncedAt }`; on failure
  `{ ok: false, error: { code, message } }` with code ∈ unconfigured / disabled /
  no-settings / invalid-credentials / api-error / parse-failed / network-error /
  settings-write-failed.

`data` is `{ rolling?, weekly?, monthly?, renewsAt?, fetchedAt }`, each window
`{ percent, resetInSec }`. When no key is configured the body carries
`error.code === "unconfigured"` instead.

## Client badge

Registered into the `conversation.input.right` list slot declared by
`ui-conversation` (list id `quota-badges`, order 10). The badge **aggregates
every configured vendor** (window labels gain a vendor prefix when more than
one vendor is visible) and the popover groups windows per vendor. The badge
keeps the last snapshot on upstream failure and marks itself stale;
unconfigured shows a muted hint chip whose tooltip names the missing env vars
(`OPENCODE_API_KEY` / `MINIMAX_CN_API_KEY`). With `syncWithModel` on, the
badge only renders while the selected model's provider matches one of the
registered quota vendors.

## Model Experience

None, as the plugin contributes no tools, prompt sections, or model-visible
state; it is a host HTTP proxy plus a presentational composer chip.

#### KV Cache effect

None; nothing here reaches a model request.

## Upgrading from the OpenCode-only version

1. **Rename**: `dsh-plugin-opencode-quota` → `dsh-plugin-quota-badges` (plugin
   id, settings namespace, route prefix and client module id all switched).
   Rebuild the profile dependency and restart, then verify with
   `dsh --profile web --dump-config | grep -A8 quota-badges`.
2. **Settings migration**: saved settings under the old `opencode-quota`
   namespace are not visible under the new one. Run the one-shot script in
   this repo (comment-preserving, idempotent; the settings-file watcher
   hot-publishes, no restart needed):
   ```sh
   node scripts/migrate-legacy-settings.mjs
   ```
   It defaults to `$DSH_HOME/settings.yaml` (`~/.dsh/settings.yaml`) and
   accepts an explicit path; it refuses to run when both the legacy and new
   sections already exist.
3. **Development**: install with `dsh plugin --profile web add
   "link:/root/dsh-opencode-quota"` so the profile symlinks the source
   directory; code changes then only need a `systemctl restart
   deepseek-harness.service`, not a reinstall.

## Known Limitations and Deferred Work

- MiniMax implements only the **API-token / JSON** path (CN + global regions);
  CodexBar's cookie/HTML scraping, billing history, and multi-service lane
  details are not ported yet.
- The discovery enrichment relies on an internal structure of the llm runtime
  (the `discoveries` map); a dsh upgrade that moves it silently degrades to
  catalog-only fetch answers (a startup warning says so), while the explicit
  sync button keeps working.
- The status routes are registered on the shared web server; when the profile
  fronts it with an authenticating replacement (e.g. `webserver-auth`),
  coverage depends on that plugin's dispatch wrapping — verify before exposing
  beyond loopback.
- The client half hardcodes the two default route paths; changing them in
  config requires editing the constants atop `client.js`.
