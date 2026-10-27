# Cosmo PC Agent v3.5 - watches over this PC for Cosmo (Fuse_Box) and,
# during a control session the user starts, lets Cosmo use the mouse,
# keyboard and shell. Always-on, connects OUT to the Fuse_Box box on the
# home network. No inbound ports, no admin rights needed. One file.
# v3: control sessions (banner + stop button + 10-min idle auto-lock),
# mouse/keyboard/shell actions, auto-snapshot after every action,
# per-command results with shell output, background update scan,
# hourly self-update from the box.
# NB: NOT $ErrorActionPreference='SilentlyContinue' at top level. On
# Windows PowerShell 5.1 that promotes warning noise into terminating
# errors, and in a hidden window that can park the agent forever.
$ErrorActionPreference = 'Continue'
$BoxUrl = 'http://192.168.1.10:3180'
$Name = $env:COMPUTERNAME
$Version = '3.5'
$PollSeconds = 2
$StatusSeconds = 60

$InstallDir = Join-Path $env:LOCALAPPDATA 'CosmoPC'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$LogFile = Join-Path $InstallDir 'agent.log'
function Write-Log($msg) {
  try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg) } catch {}
}

# Single instance only. A killed predecessor leaves an abandoned mutex -
# WaitOne throws for that; treat it as acquired.
$mutex = New-Object System.Threading.Mutex($false, 'CosmoPCAgent')
$acquired = $false
try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) { exit 0 }
Write-Log ('agent v' + $Version + ' starting on ' + $Name)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CosmoWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
}
'@

function Get-ForegroundTitle {
  try {
    $h = [CosmoWin]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][CosmoWin]::GetWindowText($h, $sb, $sb.Capacity)
    return $sb.ToString()
  } catch { return '' }
}

$RemoteToolNames = 'anydesk','teamviewer','screenconnect','rustdesk','supremo','ultraviewer','logmein','gotoassist','anyplace','quickassist'
function Get-RemoteToolsRunning {
  $found = @()
  foreach ($p in Get-Process) {
    $n = $p.ProcessName.ToLower()
    foreach ($t in $RemoteToolNames) { if ($n -like "*$t*") { $found += $p.ProcessName } }
  }
  return @($found | Select-Object -Unique)
}

function Post-Json($path, $obj) {
  try {
    $json = $obj | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod -Uri ($BoxUrl + $path) -Method Post -ContentType 'application/json' -Body $json -TimeoutSec 20 | Out-Null
    return $true
  } catch {
    Write-Log ('POST ' + $path + ' failed: ' + $_.Exception.Message)
    return $false
  }
}

function Post-Result($command, $ok, $detail, $output) {
  $o = @{ name = $Name; command = $command; ok = [bool]$ok; detail = [string]$detail }
  if ($null -ne $output) { $o.output = [string]$output }
  Post-Json '/api/pc/result' $o | Out-Null
}

