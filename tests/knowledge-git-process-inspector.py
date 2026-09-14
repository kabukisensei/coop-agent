#!/usr/bin/env python3
"""Inspect exact argv/cwd; exit 0 absent, 1 present, 2 uncertain."""

import ctypes
import json
import os
import re
import stat
import struct
import subprocess
import sys

PYTHON_NAME = re.compile(r"^python(?:[0-9]+(?:\.[0-9]+)*)?(?:\.exe)?$", re.IGNORECASE)
_NO_VALUE_SHORT_OPTIONS = frozenset("bBdEhiIOPqRsSuvVx?")
_NO_VALUE_LONG_OPTIONS = frozenset(
    (
        "--help",
        "--help-env",
        "--help-xoptions",
        "--help-all",
        "--version",
    )
)


def parse_direct_python_script(argv, executable_proven=False):
    """Return (classification, script) using Python's invocation grammar.

    classification is script, not-script (-c/-m/non-Python), or uncertain for
    an unknown, malformed, or ambiguous interpreter option.
    """
    if not argv:
        return "not-script", None
    # argv[0] is caller-controlled under execve(2). Inspectors may bypass its
    # spelling only after independently proving the executable is Python.
    if not executable_proven and not PYTHON_NAME.match(os.path.basename(argv[0])):
        return "not-script", None
    index = 1
    while index < len(argv):
        value = argv[index]
        if value == "--":
            index += 1
            break
        if value == "-":
            return "not-script", None
        if not value.startswith("-"):
            break
        if value.startswith("--"):
            if value in _NO_VALUE_LONG_OPTIONS:
                index += 1
                continue
            if value == "--check-hash-based-pycs":
                if index + 1 >= len(argv):
                    return "uncertain", None
                index += 2
                continue
            if value.startswith("--check-hash-based-pycs=") and value.split("=", 1)[1]:
                index += 1
                continue
            return "uncertain", None

        cluster = value[1:]
        if not cluster:
            break
        position = 0
        consumed_next = False
        while position < len(cluster):
            option = cluster[position]
            if option in ("c", "m"):
                return "not-script", None
            if option in ("W", "X"):
                # The rest of this token is the option value; otherwise the
                # following argv element is consumed (for example -EW ignore).
                if position + 1 < len(cluster):
                    position = len(cluster)
                elif index + 1 < len(argv):
                    consumed_next = True
                    position += 1
                else:
                    return "uncertain", None
                break
            if option not in _NO_VALUE_SHORT_OPTIONS:
                return "uncertain", None
            position += 1
        index += 2 if consumed_next else 1
    if index >= len(argv):
        return "not-script", None
    return "script", argv[index]


def direct_python_script(argv):
    """Compatibility wrapper: return only a proven direct script operand."""
    classification, script = parse_direct_python_script(argv)
    return script if classification == "script" else None


def _pid_exited(pid):
    proc_dir = "/proc/%d" % pid
    if not os.path.exists(proc_dir):
        return True
    try:
        with open(proc_dir + "/stat", "rb") as stream:
            fields = stream.read().split()
        return len(fields) > 2 and fields[2] == b"Z"
    except OSError:
        return not os.path.exists(proc_dir)


def _linux_read(pid, leaf, binary=False):
    path = "/proc/%d/%s" % (pid, leaf)
    try:
        if leaf in ("exe", "cwd"):
            return os.readlink(path), None
        mode = "rb" if binary else "r"
        kwargs = {} if binary else {"encoding": "ascii", "errors": "replace"}
        with open(path, mode, **kwargs) as stream:
            return stream.read(), None
    except (OSError, ValueError) as exc:
        if _pid_exited(pid):
            return None, "exited"
        return None, "%s unreadable for pid %d: %s" % (leaf, pid, exc)


