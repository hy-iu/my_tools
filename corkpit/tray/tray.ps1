# Cockpit tray host — WinForms NotifyIcon driven by file-based IPC.
# IPC dir (~/.cockpit/tray by default, override via COCKPIT_TRAY_IPC env):
#   node -> tray: cmd.json   {"cmd":"status","active":N,"todayCost":S,"agents":[{"id","active","sessions","last"}]} |
#                                  {"cmd":"balloon","title":T,"text":X,"warn":B} | {"cmd":"quit"}
#   tray -> node: event.json {"event":"open-panel"|"open-agent"|"ingest"|"check-update"|"open-dsh-web"|"exit"[,"agent":A]}
# Writers stage to <name>.tmp then rename (atomic), readers delete after
# consuming. Stdin is deliberately never read: piped-stdin GUI hosts get
# killed by some security tooling ~5s after start (verified empirically).
# Requires STA (started by node with -STA). Zero external dependencies.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Optional lifecycle log: set COCKPIT_TRAY_DEBUG=<file path> to enable.
$DebugLog = $env:COCKPIT_TRAY_DEBUG
function Log([string]$m) { if ($DebugLog) { Add-Content -Path $DebugLog -Value ("{0} {1}" -f (Get-Date -Format 'HH:mm:ss.fff'), $m) } }
Log 'tray.ps1 starting'

$IpcDir = if ($env:COCKPIT_TRAY_IPC) { $env:COCKPIT_TRAY_IPC } else { Join-Path $env:USERPROFILE '.cockpit\tray' }
New-Item -ItemType Directory -Force -Path $IpcDir | Out-Null
$CmdFile = Join-Path $IpcDir 'cmd.json'
$EventFile = Join-Path $IpcDir 'event.json'
Remove-Item $CmdFile, $EventFile -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CockpitIconUtil {
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
}
'@

function New-CockpitIcon([bool]$active) {
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(13, 20, 32))

  # gauge arc (cockpit dial)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(88, 166, 255), 3)
  $g.DrawArc($pen, 5, 5, 22, 22, 200, 140)

  # needle
  $cx = 16.0; $cy = 16.0
  $angle = 60 * [Math]::PI / 180
  $g.DrawLine($pen, $cx, $cy, [single]($cx + 8 * [Math]::Cos($angle)), [single]($cy - 8 * [Math]::Sin($angle)))

  # status dot: green when agents are active, dim grey otherwise
  $dotColor = if ($active) { [System.Drawing.Color]::FromArgb(63, 185, 80) } else { [System.Drawing.Color]::FromArgb(90, 100, 110) }
  $brush = New-Object System.Drawing.SolidBrush($dotColor)
  $g.FillEllipse($brush, 22, 22, 8, 8)

  $pen.Dispose(); $brush.Dispose(); $g.Dispose()
  $hIcon = $bmp.GetHicon()
  $tmp = [System.Drawing.Icon]::FromHandle($hIcon)
  $icon = New-Object System.Drawing.Icon($tmp, $tmp.Width, $tmp.Height)
  [CockpitIconUtil]::DestroyIcon($hIcon) | Out-Null
  $tmp.Dispose(); $bmp.Dispose()
  return $icon
}