function Get-HealthFast {
  $h = @{}
  $os = $null
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $h.os = $os.Caption; $h.build = $os.BuildNumber
    $h.uptimeMin = [int]((Get-Date) - $os.LastBootUpTime).TotalMinutes
    $h.ramFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
  } catch {}
  try { $cs = Get-CimInstance Win32_ComputerSystem; $h.ramTotalGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } catch {}
  try { $h.cpuLoad = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average } catch {}
  try { $d = Get-PSDrive C; $h.diskFreeGB = [math]::Round($d.Free / 1GB, 1); $h.diskUsedGB = [math]::Round($d.Used / 1GB, 1) } catch {}
  try { $h.topCpu = @(Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName)" }) } catch {}
  try { $h.topRam = @(Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName) ($([math]::Round($_.WorkingSet / 1MB))MB)" }) } catch {}
  try {
    $mp = Get-MpComputerStatus
    $h.defenderOn = [bool]$mp.AntivirusEnabled
    $h.realtimeOn = [bool]$mp.RealTimeProtectionEnabled
    $h.definitionsDaysOld = [int]((Get-Date) - $mp.AntivirusSignatureLastUpdated).TotalDays
  } catch {}
  try { $h.startup = @(Get-CimInstance Win32_StartupCommand | ForEach-Object { $_.Name }) } catch {}
  try { $h.processCount = (Get-Process).Count } catch {}
  return $h
}

# The Windows Update count is slow (a COM search, often minutes). It runs
# in a background job; when it finishes, its count is posted as a small
# follow-up health report that the box merges in.
$script:WuJob = $null
function Start-WuScan {
  if ($script:WuJob) { return }
  try {
    $script:WuJob = Start-Job -ScriptBlock {
      try {
        $sess = New-Object -ComObject Microsoft.Update.Session
        $res = $sess.CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0')
        return $res.Updates.Count
      } catch { return -1 }
    }
    Write-Log 'wu scan started'
  } catch { Write-Log ('wu scan start failed: ' + $_.Exception.Message); $script:WuJob = $null }
}
function Poll-WuScan {
  if (-not $script:WuJob) { return }
  if ($script:WuJob.State -in 'Completed', 'Failed', 'Blocked') {
    $n = -1
    try { $v = Receive-Job $script:WuJob -ErrorAction Stop; if ($null -ne $v) { $n = [int]$v } } catch {}
    Remove-Job $script:WuJob -Force
    $script:WuJob = $null
    Post-Json '/api/pc/health' @{ name = $Name; report = @{ updatesPending = $n } } | Out-Null
    Write-Log ('wu scan posted: ' + $n)
  }
}

function Send-Snapshot {
  try {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $ErrorActionPreference = 'Continue'
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $w = 1280; $hh = [int]($bounds.Height * ($w / $bounds.Width))
    if ($hh -lt 1) { $hh = 1 }
    $small = New-Object System.Drawing.Bitmap $w, $hh
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.DrawImage($bmp, 0, 0, $w, $hh)
    $ms = New-Object System.IO.MemoryStream
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 60L
    $small.Save($ms, $codec, $ep)
    $bytes = $ms.ToArray()
    $b64 = [Convert]::ToBase64String($bytes)
    $g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose(); $ms.Dispose()
    $ok = Post-Json '/api/pc/snapshot' @{ name = $Name; image = $b64; foreground = (Get-ForegroundTitle); remoteTools = @(Get-RemoteToolsRunning) }
    Write-Log ('snapshot posted=' + $ok + ' bytes=' + $bytes.Length)
    return @{ ok = $ok; detail = ('bytes ' + $bytes.Length) }
  } catch {
    Write-Log ('snapshot failed: ' + $_.Exception.Message)
    return @{ ok = $false; detail = $_.Exception.Message }
  }
}

# ---------------- control session ----------------
$script:ControlActive = $false
$script:LastControlAt = Get-Date
$script:Shared = [hashtable]::Synchronized(@{ Banner = $false; StopRequest = $false; Status = ''; Mode = 'hidden'; GuideStop = $false })

function Start-BannerRunspace {
  try {
    $rs = [runspacefactory]::CreateRunspace()
    $rs.ApartmentState = 'STA'
    $rs.Open()
    $rs.SessionStateProxy.SetVariable('shared', $script:Shared)
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript(@'
      try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'Cosmo Control'
        $form.FormBorderStyle = 'None'
        $form.TopMost = $true
        $form.ShowInTaskbar = $false
        $form.StartPosition = 'Manual'
        $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $form.Width = [int]($scr.Width * 0.8)
        $form.Location = New-Object System.Drawing.Point ([int]($scr.Left + ($scr.Width - $form.Width) / 2)), 0
        $redBg = [System.Drawing.Color]::FromArgb(190, 30, 30)
        $blueBg = [System.Drawing.Color]::FromArgb(25, 80, 160)
        $form.BackColor = $redBg
        $form.Visible = $false
        $label = New-Object System.Windows.Forms.Label
        $label.Text = 'Cosmo is controlling this PC - click X or say stop to end it'
        $label.ForeColor = [System.Drawing.Color]::White
        $label.Font = New-Object System.Drawing.Font 'Segoe UI', 12, ([System.Drawing.FontStyle]::Bold)
        $label.AutoSize = $false
        $label.TextAlign = 'MiddleLeft'
        $label.Location = New-Object System.Drawing.Point 14, 2
        $form.Controls.Add($label)
        $sub = New-Object System.Windows.Forms.Label
        $sub.Text = ''
        $sub.ForeColor = [System.Drawing.Color]::White
        $sub.Font = New-Object System.Drawing.Font 'Segoe UI', 13
        $sub.AutoSize = $false
        $sub.TextAlign = 'MiddleLeft'
        $sub.Location = New-Object System.Drawing.Point 14, 34
        $form.Controls.Add($sub)
        $btn = New-Object System.Windows.Forms.Button
        $btn.Text = 'X'; $btn.Width = 46; $btn.Height = 40
        $btn.ForeColor = [System.Drawing.Color]::White
        $btn.BackColor = [System.Drawing.Color]::FromArgb(120, 20, 20)
        $btn.FlatStyle = 'Flat'
        $btn.Add_Click({ $shared.GuideStop = $true; if ($shared.Mode -eq 'control') { $shared.StopRequest = $true }; $shared.Banner = $false })
        $form.Controls.Add($btn)
        $lastMode = ''
        while ($true) {
          $mode = [string]$shared.Mode
          $wantVis = [bool]$shared.Banner
          $st = [string]$shared.Status
          if ($wantVis) {
            if ($mode -eq 'guide') { $form.BackColor = $blueBg; $head = 'Cosmo is guiding you - the mouse is yours' } else { $form.BackColor = $redBg; $head = 'Cosmo is controlling this PC - click X or say stop to end it' }
            if ($label.Text -ne $head) { $label.Text = $head }
            $two = ($st -ne '')
            $form.Height = $(if ($two) { 74 } else { 42 })
            $label.Width = $form.Width - 66; $label.Height = 30
            $sub.Visible = $two
            if ($two -and $sub.Text -ne $st) { $sub.Text = $st }
            $sub.Width = $form.Width - 66; $sub.Height = 32
            $btn.Location = New-Object System.Drawing.Point ($form.Width - 50), 1
          }
          if ($form.Visible -ne $wantVis) { $form.Visible = $wantVis }
          [System.Windows.Forms.Application]::DoEvents()
          Start-Sleep -Milliseconds 80
        }
      } catch {}
'@)
    [void]$ps.BeginInvoke()
    Write-Log 'banner runspace started'
  } catch { Write-Log ('banner runspace failed: ' + $_.Exception.Message) }
}

function Start-Control {
  $script:ControlActive = $true
  $script:LastControlAt = Get-Date
  $script:Shared.StopRequest = $false
  $script:Shared.Mode = 'control'
  $script:Shared.Status = ''
  $script:Shared.Banner = $true
  Write-Log 'control session started'
  Send-Status
}
function Stop-Control($why) {
  if (-not $script:ControlActive) { return }
  $script:ControlActive = $false
  if (-not $script:GuideText) { $script:Shared.Banner = $false }
  else { $script:Shared.Mode = 'guide'; $script:Shared.Status = $script:GuideText }
  Write-Log ('control session ended: ' + $why)
  Send-Status
}
$script:GuideText = ''
function Do-GuideStart($text) {
  $script:GuideText = $text
  $script:Shared.GuideStop = $false
  if (-not $script:ControlActive) { $script:Shared.Mode = 'guide' }
  $script:Shared.Status = $text
  $script:Shared.Banner = $true
  Write-Log ('guide shown: ' + $text)
  Send-Status
}
function Do-GuideStop {
  $script:GuideText = ''
  $script:Shared.Status = ''
  if (-not $script:ControlActive) { $script:Shared.Banner = $false; $script:Shared.Mode = 'hidden' }
  Write-Log 'guide cleared'
  Send-Status
}
function Do-Wiggle {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $pts = @(@(500, 460), @(500, 240), @(720, 460), @(500, 680), @(280, 460), @(500, 460))
  foreach ($p in $pts) {
    $x = Convert-Coord ([int]$p[0]) $b.Left $b.Width
    $y = Convert-Coord ([int]$p[1]) $b.Top $b.Height
    [CosmoWin]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 240
  }
  return (Get-CursorText)
}
function Get-CursorText {
  $pt = New-Object CosmoWin+POINT
  if ([CosmoWin]::GetCursorPos([ref]$pt)) { return ('cursor at ' + $pt.X + ',' + $pt.Y) }
  return 'cursor position unavailable'
}
function To-Abs($v, $max) { return [int](($v / 1000.0) * $max) }

function Convert-Coord($v, $origin, $size) { return [int]($origin + ($v / 1000.0) * $size) }

function Do-Click($xs, $ys, $kind) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x = Convert-Coord ([int]$xs) $b.Left $b.Width
  $y = Convert-Coord ([int]$ys) $b.Top $b.Height
  [CosmoWin]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  $down = 0x0002; $up = 0x0004
  if ($kind -eq 'right') { $down = 0x0008; $up = 0x0010 }
  [CosmoWin]::mouse_event($down, 0, 0, 0, 0) | Out-Null
  Start-Sleep -Milliseconds 70
  [CosmoWin]::mouse_event($up, 0, 0, 0, 0) | Out-Null
  if ($kind -eq 'double') {
    Start-Sleep -Milliseconds 110
    [CosmoWin]::mouse_event(0x0002, 0, 0, 0, 0) | Out-Null
    Start-Sleep -Milliseconds 70
    [CosmoWin]::mouse_event(0x0004, 0, 0, 0, 0) | Out-Null
  }
  Start-Sleep -Milliseconds 60
  return (Get-CursorText)
}

