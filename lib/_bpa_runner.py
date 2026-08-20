import sys, os, subprocess, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _yaml


def _parse_finding(item):
    """Map one `te bpa run` JSON violation item onto the coop finding shape.
    Tolerant of preview-schema drift: accepts several common key spellings."""
    rule = item.get("ruleId") or item.get("rule") or item.get("id") or item.get("name") or ""
    sev = str(item.get("severity") or item.get("level") or "").lower()
    if sev not in ("error", "warning", "info"):
        sev = "info"
    obj = item.get("object") or item.get("path") or item.get("target") or item.get("table") or ""
    msg = item.get("message") or item.get("description") or item.get("text") or ""
    return {"rule": rule, "severity": sev, "file": "", "object": obj, "message": msg}


def _extract_findings(out):
    """Parse `te bpa run` stdout: JSON first, then a text-scan fallback."""
    findings = []
    if not out or not out.strip():
        return findings
    data = None
    try:
        data = json.loads(out)
    except Exception:
        data = None
    if isinstance(data, dict):
        for key in ("findings", "violations", "results", "issues"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            data = None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                f = _parse_finding(item)
                if f["rule"] or f["object"] or f["message"]:
                    findings.append(f)
        return findings
    # Text fallback (`te` text table or legacy TE2-style `-V` lines).
    for ln in out.split("\n"):
        ln = ln.strip()
        if not ln:
            continue
        m = re.match(r"^(.*?):\s*\[(.*?)\]\s*\((\w+)\)(?:\s+(.*))?$", ln)
        if m:
            sev = m.group(3).lower()
            if sev not in ("error", "warning", "info"):
                sev = "info"
            findings.append(
                {
                    "rule": m.group(2).strip(),
                    "severity": sev,
                    "file": "",
                    "object": m.group(1).strip(),
                    "message": (m.group(4) or "").strip(),
                }
            )
    return findings


def _run_bpa(te_exe, model, rules):
    """Run `te bpa run <model> -r <rules>` non-interactively. JSON output first;
    if that yields nothing (e.g. a preview build rejects --output-format for
    bpa run), retry once with default text output and parse that."""
    last_rc = 0
    for extra in (["--output-format", "json"], []):
        cmd = [te_exe, "bpa", "run", model, "-r", rules, "--non-interactive"] + extra
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        except Exception:
            return [], last_rc
        last_rc = res.returncode
        findings = _extract_findings(res.stdout or "")
        if findings or last_rc == 0:
            return findings, last_rc
    return [], last_rc


def main():
    if len(sys.argv) < 3:
        sys.exit(0)
    proj = sys.argv[1]
    out_json = sys.argv[2]
    scope_paths = sys.argv[3:]

    cfg = _yaml.load(proj)
    if not cfg:
        sys.exit(0)

    import shutil
    te = _yaml.dig(cfg, "tools.tabular_editor_cli") or {}
    te_enabled = str(te.get("enabled", "")).lower() == "true"
    te_exe = te.get("executable_path", "")
    if not te_exe or te_exe.lower().startswith("todo"):
        # The cross-platform Tabular Editor CLI only. During the preview it
        # requires a Tabular Editor account — users run `te auth login` once
        # (and rule files may need the te rule schema, not a TE2 export).
        te_exe = shutil.which("te") or ""
    te_rules = te.get("bpa_rules_path", "")

    if not te_enabled or not te_exe or not te_rules:
        sys.exit(0)

    if scope_paths:
        models = scope_paths
    else:
        models = []
        for sm in _yaml.dig(cfg, "power_bi.semantic_models") or []:
            v = sm.get("path", "") if isinstance(sm, dict) else ""
            if v and not v.lower().startswith("todo"):
                models.append(v)

    if not models:
        sys.exit(0)

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(proj)))

    all_findings = []
    summary = {"error": 0, "warning": 0, "info": 0}
    final_code = 0

    for model in models:
        abs_model = model if os.path.isabs(model) else os.path.join(base_dir, model)
        abs_rules = te_rules if os.path.isabs(te_rules) else os.path.join(base_dir, te_rules)

        if not os.path.exists(abs_model):
            continue

        findings, rc = _run_bpa(te_exe, abs_model, abs_rules)
        all_findings.extend(findings)
        if rc != 0:
            final_code = rc

    for f in all_findings:
        summary[f["severity"]] += 1

    report = {"tool": "bpa-review", "findings": all_findings, "summary": summary}

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    sys.exit(final_code)


if __name__ == "__main__":
    main()
