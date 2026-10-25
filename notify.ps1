<#
.SYNOPSIS
  DSH desktop notification delivery for Windows 11 (Windows PowerShell 5.1 only).

.DESCRIPTION
  Called by the DSH host plugin through Node.js:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden ^
      -File notify.ps1 -PayloadBase64 <base64 of UTF-8 JSON>

  Payload (UTF-8 JSON, base64-encoded):
    {
      "title":             string,  // required in practice
      "body":              string,
      "appName":           string,  // default "DeepSeek Harness"
      "sound":             bool,    // default false
      "onlyWhenUnfocused": bool,    // default false
      "focusProcessNames": [string],// default ["DeepSeek Harness"]
      "aumid":             string,  // optional, must be a registered AUMID
      "mode":              string   // optional "auto" | "toast" | "balloon"
    }

  Delivery:
    * primary  : WinRT toast (Windows.UI.Notifications) using the registered
                 Windows PowerShell AUMID by default. No installs, no registry writes.
    * fallback : System.Windows.Forms.NotifyIcon balloon tip, used when native
                 toast throws or when toasts are disabled in Windows settings,
                 or explicitly with -Mode balloon.

  Foreground policy:
    onlyWhenUnfocused=true -> if the foreground window belongs to one of
    focusProcessNames, the notification is skipped and exit code is 0.

  Exit codes:
    0 = delivered, or intentionally skipped by the foreground policy
    1 = invalid payload / decode error
    2 = delivery failed (both toast and balloon paths failed)

.NOTES
  This file is intentionally pure ASCII: PowerShell 5.1 reads BOM-less .ps1 files
  as ANSI (GBK on zh-CN), which would corrupt non-ASCII literals. All localized
  text arrives via the UTF-8 payload instead.

  Verified on Windows 11 Home China build 26300, Windows PowerShell 5.1.26100.9711,
  1920x1080 @100% DPI, no pwsh.exe, no BurntToast module (see REPORT.md).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$PayloadBase64,

    [ValidateSet('auto', 'toast', 'balloon')]
    [string]$Mode = 'auto',

    # Optional CLI overrides (used by tests; payload values win when both are absent).
    [string[]]$FocusProcessNames = $null,
    [string]$Aumid = $null,
    [string]$LogFile = $null
)

$ErrorActionPreference = 'Stop'

# Bind the diagnostic log before any payload parsing: payload errors must be
# traceable too (this is what makes exit code 1 debuggable).
$script:LogPath = $null
if ($LogFile) { $script:LogPath = $LogFile }

# AUMID of the Start-Menu-registered "Windows PowerShell" shortcut.
# It is present on a stock Windows 11 install, so toasts posted with it are
# accepted without registering anything ourselves.
$script:DefaultAumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$script:DefaultFocusProcessNames = @('DeepSeek Harness')
$script:ToastSettleMs = 300
$script:BalloonVisibleMs = 6000

function Write-Diag {
    param([string]$Message)
    if ($script:LogPath) {
        try {
            $dir = Split-Path -Parent $script:LogPath
            if ($dir -and -not (Test-Path -LiteralPath $dir)) {
                New-Item -ItemType Directory -Force -Path $dir | Out-Null
            }
            $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff'), $Message
            Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
        }
        catch { }
    }
    try { [Console]::Error.WriteLine($Message) } catch { }
}

function Get-JsonField {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop -or $null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function ConvertTo-Bool {
    param($Value, [bool]$Default = $false)
    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { return $Value }
    $s = ([string]$Value).Trim().ToLowerInvariant()
    if ($s -eq 'true' -or $s -eq '1' -or $s -eq 'yes' -or $s -eq 'on') { return $true }
    if ($s -eq 'false' -or $s -eq '0' -or $s -eq 'no' -or $s -eq 'off' -or $s -eq '') { return $false }
    return $Default
}

function ConvertTo-XmlText {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    # Drop characters that are illegal in XML 1.0 so LoadXml never fails.
    $clean = [regex]::Replace($Text, '[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u10000-\u10FFFF]', ' ')
    return [System.Security.SecurityElement]::Escape($clean)
}

if (-not ('DshNotifyWin32' -as [type])) {
    Add-Type -Namespace '' -Name 'DshNotifyWin32' -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
}

function Get-ForegroundProcessInfo {
    $handle = [DshNotifyWin32]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) { return $null }

    $foregroundPid = [uint32]0
    [void][DshNotifyWin32]::GetWindowThreadProcessId($handle, [ref]$foregroundPid)
    if ($foregroundPid -eq 0) { return $null }

    $name = $null
    $path = $null
    try {
        $proc = Get-Process -Id $foregroundPid -ErrorAction Stop
        $name = $proc.ProcessName
        try { $path = $proc.Path } catch { }
    }
    catch { }

    if (-not $name) {
        # Fallback: some windows cannot be opened by pid, match on window handle instead.
        try {
            $proc = Get-Process | Where-Object { $_.MainWindowHandle -eq $handle } | Select-Object -First 1
            if ($proc) {
                $name = $proc.ProcessName
                try { $path = $proc.Path } catch { }
            }
        }
        catch { }
    }

    return [pscustomobject]@{
        Handle = $handle
        Pid    = $foregroundPid
        Name   = $name
        Path   = $path
    }
}