function Do-Scroll($notches) {
  [CosmoWin]::mouse_event(0x0800, 0, 0, ([int]$notches * 120), 0)
}

$VkMap = @{
  enter=0x0D; tab=0x09; esc=0x1B; escape=0x1B; backspace=0x08; delete=0x2E; del=0x2E
  home=0x24; end=0x23; pageup=0x21; pagedown=0x22; up=0x26; down=0x28; left=0x25; right=0x27
  space=0x20; win=0x5B; ctrl=0x11; control=0x11; alt=0x12; shift=0x10
  f1=112; f2=113; f3=114; f4=115; f5=116; f6=117; f7=118; f8=119; f9=120; f10=121; f11=122; f12=123
}
function Do-Key($combo) {
  $parts = @($combo.ToLower().Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
  if ($parts.Length -eq 0) { return }
  $main = $parts[$parts.Length - 1]
  $pressed = @()
  if ($parts.Length -gt 1) {
    foreach ($p in $parts[0..($parts.Length - 2)]) {
      if ($VkMap.ContainsKey($p)) { [CosmoWin]::keybd_event([byte]$VkMap[$p], 0, 0, 0); $pressed += [byte]$VkMap[$p] }
    }
  }
  $code = 0
  if ($VkMap.ContainsKey($main)) { $code = $VkMap[$main] }
  elseif ($main.Length -eq 1) { $code = [int]($main.ToUpper()[0]) }
  if ($code) {
    [CosmoWin]::keybd_event([byte]$code, 0, 0, 0)
    Start-Sleep -Milliseconds 50
    [CosmoWin]::keybd_event([byte]$code, 0, 2, 0)
  }
  for ($i = $pressed.Length - 1; $i -ge 0; $i--) { [CosmoWin]::keybd_event($pressed[$i], 0, 2, 0) }
}

function Escape-SendKeys($text) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    $s = [string]$ch
    if ($s -eq "`n") { [void]$sb.Append('{ENTER}') }
    elseif ($s -eq "`t") { [void]$sb.Append('{TAB}') }
    elseif ('+^%~()[]{}'.Contains($s)) { [void]$sb.Append('{' + $s + '}') }
    else { [void]$sb.Append($s) }
  }
  return $sb.ToString()
}
function Do-Type($text) {
  [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys $text))
}

