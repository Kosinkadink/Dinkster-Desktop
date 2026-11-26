param(
  [Parameter(Mandatory)][long]$Handle,
  [Parameter(Mandatory)][uint32]$ProcessId,
  [ValidateSet('Guard', 'Focus', 'RightClick', 'Key')][string]$Action = 'Guard',
  [int]$Index = -1,
  [int]$X = -1,
  [int]$Y = -1
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnedTextMenu {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Mouse mouse; }
  [StructLayout(LayoutKind.Explicit,Size=40)] struct KeyInput {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public ushort key;
    [FieldOffset(12)] public uint flags;
  }
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref Point point);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, Input[] inputs, int size);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, KeyInput[] inputs, int size);
  static void Guard(IntPtr owner, uint pid) {
    uint actual;
    GetWindowThreadProcessId(owner, out actual);
    if (actual != pid || GetForegroundWindow() != owner)
      throw new InvalidOperationException("Exact owned Desktop window is not foreground; refusing native input");
  }
  public static object Run(long handle, uint pid, string action, int index, int x, int y) {
    var owner = new IntPtr(handle);
    if (action == "Focus") {
      uint actual; GetWindowThreadProcessId(owner, out actual);
      if (actual != pid) throw new InvalidOperationException("Window does not belong to expected Desktop process");
      SetWindowPos(owner,new IntPtr(-1),0,0,0,0,0x43);
      SetForegroundWindow(owner);
      Guard(owner,pid);
      return new object[0];
    }
    Guard(owner, pid);
    if (action == "Key") {
      if (index != 27 && index != 40 && index != 13) throw new InvalidOperationException("Only Escape, Down and Return menu keys are supported");
      var down = new KeyInput { type=1,key=(ushort)index };
      var up = new KeyInput { type=1,key=(ushort)index,flags=2 };
      if (SendInput(2,new[]{down,up},40)!=2) throw new InvalidOperationException("Native menu key failed");
      return new object[0];
    }
    if (action == "RightClick") {
      Rect client; GetClientRect(owner,out client);
      if (x < 0 || y < 0 || x >= client.right || y >= client.bottom) throw new InvalidOperationException("Point outside owned Desktop client");
      var point = new Point { x=x,y=y }; ClientToScreen(owner,ref point);
      if (GetAncestor(WindowFromPoint(point),2) != owner) throw new InvalidOperationException("Point does not hit owned Desktop window");
      var move = new Input { mouse = new Mouse {
        x=(int)Math.Round((point.x-GetSystemMetrics(76))*65535.0/(GetSystemMetrics(78)-1)),
        y=(int)Math.Round((point.y-GetSystemMetrics(77))*65535.0/(GetSystemMetrics(79)-1)),flags=0xc001 } };
      if (SendInput(1,new[]{move},Marshal.SizeOf(typeof(Input)))!=1) throw new InvalidOperationException("Native move failed");
      Guard(owner,pid);
      var down = new Input { mouse = new Mouse { flags=8 } };
      var up = new Input { mouse = new Mouse { flags=16 } };
      if (SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(Input)))!=2) throw new InvalidOperationException("Native right-click failed");
      return new object[0];
    }
    return new object[0];
  }
}
'@
$items = [OwnedTextMenu]::Run($Handle, $ProcessId, $Action, $Index, $X, $Y)
ConvertTo-Json -InputObject @($items) -Depth 5 -Compress
