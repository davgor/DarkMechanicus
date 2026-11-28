# DM-1042 spike: the physical-ESC hook helper. A PowerShell `Add-Type` C# class installs a WH_KEYBOARD_LL hook on its
# own thread (no native compile, no npm package) and pumps that thread's message loop. It prints one JSON line per
# event on stdout and never logs any key but Escape and its own tagged probe keys, so the person's typing never reaches
# a log.
#
# Lines (all times: qpcNs = QueryPerformanceCounter in ns, the same clock as Node's process.hrtime.bigint()):
#   {"type":"ready",...}                       hook installed (hook = false means SetWindowsHookEx failed)
#   {"type":"key","vk":27,"down":true,"injected":false,...}  every Escape, whatever its source, and every own-tagged key
#   {"type":"hb","n":..}                       WM_TIMER on the hook thread: the thread that runs the hook is pumping
#   {"type":"sent","kind":..}                  this helper injected a tagged key (ping or self-test Escape)
#
# Own-tagged keys carry dwExtraInfo = 0x444D << 48 | kind << 32 | helper pid; kind 1 = liveness ping (VK 0xE8,
# unassigned), 2 = self-test Escape, 3 = agent stand-in key from inject.ps1. The hook swallows its own tagged keys, so
# a ping or a self-test Escape never reaches the person's foreground window; every other key goes to CallNextHookEx.
# The pings prove the hook itself is still installed: Windows removes a low-level hook silently when its callback
# overruns LowLevelHooksTimeout, and only a key that still arrives shows it is alive.
#
# stdin commands, one per line: esc (send a tagged injected Escape), mute (stop heartbeats and ping reports, to prove
# the parent's fail-closed path), quit. stdin EOF or the -ParentPid process ending exits the helper.
param([int]$ParentPid = 0, [int]$HeartbeatMs = 250, [int]$PingMs = 1000)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class EscHook1042 {
  delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc fn, IntPtr hMod, uint threadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hWnd, UIntPtr id, uint ms, IntPtr fn);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

  const int WH_KEYBOARD_LL = 13;
  const uint LLKHF_INJECTED = 0x10, LLKHF_LOWER_IL_INJECTED = 0x02, WM_TIMER = 0x0113, KEYEVENTF_KEYUP = 0x2;
  const long MAGIC = 0x444D;
  static readonly LowLevelKeyboardProc Proc = Callback;
  static readonly BlockingCollection<string> Queue = new BlockingCollection<string>();
  static IntPtr hook = IntPtr.Zero;
  static uint self;
  static volatile bool muted;
  static long hb, pings;

  public static long NowNs() { return (long)(Stopwatch.GetTimestamp() * (1e9 / Stopwatch.Frequency)); }
  static void Emit(string json) { Queue.Add(json); }
  static string B(bool v) { return v ? "true" : "false"; }

  static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
    long at = NowNs();
    int tick = Environment.TickCount;
    if (nCode >= 0) {
      KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      long extra = k.dwExtraInfo.ToInt64();
      bool own = ((extra >> 48) & 0xFFFF) == MAGIC && (uint)(extra & 0xFFFFFFFF) == self;
      int kind = own ? (int)((extra >> 32) & 0xFFFF) : 0;
      int msg = wParam.ToInt32();
      bool down = msg == 0x0100 || msg == 0x0104;
      if (k.vkCode == 0x1B || own) {
        if (!(muted && kind == 1)) {
          Emit("{\"type\":\"key\",\"vk\":" + k.vkCode + ",\"down\":" + B(down) + ",\"injected\":" + B((k.flags & LLKHF_INJECTED) != 0)
            + ",\"lowerIl\":" + B((k.flags & LLKHF_LOWER_IL_INJECTED) != 0) + ",\"own\":" + B(own) + ",\"kind\":" + kind
            + ",\"eventTime\":" + k.time + ",\"tick\":" + (uint)tick + ",\"lagMs\":" + unchecked((uint)tick - k.time) + ",\"qpcNs\":" + at + "}");
        }
        if (own) return (IntPtr)1;
      }
    }
    return CallNextHookEx(hook, nCode, wParam, lParam);
  }

  public static long Send(int kind, ushort vk) {
    IntPtr extra = (IntPtr)((MAGIC << 48) | ((long)kind << 32) | self);
    INPUT[] inputs = new INPUT[2];
    inputs[0].type = 1; inputs[0].u.ki.wVk = vk; inputs[0].u.ki.dwExtraInfo = extra;
    inputs[1].type = 1; inputs[1].u.ki.wVk = vk; inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP; inputs[1].u.ki.dwExtraInfo = extra;
    long at = NowNs();
    uint sent = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (!(muted && kind == 1)) Emit("{\"type\":\"sent\",\"kind\":" + kind + ",\"vk\":" + vk + ",\"count\":" + sent + ",\"qpcNs\":" + at + "}");
    return at;
  }

  public static void Run(int parentPid, uint heartbeatMs, int pingMs) {
    self = (uint)Process.GetCurrentProcess().Id;
    Thread writer = new Thread(() => { foreach (string line in Queue.GetConsumingEnumerable()) { Console.Out.Write(line + "\n"); Console.Out.Flush(); } });
    writer.IsBackground = true; writer.Start();
    Thread stdin = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        line = line.Trim();
        if (line == "esc") Send(2, 0x1B);
        else if (line == "mute") { muted = true; Emit("{\"type\":\"muted\",\"qpcNs\":" + NowNs() + "}"); }
        else if (line == "quit") break;
      }
      Quit("stdin-closed");
    });
    stdin.IsBackground = true; stdin.Start();
    if (parentPid > 0) {
      Thread watch = new Thread(() => {
        try { Process.GetProcessById(parentPid).WaitForExit(); } catch (ArgumentException) { }
        Quit("parent-exited");
      });
      watch.IsBackground = true; watch.Start();
    }
    hook = SetWindowsHookEx(WH_KEYBOARD_LL, Proc, GetModuleHandle("user32.dll"), 0);
    int error = Marshal.GetLastWin32Error();
    Emit("{\"type\":\"ready\",\"pid\":" + self + ",\"hook\":" + B(hook != IntPtr.Zero) + ",\"error\":" + error + ",\"session\":" + Process.GetCurrentProcess().SessionId
      + ",\"qpcHz\":" + Stopwatch.Frequency + ",\"qpcNs\":" + NowNs() + "}");
    if (hook == IntPtr.Zero) { Quit("hook-failed"); return; }
    Thread pinger = new Thread(() => { while (true) { Thread.Sleep(pingMs); pings++; Send(1, 0xE8); } });
    pinger.IsBackground = true; pinger.Start();
    SetTimer(IntPtr.Zero, UIntPtr.Zero, heartbeatMs, IntPtr.Zero);
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
      if (m.message == WM_TIMER && !muted) Emit("{\"type\":\"hb\",\"n\":" + (++hb) + ",\"qpcNs\":" + NowNs() + "}");
    }
  }

  static void Quit(string why) {
    if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
    try { Console.Out.Write("{\"type\":\"exit\",\"why\":\"" + why + "\",\"qpcNs\":" + NowNs() + "}\n"); Console.Out.Flush(); } catch (Exception) { }
    Environment.Exit(0);
  }
}
'@
[EscHook1042]::Run($ParentPid, [uint32]$HeartbeatMs, $PingMs)