function Do-Shell($cmdStr) {
  try {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $cmdStr 2>&1 | Out-String
    if ($out.Length -gt 3500) { $out = $out.Substring(0, 3500) }
    return @{ ok = $true; detail = 'shell done'; output = $out.Trim() }
  } catch { return @{ ok = $false; detail = $_.Exception.Message; output = '' } }
}

# Executes ONE control verb (click/type/key/shell/...). Assumes the
# session is already unlocked. Returns a result hashtable; the caller
# posts it and decides on the follow-up snapshot.
$script:UiaList = $null
function Get-UiaTree {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $fg = [CosmoWin]::GetForegroundWindow()
    if ($fg -eq [IntPtr]::Zero) { return @{ ok = $false; detail = 'no foreground window'; output = '' } }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
    if (-not $root) { return @{ ok = $false; detail = 'UIA not available for this window'; output = '' } }
    $list = New-Object System.Collections.ArrayList
    $lines = New-Object System.Collections.ArrayList
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($root, 0))
    while ($queue.Count -gt 0 -and $list.Count -lt 140) {
      $item = $queue.Dequeue()
      $el = $item[0]; $depth = [int]$item[1]
      try {
        $cur = $el.Current
        $name = ([string]$cur.Name -replace '\s+', ' ').Trim()
        $rect = $cur.BoundingRectangle
        if ($name -and -not $cur.IsOffscreen -and $rect.Width -gt 2 -and $rect.Height -gt 2) {
          $type = $cur.ControlType.ProgrammaticName -replace 'ControlType\.', ''
          $cx = [int]($rect.X + $rect.Width / 2); $cy = [int]($rect.Y + $rect.Height / 2)
          $idx = $list.Count
          [void]$list.Add(@{ el = $el; cx = $cx; cy = $cy })
          [void]$lines.Add('[' + $idx + '] ' + $type + ' "' + $name + '" @' + $cx + ',' + $cy)
        }
        if ($depth -lt 7) {
          $child = $walker.GetFirstChild($el)
          while ($child) { $queue.Enqueue(@($child, $depth + 1)); $child = $walker.GetNextSibling($child) }
        }
      } catch {}
    }
    $script:UiaList = $list
    if ($lines.Count -eq 0) { return @{ ok = $true; detail = 'UIA tree empty (custom-drawn window?)'; output = '' } }
    return @{ ok = $true; detail = ('elements ' + $lines.Count); output = ($lines -join "`n") }
  } catch { return @{ ok = $false; detail = $_.Exception.Message; output = '' } }
}
function Do-UiaClick($idx) {
  if (-not $script:UiaList -or $idx -lt 0 -or $idx -ge $script:UiaList.Count) { return @{ ok = $false; detail = 'no UIA element at that index - run uia first'; output = ''; snap = $false } }
  $item = $script:UiaList[$idx]
  $el = $item.el
  try {
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); return @{ ok = $true; detail = ('invoked element ' + $idx); output = ''; snap = $true } }
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) { $pat.Toggle(); return @{ ok = $true; detail = ('toggled element ' + $idx); output = ''; snap = $true } }
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) { $pat.Select(); return @{ ok = $true; detail = ('selected element ' + $idx); output = ''; snap = $true } }
    $pat = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) { $pat.Expand(); return @{ ok = $true; detail = ('expanded element ' + $idx); output = ''; snap = $true } }
  } catch {}
  [CosmoWin]::SetCursorPos([int]$item.cx, [int]$item.cy) | Out-Null
  Start-Sleep -Milliseconds 120
  [CosmoWin]::mouse_event(0x0002, 0, 0, 0, 0) | Out-Null
  Start-Sleep -Milliseconds 70
  [CosmoWin]::mouse_event(0x0004, 0, 0, 0, 0) | Out-Null
  return @{ ok = $true; detail = ('clicked element ' + $idx + ' at ' + $item.cx + ',' + $item.cy); output = ''; snap = $true }
}

