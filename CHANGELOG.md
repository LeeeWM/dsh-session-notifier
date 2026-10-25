# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-25

### Added

- Initial release of `dsh-session-notifier`.
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

[0.1.0]: https://github.com/LeeeWM/dsh-session-notifier/releases/tag/v0.1.0
