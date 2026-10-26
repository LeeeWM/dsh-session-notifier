# dsh-session-toast

[中文](README.md) | **English**

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.3-4f46e5)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/platform-Windows%2011-0078D4)](#requirements)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-22d3ee)](https://github.com/topics/dsh-plugin)

A DeepSeek Harness host plugin that shows a **Windows 11 toast notification when a session turn finishes** — similar to Claude Code / Codex completion notifications. By default it only notifies when DSH is not in the foreground, so you are not interrupted while watching a response.

## Why

Long agent runs are common. You switch to another app, the turn finishes, and nothing tells you. This plugin turns DSH's `turn/end` event into a native Windows notification with the session title, duration and turn number.

- **Zero runtime dependencies** — no npm packages, no BurntToast, no registry writes.
- **Focus-aware** — checks whether `DeepSeek Harness` owns the foreground window before showing anything.
- **Coalesced** — a 1.2 s debounce cancels a pending toast when the next turn starts (goal / inbox continuation).
- **Subagent-safe** — subagent sessions are ignored by default to avoid toast storms.
- **Clean lifecycle** — every timer and child process is registered through `ctx.effect`.

## Features

| Feature | Behavior |
| --- | --- |
| Turn completion | Listens to `session/event` → `turn/end`; notifies on `completed` and `error` by default |
| Title | Uses `session/title`; falls back to the working-directory name |
| Body | Session title · duration · turn number; error message on failures |
| Focus policy | Suppresses the toast while `DeepSeek Harness` is foreground |
| Debounce | 1.2 s; a following `turn/start` cancels the pending toast |
| Subagents | Off by default; enable with `notifySubagents: true` |
| Native toast | WinRT `ToastNotificationManager`; falls back to `NotifyIcon` balloon |
| Unicode-safe | Payload is base64(UTF-8 JSON); Chinese and emoji survive PowerShell 5.1 |
| Config | 15 optional keys (see [Configuration](#configuration)) |

## Requirements

- Windows 11 (Windows PowerShell 5.1 is present on every install).
- DeepSeek Harness `0.2.1-rc.3` (tested; declared in `dsh.compatibility`).
- Node.js 20+ (provided by DSH).

The plugin is inactive on non-Windows platforms.

## Install

> ⚠️ Install under the name **`dsh-session-toast`** only. The npm package `dsh-session-notifier` belongs to a different author and is unrelated to this project.

### From GitHub (recommended)

```powershell
dsh plugin --profile <profile> add github:LeeeWM/dsh-session-toast
dsh --profile <profile> --dump-config | Select-String "dsh-session-toast"
```

Use this for a non-desktop profile (`web`, `headless`, etc.).

For the Desktop profile, install through the UI: **Plugins → Add plugin → Install a third-party plugin**, pointing at a local clone of this repository. The Desktop profile is managed by Electron and rejects CLI installs by design.

```powershell
git clone https://github.com/LeeeWM/dsh-session-toast.git
```

### Local development

```powershell
# Desktop: Plugins → Add plugin → third-party plugin → absolute plugin directory
# Non-desktop:
dsh plugin --profile <profile> add "C:\path\to\dsh-session-toast"
```

Local directory installs are `link:` installs. After editing `index.js` or `notify.ps1`, disable and re-enable the plugin (or restart DSH) to load the new module generation.

> **Renamed in v0.2.0.** 0.1.x shipped as `dsh-session-notifier`, but that npm name is taken by an unrelated package from another author (a web client + WSL notifier), so installing "by name" pulled the wrong plugin. Since v0.2.0 the package name, plugin row id and GitHub repository are all **`dsh-session-toast`**. To upgrade:
>
> 1. **Remove** the old `dsh-session-notifier` in Plugins, including the unrelated npm `1.x` package if it was installed by name;
> 2. install `dsh-session-toast` as described above;
> 3. click **Install → Enable now** and confirm `# == dsh-session-toast` shows up in `--dump-config`.

## Configuration

All keys are optional. Overrides are **whole-row replacements** — repeat every key you need.

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` registers nothing |
| `notifyOn` | `'completed-and-error'` | `'completed'`, `'completed-and-error'`, or `'all'` (also aborted / blocked / max-tokens) |
| `onlyWhenUnfocused` | `true` | Skip while DSH owns the foreground window |
| `sound` | `true` | Play the system notification sound |
| `language` | `'zh'` | Built-in strings: `'zh'` or `'en'` |
| `debounceMs` | `1200` | Coalescing window; a following `turn/start` cancels |
| `minTurnDurationMs` | `0` | Skip turns shorter than this |
| `notifySubagents` | `false` | Also notify subagent sessions |
| `dshProcessNames` | `['DeepSeek Harness']` | Process names considered "DSH is focused" (case-insensitive) |
| `mode` | `'auto'` | `'auto'`, `'toast'`, or `'balloon'` |
| `aumid` | `''` | Optional registered AppUserModelID; defaults to the PowerShell AUMID |
| `logFile` | `''` | UTF-8 diagnostic log written by `notify.ps1` |
| `timeoutMs` | `20000` | Kill a hung notifier process after this |
| `dryRun` | `false` | Log the payload instead of showing a toast (tests) |
| `appName` | `'DeepSeek Harness'` | Attribution text in the notification |

### Override example

In the machine-level user layer `$DSH_HOME/cordis.patch.yml`:

```yaml
- id: dsh-session-toast
  name: dsh-session-toast
  config:
    enabled: true
    notifyOn: completed-and-error
    onlyWhenUnfocused: false
    sound: true
    language: en
    debounceMs: 1200
    notifySubagents: false
    mode: auto
    logFile: 'C:\Users\you\.dsh\logs\dsh-session-toast.log'
```

> Do not hand-edit `~/.dsh/profiles/desktop/package.json` or its `cordis.patch.yml`; the Desktop profile is managed by the plugin manager. Use `--patch <overlay.yml>` for temporary development overlays.

## How it works

```
DSH session ──turn/start──▶ remember start time, cancel pending toast
            ──session/title▶ cache title
            ──turn/end────▶ filter (subagent / reason / min duration)
                             └─ 1.2 s debounce
                                 └─ spawn powershell.exe notify.ps1
                                     ├─ DSH foreground? → skip
                                     └─ WinRT toast → balloon fallback
```

- Event API: `ctx.on('session/event', (session, event) => …)`, the same pattern used by the official `dsh-session-persistence-jsonl` package.
- Delivery: `notify.ps1` runs under Windows PowerShell 5.1. The payload is base64(UTF-8 JSON), so Chinese/emoji never pass through a console code page.
- The plugin imports **no `@deepseek-ai/*` packages**; only Node built-ins. A local `link:` install therefore does not depend on module resolution inside the DSH installation directory.

## Files

| Path | Purpose |
| --- | --- |
| `index.js` | Host plugin: config, event listeners, debounce, notifier spawn |
| `notify.ps1` | Windows delivery: foreground check, WinRT toast, balloon fallback, exit codes |
| `cordis.patch.yml` | Inserts the plugin row (`id: dsh-session-toast`, `name: dsh-session-toast`) |
| `package.json` | `dsh.bundle.patch`, `dsh.compatibility`, `files` whitelist, scripts |
| `locale/{zh,en}.json` | Plugins page title/description |
| `icon.svg` | Plugin icon |
| `test/mock-apply.mjs` | Offline mock-host tests (no notification) |
| `test/live-smoke.mjs` | Manual test that shows one real toast |
| `README.md` / `README.en.md` | Chinese / English docs |
| `CHANGELOG.md` / `SECURITY.md` / `LICENSE` | Release history, security policy, MIT license |

## Development and verification

```powershell
npm run check                 # node --check index.js
npm test                      # 10 offline mock-host checks
npm run test:live             # shows one real Windows toast
```

Static checks:

```powershell
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('json ok')"
# PowerShell parser (Windows PowerShell 5.1)
$t=$null;$e=$null
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'notify.ps1').Path,[ref]$t,[ref]$e)
"ps errors: $($e.Count)"
```

The mock suite covers listener registration, disabled mode, title/duration/turn rendering, debounce cancellation, subagent filtering, `notifyOn` modes, duplicate `turn/end`, cwd fallback, late title refresh, and teardown.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No notification | Check Windows Settings → System → Notifications / Focus Assist; set `onlyWhenUnfocused: false`; set `logFile` and inspect the notifier log |
| Installed but nothing ever fires (check this first) | Confirm the plugin is actually **enabled**: `dsh --profile <profile> --dump-config` must contain a `# == dsh-session-toast` layer, and the desktop Plugins page must show Enabled. A package that is only a dependency in `package.json` while missing from `dsh.profile.bundles` is never loaded, so it can never notify |
| Nothing while DSH is focused | Intended default; use `onlyWhenUnfocused: false` |
| Source label says "Windows PowerShell" | The toast borrows the registered PowerShell AUMID; register a custom AUMID and set `aumid` if you need a different label |
| Subagent turns do not notify | `notifySubagents` defaults to `false` |
| Too many notifications | Increase `minTurnDurationMs` / `debounceMs`, or use `notifyOn: 'completed'` |
| Plugin did not load | Startup log should contain `[dsh-session-toast] loaded (…)` |

Set `DSH_SESSION_TOAST_DEBUG=1` (`DSH_SESSION_NOTIFIER_DEBUG=1` from 0.1.x still works) to make DSH's console print where each `turn/end` went — queued, or skipped by which rule — plus the exact payload, the PowerShell PID and `notify.ps1`'s own `DELIVERED` / `SKIPPED reason=…` lines. That is the quickest way to tell "not loaded" from "filtered" from "suppressed by the focus policy".

## Known limitations

- Windows only; the plugin is inactive elsewhere.
- Requires Windows PowerShell 5.1 (present on Windows 11); no `pwsh`/BurntToast needed.
- Focus Assist or a disabled notification toggle can drop the toast silently. `mode: 'balloon'` is an alternative channel.
- Toast disappears after ~5 seconds; there is no click-to-focus action.
- Notification text includes the session title and is rendered locally only.
- Goal continuations that start more than the debounce window after `turn/end` may produce a "completed" toast before the goal really finishes. DSH exposes no public session-idle event; tune `debounceMs` if needed.

## Security

- The plugin reads only `session/title`, `session/header.cwd`, `turn/end` and `session/disposed` events.
- It spawns a local PowerShell process with `-NoProfile -NonInteractive -WindowStyle Hidden`; no network, no credential access, no shell interpolation (arguments are passed as an array).
- No GitHub token or account data is used at runtime. The optional `logFile` contains notification text only.
- See [SECURITY.md](SECURITY.md) for reporting.

## Uninstall

Desktop: **Plugins → dsh-session-toast → Remove**.

Other profiles:

```powershell
dsh plugin --profile <profile> remove dsh-session-toast
dsh --profile <profile> --dump-config | Select-String "dsh-session-toast"
```

## License

[MIT](LICENSE) © 2026 [LeeeWM](https://github.com/LeeeWM)