function Invoke-ControlVerb($c) {
  $verb = ''
  if ($c -match '^([a-z]+):') { $verb = $Matches[1] }
  $arg = $c.Substring($verb.Length + 1)
  $snap = $true
  $needSnap = $false
  try {
    if ($verb -eq 'click' -or $verb -eq 'dblclick' -or $verb -eq 'rclick') {
      $xy = $arg.Split(',')
      $kind = 'left'; if ($verb -eq 'dblclick') { $kind = 'double' }; if ($verb -eq 'rclick') { $kind = 'right' }
      $pos = Do-Click $xy[0] $xy[1] $kind
      return @{ ok = $true; detail = $pos; output = ''; snap = $true }
    }
    if ($verb -eq 'wiggle') {
      $pos = Do-Wiggle
      return @{ ok = $true; detail = $pos; output = ''; snap = $true }
    }
    if ($verb -eq 'move') {
      $xy = $arg.Split(',')
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      [CosmoWin]::SetCursorPos((Convert-Coord ([int]$xy[0]) $b.Left $b.Width), (Convert-Coord ([int]$xy[1]) $b.Top $b.Height)) | Out-Null
      return @{ ok = $true; detail = (Get-CursorText); output = ''; snap = $false }
    }
    if ($verb -eq 'guide') {
      Do-GuideStart $arg
      return @{ ok = $true; detail = 'guide shown'; output = ''; snap = $false }
    }
    if ($verb -eq 'guide-done') {
      Do-GuideStop
      return @{ ok = $true; detail = 'guide cleared'; output = ''; snap = $false }
    }
    if ($verb -eq 'banner') {
      $script:Shared.Status = $arg
      return @{ ok = $true; detail = 'banner updated'; output = ''; snap = $false }
    }
    if ($verb -eq 'scroll') { Do-Scroll ([int]$arg); return @{ ok = $true; detail = ''; output = ''; snap = $true } }
    if ($verb -eq 'type') { Do-Type $arg; return @{ ok = $true; detail = ''; output = ''; snap = $true } }
    if ($verb -eq 'key') { Do-Key $arg; return @{ ok = $true; detail = ''; output = ''; snap = $true } }
    if ($verb -eq 'shell') {
      $r = Do-Shell $arg
      return @{ ok = $r.ok; detail = $r.detail; output = $r.output; snap = $true }
    }
    if ($verb -eq 'snapshot') { $needSnap = $true; return @{ ok = $true; detail = ''; output = ''; snap = $true } }
    return @{ ok = $false; detail = ('unknown verb ' + $verb); output = ''; snap = $false }
  } catch {
    Write-Log ('action failed: ' + $_.Exception.Message)
    return @{ ok = $false; detail = $_.Exception.Message; output = ''; snap = $snap }
  }
}