function Test-FocusedByProcessNames {
    param([string[]]$Names)
    $fg = Get-ForegroundProcessInfo
    if ($null -eq $fg) {
        return [pscustomobject]@{ Focused = $false; Reason = 'no-foreground-window' }
    }
    if (-not $fg.Name) {
        return [pscustomobject]@{ Focused = $false; Reason = ('foreground-pid={0} name-unresolved' -f $fg.Pid) }
    }
    foreach ($raw in $Names) {
        $candidate = ([string]$raw).Trim()
        if (-not $candidate) { continue }
        $candidate = $candidate -replace '\.exe$', ''
        if ($fg.Name -ieq $candidate) {
            return [pscustomobject]@{
                Focused = $true
                Reason  = ('foreground process "{0}" matches "{1}" (pid {2})' -f $fg.Name, $candidate, $fg.Pid)
            }
        }
        if ($fg.Path -and $fg.Path.IndexOf($candidate, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return [pscustomobject]@{
                Focused = $true
                Reason  = ('foreground process path "{0}" contains "{1}"' -f $fg.Path, $candidate)
            }
        }
    }
    return [pscustomobject]@{
        Focused = $false
        Reason  = ('foreground process "{0}" (pid {1}) not in [ {2} ]' -f $fg.Name, $fg.Pid, ($Names -join ', '))
    }
}

function Test-ToastAllowedBySystem {
    try {
        $value = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -Name 'ToastEnabled' -ErrorAction Stop).ToastEnabled
        return ([int]$value -ne 0)
    }
    catch {
        # Value missing = Windows default = enabled.
        return $true
    }
}

function Show-ToastNotification {
    param([string]$Title, [string]$Body, [string]$AppName, [bool]$Sound, [string]$AppId)

    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

    $xmlTitle = ConvertTo-XmlText $Title
    $xmlBody = ConvertTo-XmlText $Body
    $xmlAppName = ConvertTo-XmlText $AppName

    if ($Sound) {
        $audio = '<audio src="ms-winsoundevent:Notification.Default" loop="false"/>'
    }
    else {
        $audio = '<audio silent="true"/>'
    }

    $attribution = ''
    if ($xmlAppName) {
        $attribution = '<text placement="attribution">{0}</text>' -f $xmlAppName
    }

    $xmlString = '<toast><visual><binding template="ToastGeneric"><text>{0}</text><text>{1}</text>{2}</binding></visual>{3}</toast>' -f $xmlTitle, $xmlBody, $attribution, $audio

    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml($xmlString)
    $toast = New-Object Windows.UI.Notifications.ToastNotification($document)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
    $notifier.Show($toast)
    # Give the WinRT queue a moment; the toast itself is owned by the shell and
    # survives this process exiting.
    Start-Sleep -Milliseconds $script:ToastSettleMs
    return $true
}

function Show-BalloonNotification {
    param([string]$Title, [string]$Body, [string]$AppName, [bool]$Sound, [int]$VisibleMs = 6000)

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $trayText = $AppName
    if (-not $trayText) { $trayText = 'DSH' }
    if ($trayText.Length -gt 63) { $trayText = $trayText.Substring(0, 63) }

    $tipTitle = $Title
    if (-not $tipTitle) { $tipTitle = 'DSH' }
    if ($tipTitle.Length -gt 63) { $tipTitle = $tipTitle.Substring(0, 63) }

    $tipText = $Body
    if ([string]::IsNullOrEmpty($tipText)) { $tipText = $Title }
    if ([string]::IsNullOrEmpty($tipText)) { $tipText = ' ' }
    if ($tipText.Length -gt 255) { $tipText = $tipText.Substring(0, 255) }

    $icon = New-Object System.Windows.Forms.NotifyIcon
    try {
        $icon.Icon = [System.Drawing.SystemIcons]::Information
        $icon.Text = $trayText
        $icon.Visible = $true
        if ($Sound) {
            try { [System.Media.SystemSounds]::Asterisk.Play() } catch { }
        }
        $icon.ShowBalloonTip($VisibleMs, $tipTitle, $tipText, [System.Windows.Forms.ToolTipIcon]::Info)
        # Keep the process (and therefore the tray icon) alive for the balloon lifetime.
        Start-Sleep -Milliseconds $VisibleMs
        return $true
    }
    finally {
        try { $icon.Visible = $false } catch { }
        try { $icon.Dispose() } catch { }
    }
}

# ---------------------------------------------------------------- payload ----
$payloadJson = $null
try {
    $bytes = [System.Convert]::FromBase64String($PayloadBase64)
    $payloadJson = [System.Text.Encoding]::UTF8.GetString($bytes)
}
catch {
    Write-Diag ('ERROR payload-base64-invalid: {0}' -f $_.Exception.Message)
    exit 1
}

