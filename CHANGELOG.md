# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-26

### Changed

- **Renamed to `dsh-session-toast`.** The 0.1.x name `dsh-session-notifier` is
  taken on npm by an unrelated package from another author, so name-based
  installs resolved to the wrong plugin. Package name, plugin row id, bundle
  patch, locale entries, docs and the GitHub repository now all use
  `dsh-session-toast`.
- Default `onlyWhenUnfocused` stays `true`: notifications are still suppressed
  while a DSH window owns the foreground.

### Added

- Real diagnostic channel: `DSH_SESSION_TOAST_DEBUG=1` (the 0.1.x variable
  `DSH_SESSION_NOTIFIER_DEBUG=1` is still honoured). It now reports why a
  `turn/end` did or did not notify — duplicate turn, subagent, `notifyOn`
  filter, `minTurnDurationMs`, or queued for debounce — and it pipes
  `notify.ps1`'s stderr so `DELIVERED` and `SKIPPED reason=…` reach DSH's
  console instead of being dropped by `stdio: 'ignore'`.
- The load line now prints the delivery `mode`, so "plugin loaded but nothing
  happens" can be told apart from "plugin never loaded".
- README troubleshooting: the first check is whether the plugin row actually
  exists in the profile tree (`# == dsh-session-toast` in `--dump-config`).
- A 180×180 raster icon (`assets/icon-180.png`) rendered from `icon.svg`, for
  the plugin market's storefront tile (the market only accepts GitHub-hosted
  bitmaps, not SVG).

### Fixed

- Documentation for the old name: the 0.1.x notes claimed the package was
  published from `@local/dsh-session-notifier`, which is what made name-based
  installs pick up someone else's npm package.

## [0.1.0] - 2026-10-25

### Added

- Initial release of the plugin (originally `dsh-session-notifier`).
- Listens to DSH `session/event` → `turn/end` and notifies on completed and
  errored turns.
- Native Windows 11 WinRT toast with `NotifyIcon` balloon fallback.
- Foreground policy that suppresses notifications while `DeepSeek Harness` is
  focused; configurable process names.
- Session title / working-directory fallback, duration and turn number in the
  notification body; late `session/title` refresh via the optional
  `sessionTitle` service.
- 1.2 s debounce with cancellation on the next `turn/start`, subagent filtering
  and duplicate-`turn/end` suppression.
- Unicode-safe base64(UTF-8 JSON) payloads for Windows PowerShell 5.1.
- Optional diagnostic log, custom AUMID, `toast`/`balloon`/`auto` channels.
- Offline mock-host tests and a manual live-toast smoke test.
- Chinese and English documentation, MIT license, security policy.

[0.1.0]: https://github.com/LeeeWM/dsh-session-toast/releases/tag/v0.1.0
