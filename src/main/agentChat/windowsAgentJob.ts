import { win32 } from 'node:path'

// Fixed supervisor source is bundled, never loaded from cwd. Variable launch data travels in a
// bounded binary stdin frame consumed with exact native reads before the CLI inherits that pipe.
const JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class OwnedAgentJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedBytes, Stdin, Stdout, Stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public StartupInfo Info;
    public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
    IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string file, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs,
    bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,
    IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file,
    IntPtr buffer, uint count, out uint read, IntPtr overlapped);

  static byte[] ReadExact(int length) {
    byte[] bytes = new byte[length];
    GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      int offset = 0;
      while (offset < length) {
        uint read;
        bool ok = ReadFile(GetStdHandle(-10), IntPtr.Add(pinned.AddrOfPinnedObject(), offset),
          (uint)(length - offset), out read, IntPtr.Zero);
        if (!ok || read == 0) throw new Exception("Truncated Windows agent launch frame");
        offset += (int)read;
      }
      return bytes;
    } finally { pinned.Free(); }
  }
  static void ReadLaunch(out string file, out string command) {
    byte[] header = ReadExact(12);
    uint fileBytes = BitConverter.ToUInt32(header, 4);
    uint commandBytes = BitConverter.ToUInt32(header, 8);
    // UTF-8 needs at most three bytes per UTF-16 code unit; CreateProcess permits 32766 + NUL.
    const uint MaxBytes = 32766 * 3;
    if (header[0] != 68 || header[1] != 77 || header[2] != 74 || header[3] != 49 ||
        fileBytes == 0 || commandBytes == 0 || fileBytes > MaxBytes || commandBytes > MaxBytes)
      throw new Exception("Invalid Windows agent launch frame header");
    var utf8 = new UTF8Encoding(false, true);
    file = utf8.GetString(ReadExact((int)fileBytes));
    command = utf8.GetString(ReadExact((int)commandBytes));
    if (file.Length > 32766 || command.Length > 32766 || file.IndexOf('\0') >= 0 || command.IndexOf('\0') >= 0)
      throw new Exception("Invalid Windows agent launch frame payload");
  }

  static void Check(bool success) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static IntPtr Pipe(int id) {
    IntPtr copy;
    Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(id), GetCurrentProcess(), out copy, 0, true, 2));
    return copy;
  }
  static void DrainJob(IntPtr job) {
    Check(TerminateJobObject(job, 1));
    for (int i = 0; i < 1000; i++) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      if (info.ActiveProcesses == 0) return;
      Thread.Sleep(1);
    }
    throw new Exception("Windows agent job did not empty after termination");
  }
  public static int Run() {
    IntPtr job = IntPtr.Zero;
    ProcessInfo child = new ProcessInfo();
    StartupInfoEx startup = new StartupInfoEx();
    IntPtr jobList = IntPtr.Zero;
    bool attributesReady = false;
    try {
      string file, command;
      ReadLaunch(out file, out command);
      // Null security attributes make the job handle non-inheritable. No breakaway flag is enabled.
      job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero);
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      // Atomic job assignment also covers supervisor death between CreateProcess and ResumeThread.
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      startup.Attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(startup.Attributes, 1, 0, ref size));
      attributesReady = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(startup.Attributes, 0, new IntPtr(0x2000D),
        jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)); // PROC_THREAD_ATTRIBUTE_JOB_LIST
      startup.Info.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
      startup.Info.Flags = 0x100; // Direct binary pipes, not PowerShell text redirection.
      startup.Info.Stdin = Pipe(-10);
      startup.Info.Stdout = Pipe(-11);
      startup.Info.Stderr = Pipe(-12);
      Check(CreateProcess(file, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
        0x08080004, IntPtr.Zero, null, ref startup, out child)); // NO_WINDOW | EXTENDED_STARTUPINFO | SUSPENDED
      Check(ResumeThread(child.Thread) != UInt32.MaxValue);
      Check(WaitForSingleObject(child.Process, UInt32.MaxValue) == 0);
      uint code;
      Check(GetExitCodeProcess(child.Process, out code));
      DrainJob(job); // A naturally exited CLI may have left background descendants behind.
      return unchecked((int)code);
    } catch (Exception error) {
      var native = error as Win32Exception;
      string kind = native != null && native.NativeErrorCode == 2 ? "ENOENT: " : "";
      Console.Error.WriteLine("Windows agent job failed: " + kind + error.Message);
      return 1;
    } finally {
      if (child.Process != IntPtr.Zero) {
        // Every successfully created child already belongs to the job, including before resume.
        TerminateJobObject(job, 1);
        WaitForSingleObject(child.Process, 1000);
      }
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      if (startup.Info.Stdin != IntPtr.Zero) CloseHandle(startup.Info.Stdin);
      if (startup.Info.Stdout != IntPtr.Zero) CloseHandle(startup.Info.Stdout);
      if (startup.Info.Stderr != IntPtr.Zero) CloseHandle(startup.Info.Stderr);
      if (attributesReady) DeleteProcThreadAttributeList(startup.Attributes);
      if (startup.Attributes != IntPtr.Zero) Marshal.FreeHGlobal(startup.Attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
`

function quoteArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&')}"`
}

// PowerShell's module-loading UI progress otherwise contaminates stderr with CLIXML.
const SUPERVISOR_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
${JOB_SOURCE}
'@
[Environment]::Exit([OwnedAgentJob]::Run())
} catch { [Console]::Error.WriteLine('Windows agent job setup failed: ' + $_.Exception.Message); exit 1 }
`
const ENCODED_SUPERVISOR = Buffer.from(SUPERVISOR_SCRIPT, 'utf16le').toString('base64')

/** Owns the CLI and all future descendants before any CLI code can run. Env/cwd stay on spawn. */
export function windowsAgentJob(file: string, args: string[]): { file: string; args: string[]; stdin: Buffer } {
  const command = [file, ...args].map(quoteArgument).join(' ')
  if (!file || file.length > 32766 || command.length > 32766 || file.includes('\0') || command.includes('\0')) {
    throw new Error('Windows agent executable/command exceeds the CreateProcess limit or contains NUL')
  }
  const fileBytes = Buffer.from(file, 'utf8')
  const commandBytes = Buffer.from(command, 'utf8')
  const header = Buffer.alloc(12)
  header.write('DMJ1')
  header.writeUInt32LE(fileBytes.length, 4)
  header.writeUInt32LE(commandBytes.length, 8)
  return {
    file: win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', ENCODED_SUPERVISOR],
    stdin: Buffer.concat([header, fileBytes, commandBytes])
  }
}
