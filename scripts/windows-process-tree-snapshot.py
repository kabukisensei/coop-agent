#!/usr/bin/env python3
import ctypes
import json
import sys
from ctypes import wintypes

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
MAX_PATH = 260

class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]

class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * MAX_PATH),
    ]

root = int(sys.argv[1])
win_dll = getattr(ctypes, "WinDLL", None)
get_last_error = getattr(ctypes, "get_last_error", lambda: 0)
if win_dll is None:
    raise RuntimeError("Windows process snapshots require Windows.")
kernel32 = win_dll("kernel32", use_last_error=True)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME)]
kernel32.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(IO_COUNTERS)]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

def filetime_value(value):
    return (int(value.dwHighDateTime) << 32) | int(value.dwLowDateTime)

def process_metrics(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return {"error": int(get_last_error())}
    try:
        creation, exit_time, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        counters = IO_COUNTERS()
        if not kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel), ctypes.byref(user)):
            return {"error": int(get_last_error())}
        if not kernel32.GetProcessIoCounters(handle, ctypes.byref(counters)):
            return {"error": int(get_last_error()), "creationTime100ns": filetime_value(creation)}
        return {
            "creationTime100ns": filetime_value(creation),
            "kernelTime100ns": filetime_value(kernel),
            "userTime100ns": filetime_value(user),
            "readOperations": int(counters.ReadOperationCount),
            "writeOperations": int(counters.WriteOperationCount),
            "otherOperations": int(counters.OtherOperationCount),
            "readBytes": int(counters.ReadTransferCount),
            "writeBytes": int(counters.WriteTransferCount),
            "otherBytes": int(counters.OtherTransferCount),
        }
    finally:
        kernel32.CloseHandle(handle)

snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
if snapshot == INVALID_HANDLE_VALUE:
    raise OSError(get_last_error(), "CreateToolhelp32Snapshot failed")
entries = []
try:
    item = PROCESSENTRY32W()
    item.dwSize = ctypes.sizeof(item)
    more = kernel32.Process32FirstW(snapshot, ctypes.byref(item))
    while more:
        entries.append({"pid": int(item.th32ProcessID), "ppid": int(item.th32ParentProcessID), "name": item.szExeFile})
        more = kernel32.Process32NextW(snapshot, ctypes.byref(item))
finally:
    kernel32.CloseHandle(snapshot)

owned = {root}
changed = True
while changed:
    changed = False
    for entry in entries:
        if entry["ppid"] in owned and entry["pid"] not in owned:
            owned.add(entry["pid"])
            changed = True
result = [entry for entry in entries if entry["pid"] in owned]
for entry in result:
    entry["metrics"] = process_metrics(entry["pid"])
print(json.dumps({"rootPid": root, "rootPresent": any(entry["pid"] == root for entry in entries), "processes": result}, separators=(",", ":")))
