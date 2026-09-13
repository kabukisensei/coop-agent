#!/usr/bin/env python3
import ctypes
import json
import sys
from ctypes import wintypes

TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
MAX_PATH = 260

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
print(json.dumps({"rootPid": root, "rootPresent": any(entry["pid"] == root for entry in entries), "processes": result}, separators=(",", ":")))
