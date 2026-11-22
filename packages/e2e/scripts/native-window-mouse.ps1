param(
  [Parameter(Mandatory)][long]$Handle,
  [Parameter(Mandatory)][uint32]$ProcessId,
  [Parameter(Mandatory)][ValidateSet('Click', 'DoubleClick', 'Drag')][string]$Action,
  [Parameter(Mandatory)][int]$X,
  [Parameter(Mandatory)][int]$Y,
  [int]$EndX,
  [int]$EndY
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Native input is restricted to GitHub-hosted Windows sessions'
}
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
public static class NativeMouse {
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {
    public int dx, dy;
    public uint mouseData, flags, time;
    public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] struct Input {
    public uint type;
    public MouseInput mouse;
  }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  static void Guard(IntPtr window, uint expectedPid) {
    uint pid;
    var foreground = GetForegroundWindow();
    GetWindowThreadProcessId(foreground, out pid);
    if (foreground != window || pid != expectedPid)
      throw new InvalidOperationException("Owned Electron window is not foreground; refusing input");
  }
  static void Move(IntPtr window, uint pid, int x, int y) {
    Guard(window, pid);
    if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static void Button(uint flags) {
    var input = new Input { mouse = new MouseInput { flags = flags } };
    if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1)
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Run(long handle, uint pid, string action, int x, int y, int endX, int endY) {
    var window = new IntPtr(handle);
    Move(window, pid, x, y);
    Guard(window, pid);
    Button(2);
    try {
      if (action == "Drag") {
        Rect before, activated;
        if (!GetWindowRect(window, out before)) throw new Win32Exception(Marshal.GetLastWin32Error());
        Move(window, pid, x + 12, y + 12);
        Thread.Sleep(100);
        Move(window, pid, x + 24, y + 24);
        Thread.Sleep(100);
        if (!GetWindowRect(window, out activated)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (activated.left == before.left || activated.top == before.top)
          throw new InvalidOperationException("Native drag did not activate in both axes");
        // Windows consumes initial motion when activating its native move loop.
        // Measure that grab offset so EndX/EndY request window displacement, not cursor displacement.
        int offsetX = 24 - (activated.left - before.left);
        int offsetY = 24 - (activated.top - before.top);
        Console.WriteLine("Native drag activation offset: " + offsetX + "," + offsetY);
        for (int step = 1; step <= 20; step++) {
          Move(window, pid, x + 24 + (endX + offsetX - x - 24) * step / 20,
            y + 24 + (endY + offsetY - y - 24) * step / 20);
          Thread.Sleep(20);
        }
      } else Thread.Sleep(60);
      Guard(window, pid);
    } finally {
      // Balance our press even after foreground loss; no new movement or press on failure.
      Button(4);
    }
    if (action == "DoubleClick") {
      Thread.Sleep(80);
      Guard(window, pid);
      Button(2);
      try { Thread.Sleep(60); }
      finally { Button(4); }
    }
  }
}
'@
[NativeMouse]::Run($Handle, $ProcessId, $Action, $X, $Y, $EndX, $EndY)
