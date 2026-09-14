#!/usr/bin/env python3
"""Focused cross-platform tests for knowledge-git ownership contracts."""

import ctypes
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "knowledge_git", ROOT / "scripts" / "knowledge-git.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load scripts/knowledge-git.py")
kg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kg)
INSPECTOR_SPEC = importlib.util.spec_from_file_location(
    "knowledge_git_process_inspector",
    ROOT / "tests" / "knowledge-git-process-inspector.py",
)
if INSPECTOR_SPEC is None or INSPECTOR_SPEC.loader is None:
    raise RuntimeError("could not load knowledge-git process inspector")
inspector = importlib.util.module_from_spec(INSPECTOR_SPEC)
INSPECTOR_SPEC.loader.exec_module(inspector)


class FakeProcess:
    pid = 4242


class KnowledgeGitOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        for name in (
            kg._TEST_FAULT_ENV,
            kg._TEST_PID_FILE_ENV,
            kg._TEST_EVENT_NONCE_ENV,
        ):
            os.environ.pop(name, None)
        kg._SELECTED_TEST_FAULT = ""
        kg._TEST_EVENT_NONCE = ""
        kg._TEST_PID_FILE = ""
        kg._TEST_FAULT_ARMED = False
        kg._CONSUMED_TEST_FAULTS.clear()

    def tearDown(self):
        self.env.stop()

    def windows_os(self):
        return SimpleNamespace(name="nt", environ=os.environ)

    def select_fault(self, stage):
        kg._SELECTED_TEST_FAULT = stage
        kg._TEST_EVENT_NONCE = "0123456789abcdef0123456789abcdef"
        kg._TEST_FAULT_ARMED = True

    def test_fault_seam_is_allowlisted_and_inert_by_default(self):
        self.assertFalse(kg._test_fault("job-create"))
        kg._SELECTED_TEST_FAULT = ""
        self.assertFalse(kg._test_fault("job-create"))
        for stage in kg._TEST_FAULTS:
            self.select_fault(stage)
            self.assertTrue(kg._test_fault(stage))

    def test_consumed_fault_emits_one_exact_nonce_bound_stderr_record(self):
        nonce = "0123456789abcdef0123456789abcdef"
        for stage in sorted(kg._TEST_FAULTS):
            self.select_fault(stage)
            kg._TEST_EVENT_NONCE = nonce
            stream = io.StringIO()
            with mock.patch.object(kg.sys, "stderr", stream):
                self.assertTrue(kg._consume_test_fault(stage))
                self.assertTrue(kg._consume_test_fault(stage))
            kg._CONSUMED_TEST_FAULTS.clear()
            line = stream.getvalue().strip()
            self.assertTrue(line.startswith(kg._TEST_RECORD_PREFIX))
            self.assertEqual(
                json.loads(line[len(kg._TEST_RECORD_PREFIX) :]),
                {
                    "schema_version": 1,
                    "nonce": nonce,
                    "stage": stage,
                    "outcome": kg._TEST_FAULT_OUTCOMES[stage],
                },
            )

    def test_lifecycle_record_is_line_framed_after_any_payload_stderr(self):
        nonce = "0123456789abcdef0123456789abcdef"
        for payload in ("ordinary payload progress", "ordinary payload progress\n"):
            self.select_fault("job-query")
            stream = io.StringIO()
            stream.write(payload)
            with mock.patch.object(kg.sys, "stderr", stream):
                self.assertTrue(kg._consume_test_fault("job-query"))
            records = [
                line
                for line in stream.getvalue().splitlines()
                if line.startswith(kg._TEST_RECORD_PREFIX)
            ]
            self.assertEqual(len(records), 1, stream.getvalue())
            self.assertEqual(
                json.loads(records[0][len(kg._TEST_RECORD_PREFIX) :]),
                {
                    "schema_version": 1,
                    "nonce": nonce,
                    "stage": "job-query",
                    "outcome": "indeterminate",
                },
            )
            kg._CONSUMED_TEST_FAULTS.clear()

    def test_emission_failure_is_distinct_unconsumed_and_retryable(self):
        self.select_fault("job-create")
        kg._TEST_EVENT_NONCE = "0123456789abcdef0123456789abcdef"
        broken = mock.Mock()
        broken.write.side_effect = OSError("closed")
        with mock.patch.object(kg.sys, "stderr", broken):
            with self.assertRaisesRegex(kg.TestEvidenceError, "emission failed"):
                kg._consume_test_fault("job-create")
        self.assertEqual(kg._CONSUMED_TEST_FAULTS, set())
        with mock.patch.object(kg.sys, "stderr", io.StringIO()):
            self.assertTrue(kg._consume_test_fault("job-create"))

    def test_lifecycle_wrappers_fail_closed_when_record_emission_fails(self):
        nonce = "0123456789abcdef0123456789abcdef"
        broken = mock.Mock()
        broken.write.side_effect = OSError("closed")
        job = object()
        for stage, call in (
            ("job-assign", lambda: kg._win_job_assign(job, 123)),
            ("resume", lambda: kg._win_resume_pid(123)),
            ("job-terminate", lambda: kg._win_job_terminate(job)),
        ):
            self.select_fault(stage)
            kg._TEST_EVENT_NONCE = nonce
            with mock.patch.object(kg.sys, "stderr", broken):
                ok, error = call()
            self.assertFalse(ok, stage)
            self.assertEqual(error[0], "test-evidence", stage)
            kg._CONSUMED_TEST_FAULTS.clear()
        self.select_fault("job-query")
        kg._TEST_EVENT_NONCE = nonce
        with mock.patch.object(kg.sys, "stderr", broken):
            self.assertIsNone(kg._win_job_active_processes(job))
        self.assertEqual(kg._CONSUMED_TEST_FAULTS, set())
        self.select_fault("job-close")
        kg._TEST_EVENT_NONCE = nonce
        with (
            mock.patch.object(kg.sys, "stderr", broken),
            mock.patch.object(
                kg, "_win_job_close_raw", return_value=(True, None)
            ) as raw_close,
        ):
            closed, error = kg._win_job_close(job)
        self.assertFalse(closed)
        self.assertEqual(error[0], "test-evidence")
        raw_close.assert_called_once_with(job)
        self.assertEqual(kg._CONSUMED_TEST_FAULTS, set())

    def test_invalid_nonce_refuses_injected_result_without_record(self):
        self.select_fault("job-close")
        kg._TEST_EVENT_NONCE = "not-valid"
        stream = io.StringIO()
        with mock.patch.object(kg.sys, "stderr", stream):
            with self.assertRaisesRegex(kg.TestEvidenceError, "nonce is invalid"):
                kg._consume_test_fault("job-close")
        self.assertEqual(stream.getvalue(), "")
        self.assertEqual(kg._CONSUMED_TEST_FAULTS, set())

    def test_payload_environment_strips_all_test_secrets_and_mutation_controls(self):
        os.environ[kg._TEST_FAULT_ENV] = "job-close"
        os.environ[kg._TEST_EVENT_NONCE_ENV] = "0123456789abcdef0123456789abcdef"
        os.environ[kg._TEST_PID_FILE_ENV] = "/secret/pid"
        os.environ["COOP_TERMINAL_ACCEPTANCE_EVENT_MUTATION"] = "wrong-event"
        os.environ["COOP_TERMINAL_ACCEPTANCE_OWNERSHIP_FIXTURE"] = "/fixture"
        os.environ["SAFE_PAYLOAD_VALUE"] = "retained"
        env = kg._payload_environment()
        self.assertEqual(env["SAFE_PAYLOAD_VALUE"], "retained")
        self.assertFalse(
            any(name.startswith("COOP_KNOWLEDGE_GIT_TEST_") for name in env)
        )
        self.assertFalse(
            any(name.startswith("COOP_TERMINAL_ACCEPTANCE_") for name in env)
        )

    def test_harness_transport_override_prevents_preliminary_probe_consumption(self):
        os.environ["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
        self.select_fault("job-create")
        with mock.patch.object(kg, "probe_core_ssh_command") as probe:
            env, warning, state = kg.child_env(
                ["git", "status"], kg.time.monotonic() + 1
            )
        probe.assert_not_called()
        self.assertEqual((warning, state), (None, kg.PROBE_UNSET))
        self.assertNotIn(kg._TEST_FAULT_ENV, env)
        self.assertNotIn(kg._TEST_EVENT_NONCE_ENV, env)
        self.assertEqual(kg._CONSUMED_TEST_FAULTS, set())

    def test_preliminary_probe_cannot_consume_or_emit_selected_fault(self):
        self.select_fault("job-create")
        kg._TEST_FAULT_ARMED = False
        stream = io.StringIO()
        with mock.patch.object(kg.sys, "stderr", stream):
            self.assertFalse(kg._consume_test_fault("job-create"))
        self.assertEqual(stream.getvalue(), "")
        self.assertEqual(kg._CONSUMED_TEST_FAULTS, set())

    def test_real_payload_cannot_read_helper_test_secrets(self):
        helper = ROOT / "scripts" / "knowledge-git.py"
        names = [
            kg._TEST_FAULT_ENV,
            kg._TEST_EVENT_NONCE_ENV,
            kg._TEST_PID_FILE_ENV,
            "COOP_TERMINAL_ACCEPTANCE_EVENT_MUTATION",
        ]
        code = "import json,os,sys;print(json.dumps({n:os.environ.get(n) for n in sys.argv[1:]}))"
        env = {
            **os.environ,
            "GIT_SSH_COMMAND": "ssh -o BatchMode=yes",
            kg._TEST_FAULT_ENV: "job-close",
            kg._TEST_EVENT_NONCE_ENV: "a" * 32,
            kg._TEST_PID_FILE_ENV: "/secret/pid",
            "COOP_TERMINAL_ACCEPTANCE_EVENT_MUTATION": "payload-spoofed",
        }
        result = subprocess.run(
            [sys.executable, str(helper), "--", sys.executable, "-c", code, *names],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {name: None for name in names})

    def test_create_failure_reaches_adopt_and_stops_suspended_child(self):
        self.select_fault("job-create")
        with (
            mock.patch.object(kg, "os", self.windows_os()),
            mock.patch.object(
                kg, "_win_terminate_pid", return_value=(True, None)
            ) as stop,
        ):
            ownership = kg.Ownership()
            ownership.adopt(FakeProcess())
        self.assertFalse(ownership.available)
        self.assertIn("test-job-create", ownership.unavailable_reason)
        stop.assert_called_once_with(FakeProcess.pid)

    def test_assignment_failure_reaches_adopt_and_closes_job(self):
        self.select_fault("job-assign")
        job = object()
        with (
            mock.patch.object(kg, "os", self.windows_os()),
            mock.patch.object(kg, "_win_job_create", return_value=(job, None)),
            mock.patch.object(
                kg, "_win_terminate_pid", return_value=(True, None)
            ) as stop,
            mock.patch.object(kg, "_win_job_close", return_value=(True, None)) as close,
        ):
            ownership = kg.Ownership()
            ownership.adopt(FakeProcess())
        self.assertFalse(ownership.available)
        self.assertIn("test-job-assign", ownership.unavailable_reason)
        stop.assert_called_once_with(FakeProcess.pid)
        close.assert_called_once_with(job)

    def test_resume_failure_reaches_adopt_and_closes_owned_job_without_pid_fallback(
        self,
    ):
        self.select_fault("resume")
        job = object()
        with (
            mock.patch.object(kg, "os", self.windows_os()),
            mock.patch.object(kg, "_win_job_create", return_value=(job, None)),
            mock.patch.object(kg, "_win_job_assign", return_value=(True, None)),
            mock.patch.object(
                kg, "_win_job_terminate", return_value=(True, None)
            ) as terminate,
            mock.patch.object(
                kg, "_win_terminate_pid", return_value=(True, None)
            ) as stop,
            mock.patch.object(kg, "_win_job_close", return_value=(True, None)) as close,
        ):
            ownership = kg.Ownership()
            ownership.adopt(FakeProcess())
        self.assertFalse(ownership.available)
        self.assertIn("test-resume", ownership.unavailable_reason)
        terminate.assert_called_once_with(job)
        stop.assert_not_called()
        close.assert_called_once_with(job)

    def test_resume_failure_closes_immediately_after_failed_job_termination(self):
        job = object()
        calls = []

        def record(name, result):
            def invoke(*_args):
                calls.append(name)
                return result

            return invoke

        with (
            mock.patch.object(kg, "os", self.windows_os()),
            mock.patch.object(
                kg, "_win_job_create", side_effect=record("create", (job, None))
            ),
            mock.patch.object(
                kg, "_win_job_assign", side_effect=record("assign", (True, None))
            ),
            mock.patch.object(
                kg,
                "_win_resume_pid",
                side_effect=record("resume", (False, ("resume", "already_running"))),
            ),
            mock.patch.object(
                kg,
                "_win_job_terminate",
                side_effect=record("terminate-failed", (False, ("terminate", 5))),
            ),
            mock.patch.object(
                kg,
                "_win_terminate_pid",
                side_effect=record("PID-fallback", (True, None)),
            ) as stop,
            mock.patch.object(
                kg, "_win_job_close", side_effect=record("close-job", (True, None))
            ) as close,
            mock.patch.object(kg.time, "sleep") as sleep,
        ):
            ownership = kg.Ownership()
            ownership.adopt(FakeProcess())
            self.assertTrue(ownership.close())

        self.assertEqual(
            calls, ["create", "assign", "resume", "terminate-failed", "close-job"]
        )
        stop.assert_not_called()
        sleep.assert_not_called()
        close.assert_called_once_with(job)
        self.assertFalse(ownership.available)
        self.assertIn("already_running", ownership.unavailable_reason)
        self.assertIn("Job termination failed", ownership.unavailable_reason)

    def test_query_failure_is_uncertain_not_empty(self):
        self.select_fault("job-query")
        with mock.patch.object(kg, "os", self.windows_os()):
            ownership = kg.Ownership()
            ownership.job = object()
            self.assertEqual(
                ownership.wait_empty(kg.time.monotonic() + 1), kg.OWNERSHIP_UNCERTAIN
            )

    def test_probe_containment_failure_aborts_instead_of_guessing_transport(self):
        with mock.patch.object(
            kg, "run_bounded_capture", return_value=("unavailable", None)
        ):
            state, value = kg.probe_core_ssh_command(
                ["git", "status"], kg.time.monotonic() + 1
            )
        self.assertEqual((state, value), (kg.PROBE_OWNERSHIP_UNCERTAIN, None))

    def test_termination_and_close_faults_report_failure(self):
        with mock.patch.object(kg, "os", self.windows_os()):
            self.select_fault("job-terminate")
            self.assertEqual(kg._win_job_terminate(object())[0], False)
            self.select_fault("job-close")
            ownership = kg.Ownership()
            ownership.job = object()
            self.assertFalse(ownership.close())

    def test_failed_job_termination_closes_immediately_without_grace_wait_or_double_close(
        self,
    ):
        job = object()
        with (
            mock.patch.object(kg, "os", self.windows_os()),
            mock.patch.object(
                kg, "_win_job_terminate", return_value=(False, ("terminate", 5))
            ) as terminate,
            mock.patch.object(kg.subprocess, "run") as taskkill,
            mock.patch.object(kg, "_win_job_close", return_value=(True, None)) as close,
        ):
            ownership = kg.Ownership()
            ownership.job = job
            ownership.child = FakeProcess()
            with mock.patch.object(ownership, "wait_empty") as wait_empty:
                self.assertEqual(
                    ownership.terminate_and_wait(
                        kg.time.monotonic() + kg.CLEANUP_GRACE_SECONDS
                    ),
                    kg.OWNERSHIP_EMPTY,
                )
            self.assertTrue(ownership.close())
        terminate.assert_called_once_with(job)
        taskkill.assert_not_called()
        wait_empty.assert_not_called()
        close.assert_called_once_with(job)

    def test_close_uncertainty_overrides_payload_success(self):
        ownership = mock.Mock()
        ownership.close.return_value = False
        self.assertEqual(kg.finish_owned(ownership, 0), kg.EXIT_OWNERSHIP_UNAVAILABLE)
        self.assertEqual(kg.finish_owned(ownership, kg.EXIT_TIMEOUT), kg.EXIT_TIMEOUT)

    @unittest.skipIf(os.name == "nt", "POSIX process-group contract")
    def test_posix_termination_signals_only_spawn_captured_pgid(self):
        ownership = kg.Ownership()
        child = mock.Mock(pid=4242)
        ownership.adopt(child)
        self.assertEqual(ownership.pgid, 4242)
        with (
            mock.patch.object(
                kg.os, "killpg", side_effect=ProcessLookupError
            ) as killpg,
            mock.patch.object(kg.os, "getpgid") as getpgid,
        ):
            self.assertFalse(ownership.terminate())
        killpg.assert_called_once_with(4242, kg.signal.SIGKILL)
        getpgid.assert_not_called()
        child.kill.assert_not_called()


class ProcessInspectorTests(unittest.TestCase):
    def test_direct_script_parser_matches_python_option_rules(self):
        target = "/tmp/helper path/scripts/knowledge-git.py"
        accepted = (
            ["python3", target],
            ["python3", "-EW", "ignore", target],
            ["python3", "-Wignore", target],
            ["python3", "-Xdev", target],
            ["python3", "--", target],
            ["python3", "-EIu", target],
        )
        for argv in accepted:
            self.assertEqual(
                inspector.parse_direct_python_script(argv), ("script", target), argv
            )
        for argv in (["python3", "-c", "mention " + target], ["python3", "-m", target]):
            self.assertEqual(
                inspector.parse_direct_python_script(argv)[0], "not-script"
            )
        self.assertEqual(
            inspector.parse_direct_python_script(["python3", "-"])[0], "not-script"
        )
        for argv in (["python3", "-Z", target], ["python3", "-W"]):
            self.assertEqual(inspector.parse_direct_python_script(argv)[0], "uncertain")
        self.assertIsNone(inspector.direct_python_script(["bash", "-c", target]))
        self.assertEqual(
            inspector.parse_direct_python_script(
                ["worker-python", "-EI", target], executable_proven=True
            ),
            ("script", target),
        )

    def test_macos_vnodepathinfo_matches_apple_lp64_abi(self):
        self.assertEqual(ctypes.sizeof(inspector._VinfoStat), 136)
        self.assertEqual(ctypes.sizeof(inspector._VnodeInfo), 152)
        self.assertEqual(ctypes.sizeof(inspector._VnodeInfoPath), 1176)
        self.assertEqual(ctypes.sizeof(inspector._ProcVnodePathInfo), 2352)
        self.assertEqual(inspector._VnodeInfo.vi_type.offset, 136)
        self.assertEqual(inspector._VnodeInfo.vi_fsid.offset, 144)
        self.assertEqual(inspector._VnodeInfoPath.vip_path.offset, 152)
        self.assertEqual(inspector._ProcVnodePathInfo.pvi_rdir.offset, 1176)

    def test_macos_cwd_requests_complete_buffer_and_requires_exact_nul_terminated_result(
        self,
    ):
        class FakeProcPidInfo:
            def __init__(self, returned=None, path=b"/tmp/helper cwd\0"):
                self.argtypes = None
                self.restype = None
                self.returned = returned
                self.path = path
                self.requested = None

            def __call__(self, pid, flavor, arg, buffer, size):
                self.requested = (pid, flavor, arg, size)
                info = ctypes.cast(
                    buffer, ctypes.POINTER(inspector._ProcVnodePathInfo)
                ).contents
                ctypes.memmove(
                    ctypes.addressof(info.pvi_cdir)
                    + inspector._VnodeInfoPath.vip_path.offset,
                    self.path,
                    len(self.path),
                )
                return size if self.returned is None else self.returned

        success = FakeProcPidInfo()
        with mock.patch.object(
            inspector.ctypes,
            "CDLL",
            return_value=SimpleNamespace(proc_pidinfo=success),
        ):
            self.assertEqual(inspector.macos_process_cwd(101), "/tmp/helper cwd")
        self.assertEqual(success.requested, (101, 9, 0, 2352))

        for failed in (
            FakeProcPidInfo(returned=2351),
            FakeProcPidInfo(path=b"x" * 1024),
        ):
            with mock.patch.object(
                inspector.ctypes,
                "CDLL",
                return_value=SimpleNamespace(proc_pidinfo=failed),
            ):
                self.assertIsNone(inspector.macos_process_cwd(101))

    def test_macos_executable_uses_proc_pidpath_abi_and_validates_result(self):
        class FakeProcPidPath:
            def __init__(self, path=b"/usr/bin/python3", returned=None, error=0):
                self.argtypes = None
                self.restype = None
                self.path = path
                self.returned = returned
                self.error = error
                self.requested = None

            def __call__(self, pid, buffer, size):
                self.requested = (pid, size)
                ctypes.set_errno(self.error)
                ctypes.memmove(buffer, self.path, min(len(self.path), size))
                return len(self.path) if self.returned is None else self.returned

        success = FakeProcPidPath()
        with mock.patch.object(
            inspector.ctypes,
            "CDLL",
            return_value=SimpleNamespace(proc_pidpath=success),
        ):
            self.assertEqual(
                inspector.macos_process_executable(101), ("/usr/bin/python3", None)
            )
        self.assertEqual(success.requested, (101, 4096))
        self.assertEqual(
            success.argtypes, [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        )
        self.assertIs(success.restype, ctypes.c_int)

        failed = FakeProcPidPath(returned=0, error=13)
        with mock.patch.object(
            inspector.ctypes,
            "CDLL",
            return_value=SimpleNamespace(proc_pidpath=failed),
        ):
            path, error = inspector.macos_process_executable(101)
        self.assertIsNone(path)
        self.assertIn("errno 13", error)

        unterminated = FakeProcPidPath(path=b"/usr/bin/python3X", returned=16)
        with mock.patch.object(
            inspector.ctypes,
            "CDLL",
            return_value=SimpleNamespace(proc_pidpath=unterminated),
        ):
            self.assertIn("NUL-terminated", inspector.macos_process_executable(101)[1])

    def test_macos_native_executable_identity_rejects_spoof_and_inspects_alias(self):
        uid = os.geteuid()
        ps_result = SimpleNamespace(returncode=0, stdout="101 %d\n" % uid, stderr="")
        target = "/tmp/knowledge-git.py"
        scenarios = (
            ("/usr/bin/python3", ["worker-alias", target], ([101], []), True),
            ("/bin/not-python", ["python3", target], ([], []), False),
        )
        for executable, argv, expected, argv_read in scenarios:
            with (
                mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
                mock.patch.object(
                    inspector,
                    "macos_process_executable",
                    return_value=(executable, None),
                ),
                mock.patch.object(
                    inspector, "macos_process_argv", return_value=argv
                ) as read,
                mock.patch.object(
                    inspector,
                    "_resolve_existing_regular_script",
                    return_value=(target, None),
                ),
            ):
                self.assertEqual(inspector.macos_inspect(target), expected)
            self.assertEqual(read.called, argv_read)

    def test_macos_unavailable_executable_identity_is_uncertain_only_while_live(self):
        uid = os.geteuid()
        ps_result = SimpleNamespace(returncode=0, stdout="101 %d\n" % uid, stderr="")
        for live, expected_uncertainty in ((True, True), (False, False)):
            with (
                mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
                mock.patch.object(
                    inspector,
                    "macos_process_executable",
                    return_value=(
                        None,
                        "proc_pidpath unavailable for pid 101: errno 1",
                    ),
                ),
                mock.patch.object(inspector, "_macos_pid_exists", return_value=live),
            ):
                matches, uncertainties = inspector.macos_inspect(
                    "/tmp/knowledge-git.py"
                )
            self.assertEqual(matches, [])
            self.assertEqual(bool(uncertainties), expected_uncertainty)

    def test_macos_ps_uid_filter_uses_native_executable_argv_and_target_cwd(self):
        uid = os.geteuid()
        ps_result = SimpleNamespace(
            returncode=0,
            stdout="101 %d\n102 %d\n103 %d\n" % (uid, uid, uid + 1),
            stderr="",
        )
        target = "/tmp/helper path/scripts/knowledge-git.py"
        native_paths = (("/usr/bin/python3", None), ("/bin/bash", None))
        with (
            mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
            mock.patch.object(
                inspector, "macos_process_executable", side_effect=native_paths
            ),
            mock.patch.object(
                inspector,
                "macos_process_argv",
                return_value=["worker-python", "knowledge-git.py"],
            ),
            mock.patch.object(
                inspector, "macos_process_cwd", return_value="/tmp/helper path/scripts"
            ),
            mock.patch.object(
                inspector,
                "_resolve_existing_regular_script",
                return_value=(target, None),
            ),
        ):
            self.assertEqual(inspector.macos_inspect(target), ([101], []))
        with (
            mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
            mock.patch.object(
                inspector, "macos_process_executable", side_effect=native_paths
            ),
            mock.patch.object(inspector, "macos_process_argv", return_value=None),
            mock.patch.object(inspector, "_macos_pid_exists", return_value=True),
        ):
            self.assertEqual(
                inspector.macos_inspect(target)[1],
                ["KERN_PROCARGS2 unavailable for pid 101"],
            )
        with (
            mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
            mock.patch.object(
                inspector, "macos_process_executable", side_effect=native_paths
            ),
            mock.patch.object(
                inspector,
                "macos_process_argv",
                return_value=["worker-python", "knowledge-git.py"],
            ),
            mock.patch.object(inspector, "macos_process_cwd", return_value=None),
            mock.patch.object(inspector, "_macos_pid_exists", return_value=True),
        ):
            self.assertIn("cwd unavailable", inspector.macos_inspect(target)[1][0])
        with (
            mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
            mock.patch.object(
                inspector, "macos_process_executable", side_effect=native_paths
            ),
            mock.patch.object(inspector, "macos_process_argv", return_value=None),
            mock.patch.object(inspector, "_macos_pid_exists", return_value=False),
        ):
            self.assertEqual(inspector.macos_inspect(target), ([], []))

    def test_linux_cmdline_and_cwd_failures_are_uncertain_but_exit_is_ignored(self):
        target = "/tmp/knowledge-git.py"
        with (
            mock.patch("builtins.open", side_effect=PermissionError("denied")),
            mock.patch.object(inspector, "_pid_exited", return_value=False),
        ):
            value, error = inspector._linux_read(101, "cmdline", binary=True)
            self.assertIsNone(value)
            self.assertIn("unreadable", error)
        with (
            mock.patch.object(inspector.os, "listdir", return_value=["101"]),
            mock.patch.object(
                inspector, "_linux_same_user_python", return_value=(True, None)
            ),
            mock.patch.object(
                inspector, "proc_argv", return_value=(None, "cmdline unreadable")
            ),
        ):
            self.assertEqual(
                inspector.linux_inspect(target), ([], ["cmdline unreadable"])
            )
        with (
            mock.patch.object(inspector.os, "listdir", return_value=["101"]),
            mock.patch.object(
                inspector, "_linux_same_user_python", return_value=(True, None)
            ),
            mock.patch.object(
                inspector,
                "proc_argv",
                return_value=(["python3", "knowledge-git.py"], None),
            ),
            mock.patch.object(
                inspector, "proc_cwd", return_value=(None, "cwd permission denied")
            ),
        ):
            self.assertEqual(
                inspector.linux_inspect(target), ([], ["cwd permission denied"])
            )
        with (
            mock.patch.object(inspector.os, "listdir", return_value=["101"]),
            mock.patch.object(
                inspector, "_linux_same_user_python", return_value=(True, None)
            ),
            mock.patch.object(inspector, "proc_argv", return_value=(None, "exited")),
        ):
            self.assertEqual(inspector.linux_inspect(target), ([], []))

    def test_missing_script_operand_is_uncertain_only_while_candidate_is_live(self):
        missing = "/definitely-missing-coop-review/knowledge-git.py"
        with (
            mock.patch.object(inspector.os, "listdir", return_value=["101"]),
            mock.patch.object(
                inspector, "_linux_same_user_python", return_value=(True, None)
            ),
            mock.patch.object(
                inspector,
                "proc_argv",
                return_value=(["worker-python", missing], None),
            ),
            mock.patch.object(inspector, "_pid_exited", return_value=False),
        ):
            matches, uncertainties = inspector.linux_inspect("/tmp/knowledge-git.py")
            self.assertEqual(matches, [])
            self.assertIn("script path unresolved", uncertainties[0])
        with (
            mock.patch.object(inspector.os, "listdir", return_value=["101"]),
            mock.patch.object(
                inspector, "_linux_same_user_python", return_value=(True, None)
            ),
            mock.patch.object(
                inspector,
                "proc_argv",
                return_value=(["worker-python", missing], None),
            ),
            mock.patch.object(inspector, "_pid_exited", return_value=True),
        ):
            self.assertEqual(inspector.linux_inspect("/tmp/knowledge-git.py"), ([], []))

        uid = os.geteuid()
        ps_result = SimpleNamespace(returncode=0, stdout="101 %d\n" % uid, stderr="")
        with (
            mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
            mock.patch.object(
                inspector,
                "macos_process_executable",
                return_value=("/usr/bin/python3", None),
            ),
            mock.patch.object(
                inspector,
                "macos_process_argv",
                return_value=["worker-python", missing],
            ),
            mock.patch.object(inspector, "_macos_pid_exists", return_value=True),
        ):
            self.assertIn(
                "script path unresolved",
                inspector.macos_inspect("/tmp/knowledge-git.py")[1][0],
            )
        with (
            mock.patch.object(inspector.subprocess, "run", return_value=ps_result),
            mock.patch.object(
                inspector,
                "macos_process_executable",
                return_value=("/usr/bin/python3", None),
            ),
            mock.patch.object(
                inspector,
                "macos_process_argv",
                return_value=["worker-python", missing],
            ),
            mock.patch.object(inspector, "_macos_pid_exists", return_value=False),
        ):
            self.assertEqual(inspector.macos_inspect("/tmp/knowledge-git.py"), ([], []))

    def test_script_replacement_during_resolution_is_uncertain(self):
        first = SimpleNamespace(st_dev=1, st_ino=10, st_mode=0o100644)
        replacement = SimpleNamespace(st_dev=1, st_ino=11, st_mode=0o100644)
        with (
            mock.patch.object(
                inspector.os, "stat", side_effect=(first, replacement, replacement)
            ),
            mock.patch.object(inspector.os.path, "realpath", return_value="/resolved"),
        ):
            resolved, error = inspector._resolve_existing_regular_script("/operand")
        self.assertIsNone(resolved)
        self.assertIn("changed while resolving", error)
        with mock.patch.object(
            inspector.os, "stat", side_effect=PermissionError("denied")
        ):
            resolved, error = inspector._resolve_existing_regular_script("/unreadable")
        self.assertIsNone(resolved)
        self.assertIn("denied", error)

    def test_retargetable_and_nonmatching_symlink_operands_are_uncertain(self):
        for path in ("/proc/123/fd/7", "/proc/self/fd/7", "/dev/fd/7"):
            resolved, error = inspector._resolve_existing_regular_script(
                path, "/target/knowledge-git.py"
            )
            self.assertIsNone(resolved)
            self.assertIn("retargetable", error)
        with tempfile.TemporaryDirectory(prefix="coop fd alias ") as directory:
            alias = Path(directory) / "knowledge-git.py"
            alias.symlink_to("/dev/fd/7")
            resolved, error = inspector._resolve_existing_regular_script(
                str(alias), "/target/knowledge-git.py"
            )
            self.assertIsNone(resolved)
            self.assertIn("retargetable", error)
        regular = SimpleNamespace(st_dev=1, st_ino=10, st_mode=0o100644)
        with (
            mock.patch.object(inspector.os, "stat", return_value=regular),
            mock.patch.object(
                inspector.os.path, "realpath", return_value="/elsewhere/decoy.py"
            ),
        ):
            resolved, error = inspector._resolve_existing_regular_script(
                "/alias/knowledge-git.py", "/target/knowledge-git.py"
            )
        self.assertIsNone(resolved)
        self.assertIn("non-target", error)

    def test_process_group_scope_ignores_ambient_uncertainty_but_keeps_owned_uncertainty(
        self,
    ):
        target = "/tmp/knowledge-git.py"
        with (
            mock.patch.object(inspector.os, "listdir", return_value=["101", "102"]),
            mock.patch.object(inspector.os, "geteuid", return_value=1000),
            mock.patch.object(
                inspector.os,
                "getpgid",
                side_effect=lambda pid: 900 if pid == 101 else 700,
            ),
            mock.patch.object(
                inspector,
                "_linux_same_user_python",
                return_value=(None, "exe unreadable"),
            ) as identity,
        ):
            self.assertEqual(
                inspector.linux_inspect(target, 700), ([], ["exe unreadable"])
            )
        identity.assert_called_once_with(102, 1000)
        with (
            mock.patch.object(inspector.os, "listdir", return_value=["103"]),
            mock.patch.object(inspector.os, "geteuid", return_value=1000),
            mock.patch.object(
                inspector.os, "getpgid", side_effect=PermissionError("denied")
            ),
            mock.patch.object(inspector.os, "kill", return_value=None),
        ):
            matches, uncertainties = inspector.linux_inspect(target, 700)
        self.assertEqual(matches, [])
        self.assertIn(
            "process-group identity unavailable for pid 103", uncertainties[0]
        )

    def test_linux_unreadable_executable_is_uncertain_regardless_of_name(self):
        uid = os.geteuid()
        status = "Name:\tworker-alias\nUid:\t%d\t%d\t%d\t%d\n" % (
            uid,
            uid,
            uid,
            uid,
        )
        with mock.patch.object(
            inspector,
            "_linux_read",
            side_effect=((status, None), (None, "exe unreadable for pid 101: denied")),
        ):
            self.assertEqual(
                inspector._linux_same_user_python(101, uid),
                (None, "exe unreadable for pid 101: denied"),
            )

    def test_inspector_main_distinguishes_present_uncertain_and_absent(self):
        old_argv = inspector.sys.argv
        inspector.sys.argv = ["inspector", "/tmp/knowledge-git.py"]
        try:
            with mock.patch.object(
                inspector, "linux_inspect", return_value=([101], [])
            ):
                self.assertEqual(inspector.main(), 1)
            with mock.patch.object(
                inspector, "linux_inspect", return_value=([], ["denied"])
            ):
                self.assertEqual(inspector.main(), 2)
            with mock.patch.object(inspector, "linux_inspect", return_value=([], [])):
                self.assertEqual(inspector.main(), 0)
        finally:
            inspector.sys.argv = old_argv

    @unittest.skipUnless(os.path.isdir("/proc"), "Linux live process inspection")
    def test_live_absolute_relative_spaced_and_option_invocations(self):
        helper = ROOT / "scripts" / "knowledge-git.py"
        with tempfile.TemporaryDirectory(prefix="coop helper space ") as directory:
            spaced = Path(directory) / "knowledge-git.py"
            spaced.symlink_to(helper)
            cases = (
                ([str(helper)], None),
                (["knowledge-git.py"], str(helper.parent)),
                ([str(spaced)], None),
                (["-EW", "ignore", str(helper)], None),
                (["-Wignore", str(helper)], None),
                (["-Xdev", str(helper)], None),
                (["--", str(helper)], None),
            )
            for prefix, cwd in cases:
                command = (
                    [sys.executable]
                    + prefix
                    + [
                        "--timeout-seconds",
                        "3",
                        "--",
                        sys.executable,
                        "-c",
                        "import time;time.sleep(2)",
                    ]
                )
                proc = subprocess.Popen(
                    command,
                    cwd=cwd,
                    env={**os.environ, "GIT_SSH_COMMAND": "ssh -o BatchMode=yes"},
                )
                try:
                    time.sleep(0.15)
                    with mock.patch.object(
                        inspector.os, "listdir", return_value=[str(proc.pid)]
                    ):
                        matches, uncertainties = inspector.linux_inspect(
                            str(helper.resolve())
                        )
                    self.assertIn(proc.pid, matches, command)
                    self.assertEqual(uncertainties, [], command)
                finally:
                    proc.wait(timeout=5)

    @unittest.skipUnless(os.path.isdir("/proc"), "Linux live process inspection")
    def test_live_execve_argv0_alias_is_detected_by_inspector_cli(self):
        helper = ROOT / "scripts" / "knowledge-git.py"
        command = [
            "worker-python",
            str(helper),
            "--timeout-seconds",
            "4",
            "--",
            sys.executable,
            "-c",
            "import time; time.sleep(1)",
        ]
        proc = subprocess.Popen(command, executable=sys.executable)
        try:
            time.sleep(0.15)
            observed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "tests" / "knowledge-git-process-inspector.py"),
                    str(helper.resolve()),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=3,
                check=False,
            )
            self.assertEqual(observed.returncode, 1, observed.stderr)
            self.assertIn(str(proc.pid), observed.stderr)
        finally:
            proc.wait(timeout=5)

    @unittest.skipUnless(os.path.isdir("/proc"), "Linux live process inspection")
    def test_live_deleted_symlink_script_operand_is_uncertain(self):
        helper = ROOT / "scripts" / "knowledge-git.py"
        with tempfile.TemporaryDirectory(prefix="coop deleted alias ") as directory:
            alias = Path(directory) / "knowledge-git.py"
            alias.symlink_to(helper)
            proc = subprocess.Popen(
                [
                    sys.executable,
                    str(alias),
                    "--timeout-seconds",
                    "4",
                    "--",
                    sys.executable,
                    "-c",
                    "import time; time.sleep(1)",
                ]
            )
            try:
                time.sleep(0.15)
                alias.unlink()
                matches, uncertainties = inspector.linux_inspect(str(helper.resolve()))
                self.assertNotIn(proc.pid, matches)
                self.assertTrue(
                    any(
                        "script path unresolved for pid %d" % proc.pid in item
                        for item in uncertainties
                    ),
                    uncertainties,
                )
            finally:
                proc.wait(timeout=5)

    @unittest.skipUnless(os.path.isdir("/proc"), "Linux live process inspection")
    def test_live_different_regular_python_script_is_absent_not_uncertain(self):
        target = str((ROOT / "scripts" / "knowledge-git.py").resolve())
        with tempfile.TemporaryDirectory(prefix="coop different script ") as directory:
            script = Path(directory) / "different.py"
            script.write_text("import time; time.sleep(2)\n", encoding="utf-8")
            proc = subprocess.Popen([sys.executable, str(script)])
            try:
                time.sleep(0.1)
                with mock.patch.object(
                    inspector.os, "listdir", return_value=[str(proc.pid)]
                ):
                    self.assertEqual(inspector.linux_inspect(target), ([], []))
            finally:
                proc.terminate()
                proc.wait(timeout=5)

    @unittest.skipUnless(os.path.isdir("/proc"), "Linux live process inspection")
    def test_live_proc_fd_retarget_never_becomes_absent_while_helper_lives(self):
        helper = ROOT / "scripts" / "knowledge-git.py"
        decoy = ROOT / "tests" / "knowledge-git.test.py"
        helper_fd = os.open(helper, os.O_RDONLY)
        decoy_fd = None
        operand = "/proc/%d/fd/%d" % (os.getpid(), helper_fd)
        proc = subprocess.Popen(
            [
                sys.executable,
                operand,
                "--timeout-seconds",
                "4",
                "--",
                sys.executable,
                "-c",
                "import time; time.sleep(2)",
            ],
            env={**os.environ, "GIT_SSH_COMMAND": "ssh -o BatchMode=yes"},
        )
        try:
            time.sleep(0.15)
            with mock.patch.object(
                inspector.os, "listdir", return_value=[str(proc.pid)]
            ):
                before = inspector.linux_inspect(str(helper.resolve()))
            self.assertIsNone(proc.poll())
            self.assertEqual(before[0], [])
            self.assertTrue(any("retargetable" in item for item in before[1]), before)

            decoy_fd = os.open(decoy, os.O_RDONLY)
            os.dup2(decoy_fd, helper_fd)
            with mock.patch.object(
                inspector.os, "listdir", return_value=[str(proc.pid)]
            ):
                after = inspector.linux_inspect(str(helper.resolve()))
            self.assertIsNone(proc.poll())
            self.assertEqual(after[0], [])
            self.assertTrue(any("retargetable" in item for item in after[1]), after)
        finally:
            os.close(helper_fd)
            if decoy_fd is not None:
                os.close(decoy_fd)
            proc.wait(timeout=5)

    @unittest.skipUnless(os.path.isdir("/proc"), "Linux live process inspection")
    def test_live_prctl_alias_unreadable_executable_fails_closed_until_exit(self):
        code = (
            "import ctypes,time;libc=ctypes.CDLL(None);"
            "libc.prctl(15,b'worker-alias',0,0,0);"
            "libc.prctl(4,0,0,0,0);print('ready',flush=True);time.sleep(2)"
        )
        run_as_uid = 65534 if os.geteuid() == 0 else os.geteuid()

        def drop_uid():
            if os.geteuid() == 0:
                os.setuid(run_as_uid)

        with tempfile.TemporaryDirectory(prefix="coop inspector ") as directory:
            os.chmod(directory, 0o755)
            inspector_copy = Path(directory) / "inspector.py"
            inspector_copy.write_bytes(
                (ROOT / "tests" / "knowledge-git-process-inspector.py").read_bytes()
            )
            inspector_copy.chmod(0o755)
            proc = subprocess.Popen(
                [sys.executable, "-c", code],
                stdout=subprocess.PIPE,
                text=True,
                preexec_fn=drop_uid,
            )
            try:
                self.assertIsNotNone(proc.stdout)
                self.assertEqual(proc.stdout.readline().strip(), "ready")
                observed = subprocess.run(
                    [sys.executable, str(inspector_copy), "/tmp/knowledge-git.py"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=3,
                    check=False,
                    preexec_fn=drop_uid,
                )
                self.assertEqual(observed.returncode, 2, observed.stderr)
                self.assertIn("exe", observed.stderr)
                self.assertIn(str(proc.pid), observed.stderr)
                self.assertIsNone(proc.poll())
            finally:
                proc.terminate()
                proc.wait(timeout=5)
                if proc.stdout is not None:
                    proc.stdout.close()
            observed = subprocess.run(
                [sys.executable, str(inspector_copy), "/tmp/knowledge-git.py"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=3,
                check=False,
                preexec_fn=drop_uid,
            )
            self.assertEqual(observed.returncode, 0, observed.stderr)

    @unittest.skipUnless(os.path.isdir("/proc"), "Linux live process inspection")
    def test_live_dash_c_and_dash_m_decoys_are_not_matches(self):
        target = str((ROOT / "scripts" / "knowledge-git.py").resolve())
        commands = (
            [sys.executable, "-c", "import time;time.sleep(1)", target],
            [
                sys.executable,
                "-m",
                "timeit",
                "-n",
                "1",
                "-r",
                "1",
                "import time;time.sleep(1)",
                "# " + target,
            ],
        )
        for command in commands:
            proc = subprocess.Popen(command)
            try:
                time.sleep(0.1)
                with mock.patch.object(
                    inspector.os, "listdir", return_value=[str(proc.pid)]
                ):
                    matches, uncertainties = inspector.linux_inspect(target)
                self.assertNotIn(proc.pid, matches)
                self.assertEqual(uncertainties, [])
            finally:
                proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