def _linux_same_user_python(pid, uid):
    status, error = _linux_read(pid, "status")
    if error:
        return None, error
    observed_uid = None
    for line in status.splitlines():
        if line.startswith("Uid:"):
            fields = line.split()
            if len(fields) >= 2 and fields[1].isdigit():
                observed_uid = int(fields[1])
    if observed_uid is None:
        return None, "uid metadata malformed for pid %d" % pid
    if observed_uid != uid:
        return False, None
    executable, error = _linux_read(pid, "exe")
    if error:
        # Name/comm is caller-controlled and cannot replace executable identity.
        # Empty-cmdline kernel threads are not executable candidates; every live
        # user process whose executable identity is unreadable stays uncertain.
        if error == "exited":
            return False, None
        if "Errno 2" in error:
            cmdline, cmdline_error = _linux_read(pid, "cmdline", binary=True)
            if cmdline_error == "exited" or cmdline == b"":
                return False, None
        return None, error
    return bool(PYTHON_NAME.match(os.path.basename(executable))), None


def proc_argv(pid):
    raw, error = _linux_read(pid, "cmdline", binary=True)
    if error:
        return None, error
    if not raw:
        if _pid_exited(pid):
            return None, "exited"
        return None, "cmdline empty for live pid %d" % pid
    return [
        part.decode("utf-8", "surrogateescape")
        for part in raw.rstrip(b"\0").split(b"\0")
    ], None


def proc_cwd(pid):
    return _linux_read(pid, "cwd")


def _is_descriptor_indirection(path):
    return bool(
        re.match(
            r"^/proc/(?:[0-9]+|self|thread-self|curproc)"
            r"/(?:task/(?:[0-9]+|self)/)?fd/[0-9]+$",
            path,
        )
        or re.match(r"^/dev/fd/[0-9]+$", path)
    )


def _retargetable_operand(path):
    """Whether path or its symlink chain names a retargetable descriptor."""
    candidate = os.path.normpath(os.path.abspath(path))
    seen = set()
    for _depth in range(41):
        if _is_descriptor_indirection(candidate):
            return True
        if candidate in seen:
            return True
        seen.add(candidate)
        components = candidate.split(os.sep)[1:]
        prefix = os.sep
        for index, component in enumerate(components):
            prefix = os.path.join(prefix, component)
            try:
                destination = os.readlink(prefix)
            except OSError:
                continue
            if not os.path.isabs(destination):
                destination = os.path.join(os.path.dirname(prefix), destination)
            candidate = os.path.normpath(
                os.path.join(destination, *components[index + 1 :])
            )
            break
        else:
            return False
    return True


def _resolve_existing_regular_script(path, target=None):
    """Resolve a stable, existing regular-file operand or explain uncertainty."""
    if _retargetable_operand(path):
        return None, "script operand uses retargetable descriptor indirection"
    try:
        before = os.stat(path)
        if not stat.S_ISREG(before.st_mode):
            return None, "script operand is not a regular file"
        resolved = os.path.realpath(path, strict=True)
        after = os.stat(path)
        resolved_stat = os.stat(resolved)
    except (OSError, ValueError) as exc:
        return None, "script operand unavailable: %s" % exc
    before_identity = (before.st_dev, before.st_ino, before.st_mode)
    after_identity = (after.st_dev, after.st_ino, after.st_mode)
    resolved_identity = (
        resolved_stat.st_dev,
        resolved_stat.st_ino,
        resolved_stat.st_mode,
    )
    if before_identity != after_identity or after_identity != resolved_identity:
        return None, "script operand changed while resolving"
    lexical = os.path.normpath(os.path.abspath(path))
    if (
        target is not None
        and lexical != resolved
        and resolved != target
        and os.path.basename(lexical) == os.path.basename(target)
    ):
        return None, "script operand symlink resolves to a non-target file"
    return resolved, None


def _linux_process_identity(pid):
    """Return the kernel start identity for one live Linux process."""
    raw, error = _linux_read(pid, "stat", binary=True)
    if error:
        return None, error
    # comm is parenthesized and may contain spaces or closing parentheses. Split
    # at the final ')' before the fixed-position fields; starttime is field 22.
    closing = raw.rfind(b")")
    fields = raw[closing + 1 :].split() if closing >= 0 else []
    if len(fields) < 20 or not fields[19].isdigit():
        return None, "stat metadata malformed for pid %d" % pid
    if fields[0] == b"Z":
        return None, "exited"
    return (pid, int(fields[19])), None


