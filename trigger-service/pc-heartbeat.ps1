# 每分钟向判断服务报一次"电脑有没有人在用"。后台常开即可（可放进任务计划程序，登录时启动）。
$Url   = "https://你的zeabur域名"
$Token = "你的TOKEN"
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Idle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  public static uint Seconds() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return ((uint)Environment.TickCount - i.dwTime) / 1000; }
}
"@
while ($true) {
  try { Invoke-RestMethod -Method Post -Uri "$Url/event/pc?idle=$([Idle]::Seconds())" -Headers @{ "X-Token" = $Token } | Out-Null } catch {}
  Start-Sleep 60
}
