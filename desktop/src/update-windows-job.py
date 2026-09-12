"""Run an update health probe in a Windows job that dies with this supervisor.

The child starts suspended and joins the job before any candidate code runs.
Killing the supervisor, or a child that leaves descendants behind, closes the
job's only handle and terminates every process still in the job.
"""
import ctypes
from ctypes import wintypes as w
import os
import subprocess
import sys
import time


def run(argv):
    if sys.platform != "win32" or not argv or not os.path.isabs(argv[0]):
        raise ValueError("Windows job requires an absolute executable")
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    size_t = ctypes.c_size_t

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                     "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", w.DWORD),
                    ("MinimumWorkingSetSize", size_t), ("MaximumWorkingSetSize", size_t),
                    ("ActiveProcessLimit", w.DWORD), ("Affinity", size_t),
                    ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMIT), ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", size_t), ("JobMemoryLimit", size_t),
                    ("PeakProcessMemoryUsed", size_t), ("PeakJobMemoryUsed", size_t)]

    class STARTUPINFO(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR),
                    ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                    ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD),
                    ("dwYSize", w.DWORD), ("dwXCountChars", w.DWORD),
                    ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                    ("dwFlags", w.DWORD), ("wShowWindow", w.WORD),
                    ("cbReserved2", w.WORD), ("lpReserved2", ctypes.c_void_p),
                    ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]

    class ACCOUNTING(ctypes.Structure):
        _fields_ = [("TotalUserTime", ctypes.c_longlong), ("TotalKernelTime", ctypes.c_longlong),
                    ("ThisPeriodTotalUserTime", ctypes.c_longlong), ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                    ("TotalPageFaultCount", w.DWORD), ("TotalProcesses", w.DWORD),
                    ("ActiveProcesses", w.DWORD), ("TotalTerminatedProcesses", w.DWORD)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                    ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]

    k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
    k.CreateJobObjectW.restype = w.HANDLE
    k.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
    k.SetInformationJobObject.restype = w.BOOL
    k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
    k.TerminateJobObject.restype = w.BOOL
    k.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
    k.QueryInformationJobObject.restype = w.BOOL
    k.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                               w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR,
                               ctypes.POINTER(STARTUPINFO), ctypes.POINTER(PROCESS_INFORMATION)]
    k.CreateProcessW.restype = w.BOOL
    k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
    k.AssignProcessToJobObject.restype = w.BOOL
    k.ResumeThread.argtypes = [w.HANDLE]
    k.ResumeThread.restype = w.DWORD
    k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
    k.WaitForSingleObject.restype = w.DWORD
    k.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]
    k.GetExitCodeProcess.restype = w.BOOL
    k.TerminateProcess.argtypes = [w.HANDLE, w.UINT]
    k.CloseHandle.argtypes = [w.HANDLE]
    k.GetStdHandle.argtypes = [w.DWORD]
    k.GetStdHandle.restype = w.HANDLE
    k.SetHandleInformation.argtypes = [w.HANDLE, w.DWORD, w.DWORD]
    k.SetHandleInformation.restype = w.BOOL

    def check(value):
        if not value:
            raise ctypes.WinError(ctypes.get_last_error())
        return value

    job = check(k.CreateJobObjectW(None, None))
    info = PROCESS_INFORMATION()
    started = False
    try:
        limit = EXTENDED_LIMIT()
        limit.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        check(k.SetInformationJobObject(job, 9, ctypes.byref(limit), ctypes.sizeof(limit)))
        startup = STARTUPINFO()
        startup.cb = ctypes.sizeof(startup)
        startup.dwFlags = 0x100  # STARTF_USESTDHANDLES
        for name, number in (("hStdInput", -10), ("hStdOutput", -11), ("hStdError", -12)):
            handle = k.GetStdHandle(number & 0xFFFFFFFF)
            check(k.SetHandleInformation(handle, 1, 1))
            setattr(startup, name, handle)
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
        check(k.CreateProcessW(argv[0], command, None, None, True,
                               0x4 | 0x08000000, None, None, ctypes.byref(startup), ctypes.byref(info)))
        check(k.AssignProcessToJobObject(job, info.hProcess))
        if k.ResumeThread(info.hThread) == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
        started = True
        if k.WaitForSingleObject(info.hProcess, 0xFFFFFFFF) != 0:
            raise ctypes.WinError(ctypes.get_last_error())
        result = w.DWORD()
        check(k.GetExitCodeProcess(info.hProcess, ctypes.byref(result)))
        check(k.TerminateJobObject(job, 1))
        deadline = time.monotonic() + 5
        while True:
            accounting = ACCOUNTING()
            check(k.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None))
            if accounting.ActiveProcesses == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Windows probe descendants did not stop")
            time.sleep(0.025)
        return result.value
    finally:
        if info.hProcess and not started:
            k.TerminateProcess(info.hProcess, 1)
        # This also reaps descendants after a candidate crashes or exits early.
        k.CloseHandle(job)
        if info.hThread:
            k.CloseHandle(info.hThread)
        if info.hProcess:
            k.CloseHandle(info.hProcess)


if __name__ == "__main__":
    try:
        sys.exit(run(sys.argv[1:]))
    except Exception as error:
        print(f"Windows health job failed: {error}", file=sys.stderr)
        sys.exit(1)