def _linux_descendants(root_pid):
    """Enumerate one validated root subtree without inspecting ambient PIDs."""
    root_identity, error = _linux_process_identity(root_pid)
    if error:
        return [], ["root pid %d unavailable: %s" % (root_pid, error)]
    pending = [root_identity]
    identities = {root_pid: root_identity}
    descendants = []
    uncertainties = []
    while pending:
        identity = pending.pop()
        pid = identity[0]
        if pid != root_pid:
            descendants.append(pid)
        raw, error = _linux_read(pid, "task/%d/children" % pid)
        if error:
            current, current_error = _linux_process_identity(pid)
            if pid != root_pid and current_error == "exited":
                continue
            if current == identity:
                uncertainties.append(
                    "descendant traversal failed for pid %d: %s" % (pid, error)
                )
            else:
                uncertainties.append(
                    "process identity changed during traversal for pid %d" % pid
                )
            continue
        fields = raw.split()
        if any(not value.isdigit() for value in fields):
            uncertainties.append("children metadata malformed for pid %d" % pid)
            continue
        current, current_error = _linux_process_identity(pid)
        if current_error:
            if pid == root_pid or current_error != "exited":
                uncertainties.append(
                    "process identity changed during traversal for pid %d" % pid
                )
                continue
        elif current != identity:
            uncertainties.append(
                "process identity changed during traversal for pid %d" % pid
            )
            continue
        for value in fields:
            child_pid = int(value)
            if child_pid in identities:
                continue
            child_identity, child_error = _linux_process_identity(child_pid)
            if child_error == "exited":
                continue
            if child_error:
                uncertainties.append(
                    "descendant identity unavailable for pid %d: %s"
                    % (child_pid, child_error)
                )
                continue
            identities[child_pid] = child_identity
            pending.append(child_identity)
    final_root, final_error = _linux_process_identity(root_pid)
    if final_error or final_root != root_identity:
        uncertainties.append("root pid %d changed during traversal" % root_pid)
    return descendants, uncertainties


def linux_inspect(target, root_pid):
    own_pid = os.getpid()
    matches = []
    uid = os.geteuid()
    pids, uncertainties = _linux_descendants(root_pid)
    for pid in pids:
        if pid == own_pid:
            continue
        candidate, error = _linux_same_user_python(pid, uid)
        if error:
            if error != "exited":
                uncertainties.append(error)
            continue
        if not candidate:
            continue
        argv, error = proc_argv(pid)
        if error:
            if error != "exited":
                uncertainties.append(error)
            continue
        classification, script = parse_direct_python_script(
            argv, executable_proven=True
        )
        if classification == "uncertain":
            uncertainties.append("python argv ambiguous for pid %d" % pid)
            continue
        if classification != "script":
            continue
        if not os.path.isabs(script):
            cwd, error = proc_cwd(pid)
            if error:
                if error != "exited":
                    uncertainties.append(error)
                continue
            script = os.path.join(cwd, script)
        resolved, error = _resolve_existing_regular_script(script, target)
        if error:
            if not _pid_exited(pid):
                uncertainties.append(
                    "script path unresolved for pid %d: %s" % (pid, error)
                )
            continue
        if resolved == target:
            matches.append(pid)
    return matches, uncertainties


def linux_matches(target, root_pid):
    """Compatibility wrapper; uncertainty is an error, never absence."""
    matches, uncertainties = linux_inspect(target, root_pid)
    if uncertainties:
        raise RuntimeError("; ".join(uncertainties))
    return matches


def _windows_process_rows():
    """Read one Windows-native process snapshot through CIM."""
    script = (
        "$ErrorActionPreference='Stop';"
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);"
        "$rows=@(Get-CimInstance Win32_Process|ForEach-Object{"
        "[pscustomobject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;"
        "creation_date=$(if($null -eq $_.CreationDate){$null}else{"
        "[Int64]$_.CreationDate.ToUniversalTime().Ticks});"
        "executable=$_.ExecutablePath;command_line=$_.CommandLine}});"
        "ConvertTo-Json -InputObject $rows -Compress"
    )
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        return [], ["Windows CIM process inspection failed: %s" % result.stderr.strip()]
    try:
        decoded = json.loads(result.stdout)
    except (TypeError, ValueError) as error:
        return [], ["Windows CIM process metadata malformed: %s" % error]
    rows = decoded if isinstance(decoded, list) else [decoded]
    required = {"pid", "ppid", "creation_date", "executable", "command_line"}
    if any(not isinstance(row, dict) or set(row) != required for row in rows):
        return [], ["Windows CIM process metadata has an unexpected schema"]
    return rows, []