function Send-Status {
  $os = $null
  try { $os = Get-CimInstance Win32_OperatingSystem } catch {}
  Post-Json '/api/pc/status' @{
    name = $Name; user = $env:USERNAME; agent = $Version
    os = $(if ($os) { $os.Caption } else { '' })
    uptimeMin = $(if ($os) { [int]((Get-Date) - $os.LastBootUpTime).TotalMinutes } else { 0 })
    foreground = (Get-ForegroundTitle)
    remoteTools = @(Get-RemoteToolsRunning)
    control = $script:ControlActive
    guide = $script:GuideText
  } | Out-Null
}

$script:LastUpdateCheck = Get-Date
function Test-SelfUpdate {
  try {
    $cur = $PSCommandPath
    if (-not $cur -or $cur -notlike '*CosmoPC*') { return }
    $tmp = Join-Path $env:TEMP 'cosmo-agent-latest.ps1'
    Invoke-WebRequest -Uri ($BoxUrl + '/pc/agent.ps1') -OutFile $tmp -UseBasicParsing -TimeoutSec 20
    if ((Get-FileHash $tmp -Algorithm SHA256).Hash -ne (Get-FileHash $cur -Algorithm SHA256).Hash) {
      Write-Log 'self-update: new version on the box, installing and restarting'
      Copy-Item $tmp $cur -Force
      Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep 3; Stop-ScheduledTask -TaskName CosmoPCAgent -ErrorAction SilentlyContinue; Start-Sleep 2; Start-ScheduledTask -TaskName CosmoPCAgent"'
      exit 0
    }
  } catch { Write-Log ('self-update check failed: ' + $_.Exception.Message) }
}

