#!/usr/bin/env python3
"""Focused cross-platform tests for knowledge-git ownership contracts."""

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("knowledge_git", ROOT / "scripts" / "knowledge-git.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load scripts/knowledge-git.py")
kg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(kg)


class FakeProcess:
    pid = 4242


class KnowledgeGitOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop(kg._TEST_FAULT_ENV, None)

    def tearDown(self):
        self.env.stop()

    def windows_os(self):
        return SimpleNamespace(name="nt", environ=os.environ)

    def test_fault_seam_is_allowlisted_and_inert_by_default(self):
        self.assertFalse(kg._test_fault("job-create"))
        os.environ[kg._TEST_FAULT_ENV] = "__import__('os').system('false')"
        self.assertFalse(kg._test_fault("job-create"))
        for stage in kg._TEST_FAULTS:
            os.environ[kg._TEST_FAULT_ENV] = stage
            self.assertTrue(kg._test_fault(stage))

    def test_create_failure_reaches_adopt_and_stops_suspended_child(self):
        os.environ[kg._TEST_FAULT_ENV] = "job-create"
        with mock.patch.object(kg, "os", self.windows_os()), \
             mock.patch.object(kg, "_win_terminate_pid", return_value=(True, None)) as stop:
            ownership = kg.Ownership()
            ownership.adopt(FakeProcess())
        self.assertFalse(ownership.available)
        self.assertIn("test-job-create", ownership.unavailable_reason)
        stop.assert_called_once_with(FakeProcess.pid)

    def test_assignment_failure_reaches_adopt_and_closes_job(self):
        os.environ[kg._TEST_FAULT_ENV] = "job-assign"
        job = object()
        with mock.patch.object(kg, "os", self.windows_os()), \
             mock.patch.object(kg, "_win_job_create", return_value=(job, None)), \
             mock.patch.object(kg, "_win_terminate_pid", return_value=(True, None)) as stop, \
             mock.patch.object(kg, "_win_job_close", return_value=(True, None)) as close:
            ownership = kg.Ownership()
            ownership.adopt(FakeProcess())
        self.assertFalse(ownership.available)
        self.assertIn("test-job-assign", ownership.unavailable_reason)
        stop.assert_called_once_with(FakeProcess.pid)
        close.assert_called_once_with(job)

    def test_resume_failure_reaches_adopt_and_terminates_before_execution(self):
        os.environ[kg._TEST_FAULT_ENV] = "resume"
        job = object()
        with mock.patch.object(kg, "os", self.windows_os()), \
             mock.patch.object(kg, "_win_job_create", return_value=(job, None)), \
             mock.patch.object(kg, "_win_job_assign", return_value=(True, None)), \
             mock.patch.object(kg, "_win_job_terminate", return_value=(True, None)) as terminate, \
             mock.patch.object(kg, "_win_terminate_pid", return_value=(True, None)) as stop, \
             mock.patch.object(kg, "_win_job_close", return_value=(True, None)) as close:
            ownership = kg.Ownership()
            ownership.adopt(FakeProcess())
        self.assertFalse(ownership.available)
        self.assertIn("test-resume", ownership.unavailable_reason)
        terminate.assert_called_once_with(job)
        stop.assert_called_once_with(FakeProcess.pid)
        close.assert_called_once_with(job)

    def test_query_failure_is_uncertain_not_empty(self):
        os.environ[kg._TEST_FAULT_ENV] = "job-query"
        with mock.patch.object(kg, "os", self.windows_os()):
            ownership = kg.Ownership()
            ownership.job = object()
            self.assertEqual(ownership.wait_empty(kg.time.monotonic() + 1), kg.OWNERSHIP_UNCERTAIN)

    def test_probe_containment_failure_aborts_instead_of_guessing_transport(self):
        with mock.patch.object(kg, "run_bounded_capture", return_value=("unavailable", None)):
            state, value = kg.probe_core_ssh_command(["git", "status"], kg.time.monotonic() + 1)
        self.assertEqual((state, value), (kg.PROBE_OWNERSHIP_UNCERTAIN, None))

    def test_termination_and_close_faults_report_failure(self):
        with mock.patch.object(kg, "os", self.windows_os()):
            os.environ[kg._TEST_FAULT_ENV] = "job-terminate"
            self.assertEqual(kg._win_job_terminate(object())[0], False)
            os.environ[kg._TEST_FAULT_ENV] = "job-close"
            ownership = kg.Ownership()
            ownership.job = object()
            self.assertFalse(ownership.close())

    def test_failed_job_termination_closes_immediately_without_grace_wait_or_double_close(self):
        job = object()
        with mock.patch.object(kg, "os", self.windows_os()), \
             mock.patch.object(kg, "_win_job_terminate", return_value=(False, ("terminate", 5))) as terminate, \
             mock.patch.object(kg.subprocess, "run") as taskkill, \
             mock.patch.object(kg, "_win_job_close", return_value=(True, None)) as close:
            ownership = kg.Ownership()
            ownership.job = job
            ownership.child = FakeProcess()
            with mock.patch.object(ownership, "wait_empty") as wait_empty:
                self.assertEqual(
                    ownership.terminate_and_wait(kg.time.monotonic() + kg.CLEANUP_GRACE_SECONDS),
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


if __name__ == "__main__":
    unittest.main()