def _windows_descendants(root_pid, rows):
    """Return the creation-time-validated root closure from one CIM snapshot."""
    records = {}
    invalid_rows = []
    uncertainties = []
    for row in rows:
        pid = row["pid"]
        ppid = row["ppid"]
        creation_date = row["creation_date"]
        if (
            type(pid) is not int
            or pid <= 0
            or type(ppid) is not int
            or ppid < 0
            or type(creation_date) is not int
            or creation_date <= 0
        ):
            invalid_rows.append(row)
            continue
        if pid in records:
            invalid_rows.append(row)
            continue
        records[pid] = row
    if root_pid not in records:
        if any(row["pid"] == root_pid for row in invalid_rows):
            uncertainties.append(
                "Windows CIM process metadata has an invalid in-scope process identity"
            )
        uncertainties.append("root pid %d unavailable in process snapshot" % root_pid)
        return [], uncertainties
    descendants = []
    pending = [root_pid]
    seen = {root_pid}
    while pending:
        parent = pending.pop()
        parent_created = records[parent]["creation_date"]
        for pid, row in records.items():
            if (
                row["ppid"] != parent
                or pid in seen
                or row["creation_date"] < parent_created
            ):
                continue
            seen.add(pid)
            descendants.append(row)
            pending.append(pid)
    if any(
        row["pid"] == root_pid
        or row["pid"] in seen
        or any(row["ppid"] == pid for pid in seen)
        for row in invalid_rows
    ):
        uncertainties.append(
            "Windows CIM process metadata has an invalid in-scope process identity"
        )
    return descendants, uncertainties


def _windows_command_line_argv(command_line):
    """Split a kernel command line with Windows' native quoting rules."""
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    shell32.CommandLineToArgvW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.POINTER(ctypes.c_int),
    ]
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    argc = ctypes.c_int()
    pointer = shell32.CommandLineToArgvW(command_line, ctypes.byref(argc))
    if not pointer or argc.value <= 0:
        return (
            None,
            "CommandLineToArgvW failed: Windows error %d" % ctypes.get_last_error(),
        )
    try:
        return [pointer[index] for index in range(argc.value)], None
    finally:
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree(pointer)


def windows_inspect(target, root_pid):
    """Inspect only one Windows process subtree; uncertainty is never absence."""
    rows, uncertainties = _windows_process_rows()
    if uncertainties:
        return [], uncertainties
    descendants, closure_uncertainties = _windows_descendants(root_pid, rows)
    uncertainties.extend(closure_uncertainties)
    matches = []
    for row in descendants:
        pid = row["pid"]
        if pid == os.getpid():
            continue
        executable = row["executable"]
        if not isinstance(executable, str) or not executable:
            uncertainties.append("executable path unavailable for pid %d" % pid)
            continue
        if not PYTHON_NAME.match(os.path.basename(executable)):
            continue
        command_line = row["command_line"]
        if not isinstance(command_line, str) or not command_line:
            uncertainties.append("command line unavailable for python pid %d" % pid)
            continue
        argv, error = _windows_command_line_argv(command_line)
        if error:
            uncertainties.append("pid %d: %s" % (pid, error))
            continue
        classification, script = parse_direct_python_script(
            argv, executable_proven=True
        )
        if classification == "uncertain":
            uncertainties.append("python argv ambiguous for pid %d" % pid)
            continue
        if classification != "script":
            continue
        if not os.path.isabs(script):
            uncertainties.append(
                "relative python script path cannot be resolved for pid %d" % pid
            )
            continue
        resolved, error = _resolve_existing_regular_script(script, target)
        if error:
            uncertainties.append("script path unresolved for pid %d: %s" % (pid, error))
            continue
        if os.path.normcase(resolved) == os.path.normcase(target):
            matches.append(pid)
    return matches, uncertainties


def macos_process_argv(pid):
    """Read an exact macOS argv vector through KERN_PROCARGS2."""
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    sysctl = libc.sysctl
    sysctl.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_uint,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
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
    data = buffer.raw[: size.value]
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


