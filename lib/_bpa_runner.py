import sys, os, subprocess, json, re

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _yaml


def main():
    if len(sys.argv) < 3:
        sys.exit(0)
    proj = sys.argv[1]
    out_json = sys.argv[2]
    scope_paths = sys.argv[3:]

    cfg = _yaml.load(proj)
    if not cfg:
        sys.exit(0)

    te = _yaml.dig(cfg, "tools.tabular_editor_cli") or {}
    te_enabled = str(te.get("enabled", "")).lower() == "true"
    te_exe = te.get("executable_path", "")
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

        cmd = [te_exe, abs_model, "-A", abs_rules, "-V"]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                final_code = res.returncode
            out = res.stdout
        except Exception:
            continue

        for ln in out.split("\n"):
            ln = ln.strip()
            if not ln:
                continue
            m = re.match(r"^(.*?):\s*\[(.*?)\]\s*\((\w+)\)(?:\s+(.*))?$", ln)
            if m:
                obj = m.group(1).strip()
                rule = m.group(2).strip()
                sev_raw = m.group(3).lower()
                msg = m.group(4)
                msg = msg.strip() if msg else ""
                if sev_raw not in ["error", "warning", "info"]:
                    sev_raw = "info"
                all_findings.append(
                    {
                        "rule": rule,
                        "severity": sev_raw,
                        "file": "",
                        "object": obj,
                        "message": msg,
                    }
                )
                summary[sev_raw] += 1

    report = {"tool": "bpa-review", "findings": all_findings, "summary": summary}

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    sys.exit(final_code)


if __name__ == "__main__":
    main()
