using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// The PowerShell supervisor owns this handle; closing it also kills orphaned
// WebView/driver descendants if Node crashes, hangs, or the run is interrupted.
public sealed class DesktopTestJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr information, uint size, IntPtr returnedLength);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);
    private IntPtr handle;
    public DesktopTestJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(limits)))
        {
            var error = new Win32Exception();
            Dispose();
            throw error;
        }
    }
    public void Assign(IntPtr process)
    {
        if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception();
    }
    public static bool HasInteractiveDesktop()
    {
        if (!Environment.UserInteractive) return false;
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return false;
        CloseDesktop(desktop);
        return true;
    }
    public int[] ProcessIds()
    {
        var buffer = Marshal.AllocHGlobal(65536);
        try {
            if (!QueryInformationJobObject(handle, 3, buffer, 65536, IntPtr.Zero)) throw new Win32Exception();
            int count = Marshal.ReadInt32(buffer, 4);
            var ids = new int[count];
            for (int i = 0; i < count; i++) ids[i] = Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt32();
            return ids;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    public void Dispose()
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
}