def macos_process_executable(pid):
    """Read the kernel-backed executable path through libproc proc_pidpath."""
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    proc_pidpath = libproc.proc_pidpath
    proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    proc_pidpath.restype = ctypes.c_int
    size = 4096  # PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN)
    buffer = ctypes.create_string_buffer(size)
    ctypes.set_errno(0)
    returned = proc_pidpath(pid, buffer, size)
    saved_errno = ctypes.get_errno()
    if returned <= 0:
        return None, "proc_pidpath unavailable for pid %d: errno %d" % (
            pid,
            saved_errno,
        )
    if returned >= size:
        return None, "proc_pidpath malformed for pid %d: oversized result" % pid
    raw = buffer.raw
    if raw[returned] != 0 or raw.find(b"\0") != returned:
        return (
            None,
            "proc_pidpath malformed for pid %d: result is not NUL-terminated" % pid,
        )
    return raw[:returned].decode("utf-8", "surrogateescape"), None


# Apple XNU bsd/sys/proc_info.h LP64 contract. Keep these declarations complete:
# proc_pidinfo(PROC_PIDVNODEPATHINFO) requires the full 2352-byte result buffer.
class _VinfoStat(ctypes.Structure):
    _fields_ = [
        ("vst_dev", ctypes.c_uint32),
        ("vst_mode", ctypes.c_uint16),
        ("vst_nlink", ctypes.c_uint16),
        ("vst_ino", ctypes.c_uint64),
        ("vst_uid", ctypes.c_uint32),
        ("vst_gid", ctypes.c_uint32),
        ("vst_atime", ctypes.c_int64),
        ("vst_atimensec", ctypes.c_int64),
        ("vst_mtime", ctypes.c_int64),
        ("vst_mtimensec", ctypes.c_int64),
        ("vst_ctime", ctypes.c_int64),
        ("vst_ctimensec", ctypes.c_int64),
        ("vst_birthtime", ctypes.c_int64),
        ("vst_birthtimensec", ctypes.c_int64),
        ("vst_size", ctypes.c_int64),
        ("vst_blocks", ctypes.c_int64),
        ("vst_blksize", ctypes.c_int32),
        ("vst_flags", ctypes.c_uint32),
        ("vst_gen", ctypes.c_uint32),
        ("vst_rdev", ctypes.c_uint32),
        ("vst_qspare", ctypes.c_int64 * 2),
    ]


class _Fsid(ctypes.Structure):
    _fields_ = [("val", ctypes.c_int32 * 2)]


class _VnodeInfo(ctypes.Structure):
    _fields_ = [
        ("vi_stat", _VinfoStat),
        ("vi_type", ctypes.c_int32),
        ("vi_pad", ctypes.c_int32),
        ("vi_fsid", _Fsid),
    ]


class _VnodeInfoPath(ctypes.Structure):
    _fields_ = [("vip_vi", _VnodeInfo), ("vip_path", ctypes.c_char * 1024)]


class _ProcVnodePathInfo(ctypes.Structure):
    _fields_ = [("pvi_cdir", _VnodeInfoPath), ("pvi_rdir", _VnodeInfoPath)]


def macos_process_cwd(pid):
    """Read cwd through proc_pidinfo(PROC_PIDVNODEPATHINFO)."""
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    proc_pidinfo = libproc.proc_pidinfo
    proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    proc_pidinfo.restype = ctypes.c_int
    info = _ProcVnodePathInfo()
    size = ctypes.sizeof(info)
    ctypes.set_errno(0)
    returned = proc_pidinfo(pid, 9, 0, ctypes.byref(info), size)
    if returned != size:
        return None
    path_offset = _VnodeInfoPath.vip_path.offset
    raw = ctypes.string_at(ctypes.addressof(info.pvi_cdir) + path_offset, 1024)
    nul = raw.find(b"\0")
    if nul <= 0:
        return None
    return raw[:nul].decode("utf-8", "surrogateescape")