function Send-Event([string]$name, [string]$extraJson = '') {
  $tmp = $EventFile + '.tmp'
  Set-Content -Path $tmp -Value ('{"event":"' + $name + '"' + $extraJson + '}') -Encoding UTF8
  Move-Item -Force $tmp $EventFile
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = New-CockpitIcon $false
$tray.Text = 'Cockpit — starting…'
$tray.Visible = $true
Log 'notifyicon visible'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
# dynamic per-agent status items are inserted at the top on each status
# update; $agentItems tracks them so they can be rebuilt in place.
$script:agentItems = @()
[void]$menu.Items.Add('-')
$miOpen   = $menu.Items.Add('Open Cockpit panel')
$miIngest = $menu.Items.Add('Re-ingest all sources')
$miUpdate = $menu.Items.Add('Check dsh updates')
$miDsh    = $menu.Items.Add('Open dsh web (3080)')
[void]$menu.Items.Add('-')
$miExit   = $menu.Items.Add('Exit tray')
$tray.ContextMenuStrip = $menu

# Anchor window: some security tooling kills GUI hosts whose only top-level
# window looks stealthy (near-transparent or positioned on-screen). An opaque
# 1x1 form placed OFF-SCREEN is invisible AND survives that heuristic. It must
# also OWN the message loop (Application.Run on the form).
$anchor = New-Object System.Windows.Forms.Form
$anchor.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$anchor.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
# Opaque window placed OFF-SCREEN: invisible, and (unlike near-transparent
# or on-screen windows) survives the security tooling that kills stealthy
# GUI hosts. It must also OWN the message loop (Application.Run on the form).
$anchor.Bounds = New-Object System.Drawing.Rectangle(-32000, -32000, 1, 1)
$anchor.ShowInTaskbar = $false
Log 'anchor form ready'

$miOpen.Add_Click({ Send-Event 'open-panel' })
$miIngest.Add_Click({ Send-Event 'ingest' })
$miUpdate.Add_Click({ Send-Event 'check-update' })
$miDsh.Add_Click({ Send-Event 'open-dsh-web' })
$miExit.Add_Click({ Send-Event 'exit'; $tray.Visible = $false; $anchor.Close() })
$tray.Add_DoubleClick({ Send-Event 'open-panel' })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
  if (Test-Path $CmdFile) {
    Log ('tick: cmd found')
    $msg = $null
    $raw = $null
    try {
      $raw = Get-Content -Raw $CmdFile -Encoding UTF8
      Remove-Item $CmdFile -ErrorAction SilentlyContinue
      $msg = $raw | ConvertFrom-Json
    } catch { Log ('bad cmd: ' + $_.Exception.Message) }
    if ($msg) {
      switch ($msg.cmd) {
        'ping' { }  # keepalive, ignore
        'status' {
          $tray.Text = ('Cockpit · {0} active · today {1}' -f $msg.active, $msg.todayCost)
          $old = $tray.Icon
          $tray.Icon = New-CockpitIcon ([int]$msg.active -gt 0)
          if ($old) { $old.Dispose() }
          # rebuild the per-agent quick-open items at the top of the menu
          foreach ($it in $script:agentItems) { $menu.Items.Remove($it) | Out-Null; $it.Dispose() }
          $script:agentItems = @()
          $agents = @($msg.agents)
          for ($i = $agents.Count - 1; $i -ge 0; $i--) {
            $a = $agents[$i]
            $aid = [string]$a.id
            $mark = if ([int]$a.active -gt 0) { [char]0x25CF } else { [char]0x25CB }
            $label = ('{0} {1}  ·  {2} sessions · last {3}' -f $mark, $aid, $a.sessions, $a.last)
            # Items.Insert requires a ToolStripItem, not a raw string.
            $it = New-Object System.Windows.Forms.ToolStripMenuItem($label)
            [void]$menu.Items.Insert(0, $it)
            $it.Add_Click(([scriptblock]::Create("Send-Event 'open-agent' ',`"agent`":`"$aid`"'").GetNewClosure()))
            $script:agentItems = @($it) + $script:agentItems
          }
          Log ('rebuilt ' + $script:agentItems.Count + ' agent menu items')
        }
        'balloon' {
          $kind = if ($msg.warn) { [System.Windows.Forms.ToolTipIcon]::Warning } else { [System.Windows.Forms.ToolTipIcon]::Info }
          $tray.ShowBalloonTip(6000, $msg.title, $msg.text, $kind)
        }
        'quit' {
          $tray.Visible = $false
          $anchor.Close()
        }
      }
    }
  }
})
$timer.Start()

Log 'entering Application.Run'
try {
  [void][System.Windows.Forms.Application]::Run($anchor)
  Log 'Application.Run returned normally'
} catch {
  Log ('Application.Run EXCEPTION: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message)
}
$timer.Dispose()
$anchor.Dispose()
$tray.Dispose()
