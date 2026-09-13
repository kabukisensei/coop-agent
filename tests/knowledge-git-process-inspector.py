#!/usr/bin/env python3
"""Inspect exact argv/cwd; exit 0 absent, 1 present, 2 uncertain."""

import ctypes
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
    process_name = None
    for line in status.splitlines():
        if line.startswith("Name:"):
            fields = line.split(None, 1)
            process_name = fields[1].strip() if len(fields) == 2 else None
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
        # A non-Python comm can safely exclude an unreadable executable, but it
        # must never override readable executable identity: execve through a
        # symlink may set comm to the alias while /proc/<pid>/exe proves Python.
        if error == "exited" or (process_name and not PYTHON_NAME.match(process_name)):
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


def _resolve_existing_regular_script(path):
    """Resolve a stable, existing regular-file operand or explain uncertainty."""
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
    return resolved, None


def linux_inspect(target):
    own_pid = os.getpid()
    matches = []
    uncertainties = []
    uid = os.geteuid()
    try:
        names = os.listdir("/proc")
    except OSError as exc:
        return [], ["cannot enumerate /proc: %s" % exc]
    for name in names:
        if not name.isdigit() or int(name) == own_pid:
            continue
        pid = int(name)
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
        resolved, error = _resolve_existing_regular_script(script)
        if error:
            if not _pid_exited(pid):
                uncertainties.append(
                    "script path unresolved for pid %d: %s" % (pid, error)
                )
            continue
        if resolved == target:
            matches.append(pid)
    return matches, uncertainties


def linux_matches(target):
    """Compatibility wrapper; uncertainty is an error, never absence."""
    matches, uncertainties = linux_inspect(target)
    if uncertainties:
        raise RuntimeError("; ".join(uncertainties))
    return matches


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


def macos_inspect(target):
    """Use bounded ps candidates, then native APIs for exact argv and cwd."""
    result = subprocess.run(
        ["ps", "-ww", "-axo", "pid=,comm="],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=5,
        check=False,
    )
    if result.returncode != 0:
        return [], ["ps process inspection failed: %s" % result.stderr.strip()]
    matches = []
    uncertainties = []
    own_pid = os.getpid()
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or not fields[0].isdigit() or int(fields[0]) == own_pid:
            continue
        if not PYTHON_NAME.match(os.path.basename(fields[1])):
            continue
        pid = int(fields[0])
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
        resolved, error = _resolve_existing_regular_script(script)
        if error:
            if _macos_pid_exists(pid):
                uncertainties.append(
                    "script path unresolved for pid %d: %s" % (pid, error)
                )
            continue
        if resolved == target:
            matches.append(pid)
    return matches, uncertainties


def macos_matches(target):
    matches, uncertainties = macos_inspect(target)
    if uncertainties:
        raise RuntimeError("; ".join(uncertainties))
    return matches


def main():
    if len(sys.argv) != 2:
        print("usage: knowledge-git-process-inspector.py PATH", file=sys.stderr)
        return 2
    target = os.path.realpath(sys.argv[1])
    try:
        matches, uncertainties = (
            linux_inspect(target) if os.path.isdir("/proc") else macos_inspect(target)
        )
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