def _macos_pid_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def _macos_descendants(root_pid, rows):
    """Return the root closure from one pid/ppid/uid process snapshot."""
    records = {}
    uncertainties = []
    for line in rows:
        fields = line.strip().split()
        if len(fields) != 3 or not all(value.isdigit() for value in fields):
            uncertainties.append("ps process metadata malformed: %s" % line.strip())
            continue
        pid, ppid, uid = (int(value) for value in fields)
        if pid in records:
            uncertainties.append("ps process metadata duplicates pid %d" % pid)
            continue
        records[pid] = (ppid, uid)
    if root_pid not in records:
        uncertainties.append("root pid %d unavailable in process snapshot" % root_pid)
        return [], records, uncertainties
    closure = []
    pending = [root_pid]
    seen = set()
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        closure.append(pid)
        children = [child for child, (parent, _uid) in records.items() if parent == pid]
        pending.extend(reversed(children))
    return [pid for pid in closure if pid != root_pid], records, uncertainties


def macos_inspect(target, root_pid):
    """Use ps only for same-UID candidates, then native APIs for identity/data."""
    result = subprocess.run(
        ["ps", "-ww", "-axo", "pid=,ppid=,uid="],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=5,
        check=False,
    )
    if result.returncode != 0:
        return [], ["ps process inspection failed: %s" % result.stderr.strip()]
    matches = []
    pids, records, uncertainties = _macos_descendants(
        root_pid, result.stdout.splitlines()
    )
    if root_pid not in records:
        return [], uncertainties
    own_pid = os.getpid()
    uid = os.geteuid()
    for pid in pids:
        if pid == own_pid:
            continue
        if records[pid][1] != uid:
            continue
        executable, error = macos_process_executable(pid)
        if error:
            if _macos_pid_exists(pid):
                uncertainties.append(error)
            continue
        if executable is None:
            if _macos_pid_exists(pid):
                uncertainties.append("proc_pidpath returned no path for pid %d" % pid)
            continue
        if not PYTHON_NAME.match(os.path.basename(executable)):
            continue
        argv = macos_process_argv(pid)
        if argv is None:
            if _macos_pid_exists(pid):
                uncertainties.append("KERN_PROCARGS2 unavailable for pid %d" % pid)
            continue
        classification, script = parse_direct_python_script(
            argv, executable_proven=True
        )
        if classification == "uncertain":
            uncertainties.append("python argv ambiguous for pid %d" % pid)
            continue
        if classification != "script":
            continue
        if not os.path.isabs(script):
            cwd = macos_process_cwd(pid)
            if cwd is None:
                if _macos_pid_exists(pid):
                    uncertainties.append("process cwd unavailable for pid %d" % pid)
                continue
            script = os.path.join(cwd, script)
        resolved, error = _resolve_existing_regular_script(script, target)
        if error:
            if _macos_pid_exists(pid):
                uncertainties.append(
                    "script path unresolved for pid %d: %s" % (pid, error)
                )
            continue
        if resolved == target:
            matches.append(pid)
    return matches, uncertainties


def macos_matches(target, root_pid):
    matches, uncertainties = macos_inspect(target, root_pid)
    if uncertainties:
        raise RuntimeError("; ".join(uncertainties))
    return matches


def main():
    if (
        len(sys.argv) != 4
        or sys.argv[1] != "--root-pid"
        or not sys.argv[2].isdigit()
        or int(sys.argv[2]) <= 0
    ):
        print(
            "usage: knowledge-git-process-inspector.py --root-pid PID PATH",
            file=sys.stderr,
        )
        return 2
    root_pid = int(sys.argv[2])
    target = os.path.realpath(sys.argv[3])
    try:
        if os.name == "nt":
            matches, uncertainties = windows_inspect(target, root_pid)
        elif sys.platform == "darwin":
            matches, uncertainties = macos_inspect(target, root_pid)
        elif os.path.isdir("/proc"):
            matches, uncertainties = linux_inspect(target, root_pid)
        else:
            matches, uncertainties = [], ["unsupported process inspection platform"]
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        print("process inspection uncertain: %s" % error, file=sys.stderr)
        return 2
    if matches:
        print(
            "knowledge-git.py still running: %s"
            % ",".join(str(pid) for pid in matches),
            file=sys.stderr,
        )
        return 1
    if uncertainties:
        print(
            "process inspection uncertain: %s" % "; ".join(uncertainties),
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
