# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Reporting a vulnerability

Please report security issues **privately** through GitHub's
[Security Advisories](https://github.com/LeeeWM/dsh-session-notifier/security/advisories/new)
for this repository. Do not open a public issue for an unfixed vulnerability.

Include:

- the plugin version and DSH version;
- Windows version / PowerShell version;
- a minimal reproduction (configuration, event sequence, or notification
  payload);
- the impact you believe the issue has.

## Scope

`dsh-session-notifier` runs in the DSH host process and starts a local
`powershell.exe` child process to display notifications. In scope:

- shell/argument injection through session titles, working directories, or
  configuration values;
- unintended network or credential access;
- privilege escalation through the notifier process;
- denial of service caused by notification timers or child processes.

Out of scope:

- Windows Focus Assist / notification settings suppressing a toast;
- the PowerShell AUMID attribution label shown by Windows;
- issues in DSH itself, Windows, or PowerShell;
- social-engineering or physical-access scenarios.
