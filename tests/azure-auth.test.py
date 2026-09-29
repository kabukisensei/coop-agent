#!/usr/bin/env python3
"""lib/azure_auth.py: how onboarding and `coop init` find and run the Azure CLI.

The user-hit bug (master plan H2): on Windows the Azure CLI is az.cmd, often under
"C:\\Program Files (x86)\\...". subprocess cannot start a bare "az" there, and
`cmd.exe /c "<path>" args` splits a "(x86)" path, so tenant discovery and sign-in
failed before a browser ever opened. Pure vectors run on every OS; the default
Windows path (COOP_AZ_BIN unset, az.cmd in "Program Files (x86)") runs on the
Windows leg. Only the fake az (tests/fixtures/fake-az.mjs) is ever started.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("azure_auth", ROOT / "lib" / "azure_auth.py")
azure_auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(azure_auth)
FAKE_AZ = ROOT / "tests" / "fixtures" / "fake-az.mjs"

X86_AZ = r"C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"

# 1. The exact cmd.exe line for an "(x86)" az.cmd: /s keeps the quoted path whole.
expected = (
    '"C:\\Windows\\System32\\cmd.exe" /d /s /c '
    '"call "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd" account show --output json"'
)
got = azure_auth.windows_az_command(r"C:\Windows", X86_AZ, ("account", "show", "--output", "json"))
assert got == expected, got
print('  OK  "(x86)" az.cmd runs through cmd.exe /d /s /c "call "<path>" args"')


# 2. PATH resolution on Windows: absolute folders only, az.cmd > az.exe > az.bat.
def isfile_of(*present):
    wanted = {p.lower() for p in present}
    return lambda candidate: os.fspath(candidate).lower() in wanted


path_value = r'bin;;.;"C:\Program Files (x86)\Azure\wbin";C:\Later'
assert azure_auth.windows_az_path(
    path_value, isfile_of(r"bin\az.cmd", r".\az.cmd", r"C:\Program Files (x86)\Azure\wbin\az.bat", r"C:\Later\az.cmd")
) == r"C:\Program Files (x86)\Azure\wbin\az.bat", "relative/empty entries must be ignored; folder order wins"
folder = r"C:\Tools"
assert azure_auth.windows_az_path(folder, isfile_of(folder + r"\az.bat", folder + r"\az.exe", folder + r"\az.cmd")) == folder + r"\az.cmd"
assert azure_auth.windows_az_path(folder, isfile_of(folder + r"\az.bat", folder + r"\az.exe")) == folder + r"\az.exe"
assert azure_auth.windows_az_path(folder, isfile_of(folder + r"\az.bat")) == folder + r"\az.bat"
assert azure_auth.windows_az_path(r"C:\R&D\bin;C:\Tools", isfile_of(r"C:\R&D\bin\az.cmd", r"C:\Tools\az.exe")) == r"C:\Tools\az.exe", \
    "a folder with cmd.exe metacharacters must be skipped"
assert azure_auth.windows_az_path("", isfile_of()) is None
print("  OK  Windows PATH scan: absolute folders only, az.cmd > az.exe > az.bat, unsafe folders skipped")

# 3. azure_argv on Windows: the explicit cmd.exe string for .cmd/.bat, a list otherwise.
with mock.patch.object(azure_auth.sys, "platform", "win32"), mock.patch.dict(
    os.environ, {"PATH": r"C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin", "SystemRoot": r"C:\Windows"}
), mock.patch("os.path.isfile", isfile_of(X86_AZ)):
    os.environ.pop("COOP_AZ_BIN", None)
    assert azure_auth.azure_cli_available()
    assert azure_auth.azure_argv("account", "show", "--output", "json") == expected
    # An unsafe COOP_AZ_BIN is never spliced into a cmd.exe line.
    os.environ["COOP_AZ_BIN"] = r"C:\R&D\az.cmd"
    with mock.patch.object(azure_auth.shutil, "which", lambda *_a, **_k: None):
        assert azure_auth.azure_argv("account", "show") == [r"C:\R&D\az.cmd", "account", "show"]
print("  OK  azure_argv builds the cmd.exe line for az.cmd and refuses unsafe paths")

# 4. COOP_AZ_BIN (the test seam) wins over PATH, and an unresolvable one never
#    falls back to the az on PATH.
with tempfile.TemporaryDirectory() as tmp:
    override = Path(tmp) / "az-override"
    override.write_text("", encoding="ascii")
    with mock.patch.object(azure_auth.sys, "platform", "win32"), mock.patch.dict(
        os.environ, {"PATH": r"C:\Tools", "COOP_AZ_BIN": str(override)}
    ), mock.patch("os.path.isfile", isfile_of(r"C:\Tools\az.cmd", str(override))):
        assert azure_auth._resolve_az() == str(override)
    with mock.patch.dict(os.environ, {"COOP_AZ_BIN": "/nonexistent/az"}):
        assert not azure_auth.azure_cli_available()
        assert azure_auth.azure_argv("login")[0] == "/nonexistent/az"
print("  OK  COOP_AZ_BIN wins, and an unresolvable one never falls back to PATH")


# 5. Sign-in through the fake az: ok, tenant returned, subscription picker off.
def fake_az(folder: Path) -> Path:
    node = shutil.which("node")
    assert node, "node is required for the fake az"
    folder.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        wrapper = folder / "az.cmd"
        wrapper.write_text(f'@"{node}" "{FAKE_AZ}" %*\r\n', encoding="ascii")
    else:
        wrapper = folder / "az"
        wrapper.write_text(f'#!/bin/sh\nexec "{node}" "{FAKE_AZ}" "$@"\n', encoding="utf-8")
        wrapper.chmod(0o755)
    return wrapper


def check_login(state: Path, label: str) -> None:
    ok, tenants = azure_auth.login_azure()
    assert ok, f"{label}: login_azure() must succeed"
    assert "tenant-on-path" in [t["tenant_id"] for t in tenants], (label, tenants)
    log = (state / "argv.log").read_text(encoding="utf-8").splitlines()
    assert "login --allow-no-subscriptions --output json LXV2=off" in log, (label, log)


with tempfile.TemporaryDirectory() as tmp:
    state = Path(tmp) / "az-state"
    state.mkdir()
    wrapper = fake_az(Path(tmp) / "bin")
    with mock.patch.dict(os.environ, {"COOP_AZ_BIN": str(wrapper), "COOP_TEST_AZ_STATE": str(state)}):
        os.environ.pop("AZURE_CORE_LOGIN_EXPERIENCE_V2", None)
        check_login(state, "COOP_AZ_BIN")
print("  OK  login_azure() runs az with AZURE_CORE_LOGIN_EXPERIENCE_V2=off and returns the tenant")

# 5b. scripts/ado_lib.py mints its Azure DevOps token through the same resolver
#     (H2b, #91). It ran a bare "az", which Windows cannot start when the Azure CLI
#     is az.cmd; its tenant_id comes from a private config file, so a value that is
#     not a GUID or domain name must never reach the cmd.exe line.
sys.path.insert(0, str(ROOT / "scripts"))
import ado_lib  # noqa: E402

ado_lib._import_azure_helpers()  # import before sys.platform is faked below
ADO_TENANT = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd"
ado_calls = []


def fake_ado_run(cmd, **_kwargs):
    ado_calls.append(cmd)
    return subprocess.CompletedProcess(cmd, 0, stdout="ado-token\n", stderr="")


with mock.patch.object(azure_auth.sys, "platform", "win32"), mock.patch.dict(
    os.environ, {"PATH": r"C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin", "SystemRoot": r"C:\Windows"}
), mock.patch("os.path.isfile", isfile_of(X86_AZ)), mock.patch.object(ado_lib.subprocess, "run", fake_ado_run):
    os.environ.pop("COOP_AZ_BIN", None)
    assert ado_lib.mint_azcli_token(ADO_TENANT) == "ado-token"
    for bad in ("x&calc", "a b", "tenant-aaa", "TODO"):
        try:
            ado_lib.mint_azcli_token(bad)
        except ado_lib.AdoError as exc:
            assert bad not in str(exc), exc
        else:
            raise AssertionError(f"ado_lib accepted tenant_id {bad!r}")
assert ado_calls == [
    '"C:\\Windows\\System32\\cmd.exe" /d /s /c '
    '"call "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd" account get-access-token '
    f'--resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv --tenant {ADO_TENANT}"'
], ado_calls
print('  OK  ado_lib mints through the shared resolver (az.cmd under "(x86)") and rejects unsafe tenant ids')

# 6. Windows only: the default path. COOP_AZ_BIN unset, az.cmd under
#    "Program Files (x86)" on PATH, exactly where the Azure CLI installs.
if sys.platform == "win32":
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "az-state"
        state.mkdir()
        wbin = Path(tmp) / "Program Files (x86)" / "Microsoft SDKs" / "Azure" / "CLI2" / "wbin"
        wrapper = fake_az(wbin)
        env = {"PATH": str(wbin) + os.pathsep + os.environ.get("PATH", ""), "COOP_TEST_AZ_STATE": str(state)}
        with mock.patch.dict(os.environ, env):
            os.environ.pop("COOP_AZ_BIN", None)
            os.environ.pop("AZURE_CORE_LOGIN_EXPERIENCE_V2", None)
            assert azure_auth._resolve_az().lower() == str(wrapper).lower(), azure_auth._resolve_az()
            assert isinstance(azure_auth.azure_argv("account", "show"), str)
            tenants = azure_auth.discover_azure_tenants()
            assert [t["tenant_id"] for t in tenants] == ["tenant-on-path"], tenants
            check_login(state, "Program Files (x86)")
    print('  OK  Windows default path: az.cmd in "Program Files (x86)" discovers the tenant and signs in')
else:
    print("  –   Windows default-path az.cmd check runs on the Windows legs")

print("  azure-auth tests passed")