$payload = $null
try {
    $payload = $payloadJson | ConvertFrom-Json
}
catch {
    Write-Diag ('ERROR payload-json-invalid: {0}' -f $_.Exception.Message)
    exit 1
}

$title = [string](Get-JsonField $payload 'title' 'DSH')
if ([string]::IsNullOrEmpty($title)) { $title = 'DSH' }
$body = [string](Get-JsonField $payload 'body' '')
$appName = [string](Get-JsonField $payload 'appName' 'DeepSeek Harness')
if ([string]::IsNullOrEmpty($appName)) { $appName = 'DeepSeek Harness' }
$sound = ConvertTo-Bool (Get-JsonField $payload 'sound' $false) $false
$onlyWhenUnfocused = ConvertTo-Bool (Get-JsonField $payload 'onlyWhenUnfocused' $false) $false

$payloadMode = [string](Get-JsonField $payload 'mode' '')
$effectiveMode = $Mode
if ($payloadMode -and -not $PSBoundParameters.ContainsKey('Mode')) {
    $effectiveMode = $payloadMode
}
if (@('auto', 'toast', 'balloon') -notcontains $effectiveMode) { $effectiveMode = 'auto' }

$logFromPayload = [string](Get-JsonField $payload 'logFile' '')
if (-not $LogFile -and $logFromPayload) { $LogFile = $logFromPayload }
if ($LogFile) { $script:LogPath = $LogFile }

$names = $FocusProcessNames
if ($null -eq $names -or $names.Count -eq 0) {
    $names = Get-JsonField $payload 'focusProcessNames' $null
    if ($null -eq $names) {
        $names = $script:DefaultFocusProcessNames
    }
    elseif ($names -isnot [array]) {
        $names = @([string]$names)
    }
    else {
        $names = @($names | ForEach-Object { [string]$_ })
    }
}

$effectiveAumid = $Aumid
if (-not $effectiveAumid) { $effectiveAumid = [string](Get-JsonField $payload 'aumid' '') }
if (-not $effectiveAumid) { $effectiveAumid = $script:DefaultAumid }

$isAsciiSafe = $true
if ($title -notmatch '^[\x20-\x7E]*$' -or $body -notmatch '^[\x20-\x7E]*$') { $isAsciiSafe = $false }
Write-Diag ('INFO payload title-len={0} body-len={1} sound={2} onlyWhenUnfocused={3} mode={4} aumid={5} non-ascii-text={6}' -f $title.Length, $body.Length, $sound, $onlyWhenUnfocused, $effectiveMode, $effectiveAumid, (-not $isAsciiSafe))

# ------------------------------------------------------- foreground policy ----
if ($onlyWhenUnfocused) {
    try {
        $focus = Test-FocusedByProcessNames -Names $names
    }
    catch {
        $focus = [pscustomobject]@{ Focused = $false; Reason = ('focus-check-error: {0}' -f $_.Exception.Message) }
    }
    Write-Diag ('INFO foreground ' + $focus.Reason)
    if ($focus.Focused) {
        Write-Diag 'SKIPPED reason=foreground-process-is-dsh'
        exit 0
    }
}

# -------------------------------------------------------------- delivery ----
$delivered = $false
if ($effectiveMode -eq 'toast' -and -not (Test-ToastAllowedBySystem)) {
    Write-Diag 'WARN toasts-disabled-in-windows-settings but mode=toast; trying toast anyway'
}

if ($effectiveMode -eq 'auto' -and -not (Test-ToastAllowedBySystem)) {
    Write-Diag 'INFO toasts-disabled-in-windows-settings -> using balloon'
    $effectiveMode = 'balloon'
}

if ($effectiveMode -eq 'toast' -or $effectiveMode -eq 'auto') {
    try {
        [void](Show-ToastNotification -Title $title -Body $body -AppName $appName -Sound $sound -AppId $effectiveAumid)
        $delivered = $true
        Write-Diag ('DELIVERED channel=toast aumid={0}' -f $effectiveAumid)
    }
    catch {
        Write-Diag ('WARN toast-failed: {0}' -f $_.Exception.Message)
        if ($effectiveMode -eq 'auto') {
            try {
                [void](Show-BalloonNotification -Title $title -Body $body -AppName $appName -Sound $sound -VisibleMs $script:BalloonVisibleMs)
                $delivered = $true
                Write-Diag 'DELIVERED channel=balloon'
            }
            catch {
                Write-Diag ('ERROR balloon-failed: {0}' -f $_.Exception.Message)
            }
        }
    }
}
elseif ($effectiveMode -eq 'balloon') {
    try {
        [void](Show-BalloonNotification -Title $title -Body $body -AppName $appName -Sound $sound -VisibleMs $script:BalloonVisibleMs)
        $delivered = $true
        Write-Diag 'DELIVERED channel=balloon'
    }
    catch {
        Write-Diag ('ERROR balloon-failed: {0}' -f $_.Exception.Message)
    }
}

if (-not $delivered) {
    Write-Diag 'ERROR delivery-failed'
    exit 2
}

exit 0
