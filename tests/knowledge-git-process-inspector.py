#!/usr/bin/env python3
"""Exit nonzero when an exact knowledge-git Python script process is alive."""

import os
import re
import ctypes
import struct
import subprocess
import sys

PYTHON_NAME = re.compile(r"^python(?:[0-9]+(?:\.[0-9]+)*)?(?:\.exe)?$", re.IGNORECASE)
PYTHON_OPTIONS_WITH_VALUE = frozenset(("-W", "-X"))


def direct_python_script(argv):
    if not argv or not PYTHON_NAME.match(os.path.basename(argv[0])):
        return None
    index = 1
    while index < len(argv):
        value = argv[index]
        if value == "--":
            index += 1
            break
        if not value.startswith("-") or value == "-":
            break
        if value in ("-c", "-m") or value.startswith("-c") or value.startswith("-m"):
            return None
        if value in PYTHON_OPTIONS_WITH_VALUE:
            index += 2
        else:
            index += 1
    return argv[index] if index < len(argv) else None


def proc_argv(pid):
    try:
        raw = open("/proc/%d/cmdline" % pid, "rb").read()
    except (OSError, ValueError):
        return None
    return [part.decode("utf-8", "surrogateescape") for part in raw.rstrip(b"\0").split(b"\0")]


def linux_matches(target):
    own_pid = os.getpid()
    matches = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == own_pid:
            continue
        argv = proc_argv(int(name))
        script = direct_python_script(argv or [])
        if script:
            try:
                if os.path.realpath(script) == target:
                    matches.append(int(name))
            except OSError:
                pass
    return matches


def macos_process_argv(pid):
    """Read an exact macOS argv vector through KERN_PROCARGS2."""
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    sysctl = libc.sysctl
    sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p, ctypes.c_size_t,
    ]
    argmax = ctypes.c_int()
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    argmax_mib = (ctypes.c_int * 2)(1, 8)  # CTL_KERN, KERN_ARGMAX
    if sysctl(argmax_mib, 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0:
        return None
    buffer = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(argmax.value)
    args_mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    if sysctl(args_mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        return None
    data = buffer.raw[:size.value]
    if len(data) < 4:
        return None
    argc = struct.unpack_from("i", data)[0]
    position = 4
    executable_end = data.find(b"\0", position)
    if argc <= 0 or executable_end < 0:
        return None
    position = executable_end
    while position < len(data) and data[position] == 0:
        position += 1
    argv = []
    for _index in range(argc):
        end = data.find(b"\0", position)
        if end < 0:
            return None
        argv.append(data[position:end].decode("utf-8", "surrogateescape"))
        position = end + 1
    return argv


def macos_matches(target):
    """Use bounded ps enumeration, then kernel argv for exact boundaries."""
    result = subprocess.run(
        ["ps", "-ww", "-axo", "pid=,comm="],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=5,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("ps process inspection failed")
    matches = []
    own_pid = os.getpid()
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or not fields[0].isdigit() or int(fields[0]) == own_pid:
            continue
        if not PYTHON_NAME.match(os.path.basename(fields[1])):
            continue
        argv = macos_process_argv(int(fields[0]))
        script = direct_python_script(argv)
        if script and os.path.realpath(script) == target:
            matches.append(int(fields[0]))
    return matches


def main():
    if len(sys.argv) != 2:
        print("usage: knowledge-git-process-inspector.py PATH", file=sys.stderr)
        return 2
    target = os.path.realpath(sys.argv[1])
    try:
        matches = linux_matches(target) if os.path.isdir("/proc") else macos_matches(target)
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        print("process inspection uncertain: %s" % error, file=sys.stderr)
        return 2
    if matches:
        print("knowledge-git.py still running: %s" % ",".join(str(pid) for pid in matches), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