Start-BannerRunspace
Send-Status
Test-SelfUpdate
$lastStatus = Get-Date
while ($true) {
  try {
    $raw = Invoke-WebRequest -Uri "$BoxUrl/api/pc/command?name=$Name" -UseBasicParsing -TimeoutSec 10
    $cmd = $raw.Content | ConvertFrom-Json
    if ($cmd -and $cmd.command) {
      $c = [string]$cmd.command
      Write-Log ('command executing: ' + $c)
      if ($c -eq 'health') {
        $ok = Post-Json '/api/pc/health' @{ name = $Name; report = (Get-HealthFast) }
        Post-Result 'health' $ok 'fast report'
        Start-WuScan
      }
      elseif ($c -eq 'snapshot') {
        $r = Send-Snapshot
        Post-Result 'snapshot' $r.ok $r.detail
      }
      elseif ($c -eq 'control-start') {
        Start-Control
        Post-Result 'control-start' $true 'session open'
      }
      elseif ($c -eq 'control-stop') {
        Stop-Control 'box'
        Post-Result 'control-stop' $true 'session closed'
      }
      elseif ($c -eq 'uia') {
        $r = Get-UiaTree
        Post-Result $c $r.ok $r.detail $r.output
      }
      elseif ($c -like 'uia-click:*') {
        if (-not $script:ControlActive) {
          Post-Result $c $false 'locked - no control session'
        } else {
          $script:LastControlAt = Get-Date
          $r = Do-UiaClick ([int]$c.Substring(10))
          Post-Result $c $r.ok $r.detail $r.output
          if ($r.snap) { Start-Sleep -Milliseconds 350; Send-Snapshot | Out-Null }
        }
      }
      elseif ($c -like 'open:*') {
        $ok = $true; try { Start-Process $c.Substring(5) } catch { $ok = $false }
        Post-Result $c $ok ''
      }
      elseif ($c -like 'close:*') {
        $ok = $true; try { Get-Process $c.Substring(6) -ErrorAction Stop | Stop-Process -Force } catch { $ok = $false }
        Post-Result $c $ok ''
      }
      elseif ($c -like 'guide-done') {
        Do-GuideStop
        Post-Result $c $true 'guide cleared'
      }
      elseif ($c -like 'guide:*') {
        Do-GuideStart $c.Substring(6)
        Post-Result $c $true 'guide shown'
      }
      elseif ($c -like 'banner:*') {
        if ($script:ControlActive -or $script:GuideText) { $script:Shared.Status = $c.Substring(7); Post-Result $c $true 'banner updated' }
        else { Post-Result $c $false 'no session or guide active' }
      }
      elseif ($c -eq 'wiggle') {
        if (-not $script:ControlActive) {
          Post-Result $c $false 'locked - no control session'
        } else {
          $script:LastControlAt = Get-Date
          $pos = Do-Wiggle
          Post-Result $c $true $pos
          Send-Snapshot | Out-Null
        }
      }
      elseif ($c -match '^(click|dblclick|rclick|move|scroll|type|key|shell):') {
        if (-not $script:ControlActive) {
          Post-Result $c $false 'locked - no control session'
        } else {
          $script:LastControlAt = Get-Date
          $r = Invoke-ControlVerb $c
          Post-Result $c $r.ok $r.detail $r.output
          Start-Sleep -Milliseconds 350
          if ($r.snap) { Send-Snapshot | Out-Null }
        }
      }
      elseif ($c -like 'seq:*') {
        if (-not $script:ControlActive) {
          Post-Result $c $false 'locked - no control session'
        } else {
          $script:LastControlAt = Get-Date
          $steps = @($c.Substring(4).Split('|') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
          $allOk = $true; $outs = ''; $wantSnap = $false
          foreach ($st in $steps) {
            if ($st -match '^wait:(\d+)$') { Start-Sleep -Milliseconds ([int]$Matches[1]); continue }
            $r = Invoke-ControlVerb $st
            if (-not $r.ok) { $allOk = $false }
            if ($r.output) { $outs += ($st + ' => ' + $r.output + "`n") }
            if ($r.snap) { $wantSnap = $true }
            Start-Sleep -Milliseconds 120
          }
          Post-Result $c $allOk ('steps ' + $steps.Length) $outs.Trim()
          if ($wantSnap) { Start-Sleep -Milliseconds 300; Send-Snapshot | Out-Null }
        }
      }
    }
  } catch { Write-Log ('poll failed: ' + $_.Exception.Message) }
  Poll-WuScan
  if ($script:Shared.StopRequest) {
    $script:Shared.StopRequest = $false
    Stop-Control 'banner X pressed'
  }
  if ($script:Shared.GuideStop) {
    $script:Shared.GuideStop = $false
    if ($script:GuideText) { Do-GuideStop }
  }
  if ($script:ControlActive -and ((Get-Date) - $script:LastControlAt).TotalSeconds -gt 600) {
    Stop-Control 'idle timeout 10 min'
  }
  if (((Get-Date) - $lastStatus).TotalSeconds -ge $StatusSeconds) { Send-Status; $lastStatus = Get-Date }
  if (((Get-Date) - $script:LastUpdateCheck).TotalHours -ge 1) { $script:LastUpdateCheck = Get-Date; Test-SelfUpdate }
  if ($script:ControlActive) { Start-Sleep -Seconds 1 } else { Start-Sleep -Seconds $PollSeconds }
}
