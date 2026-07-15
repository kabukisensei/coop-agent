import sys, os, subprocess, json, re

def main():
    if len(sys.argv) < 3:
        sys.exit(0)
    proj = sys.argv[1]
    out_json = sys.argv[2]
    # Rest of args are scope paths (if any)
    scope_paths = sys.argv[3:]

    # Parse yaml for TE config
    try:
        with open(proj, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception:
        sys.exit(0)

    te_enabled = False
    te_exe = ""
    te_rules = ""
    models = []

    in_te = False
    in_pbi = False
    in_sm = False

    def scalar_val(s):
        s = s.strip()
        if s.startswith('"'):
            end = s.find('"', 1)
            if end != -1: return s[1:end]
        if s.startswith("'"):
            end = s.find("'", 1)
            if end != -1: return s[1:end]
        idx = s.find('#')
        if idx != -1: s = s[:idx].strip()
        return s

    for line in lines:
        raw = line.replace('\t', '  ')
        body = raw.strip()
        if not body or body.startswith('#'): continue
        indent = len(raw) - len(raw.lstrip())

        if indent == 2 and body.startswith('tabular_editor_cli:'):
            in_te = True; continue
        if indent <= 2 and in_te and not body.startswith('tabular_editor_cli:'):
            in_te = False

        if in_te:
            if body.startswith('enabled:'):
                te_enabled = scalar_val(body[8:]) == 'true'
            if body.startswith('executable_path:'):
                te_exe = scalar_val(body[16:])
            if body.startswith('bpa_rules_path:'):
                te_rules = scalar_val(body[15:])

        if indent == 0 and body.startswith('power_bi:'):
            in_pbi = True; continue
        if indent == 0 and in_pbi and not body.startswith('power_bi:'):
            in_pbi = False

        if in_pbi and indent == 2 and body.startswith('semantic_models:'):
            in_sm = True; continue
        if in_pbi and indent <= 2 and in_sm and not body.startswith('semantic_models:'):
            in_sm = False

        if in_sm and (body.startswith('path:') or body.startswith('- path:')):
            v = scalar_val(body[body.find('path:')+5:])
            if v and not v.lower().startswith('todo'):
                models.push(v) if hasattr(models, 'push') else models.append(v)

    if not te_enabled or not te_exe or not te_rules:
        sys.exit(0)

    if scope_paths:
        # If explicit scope provided, we only use models that match the scope
        # Wait, if scope is provided, we just pass scope to Tabular Editor if they are models
        # For simplicity, if scope_paths are given, we use them as models.
        models = scope_paths

    if not models:
        sys.exit(0)

    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(proj)))
    
    all_findings = []
    summary = {'error': 0, 'warning': 0, 'info': 0}
    final_code = 0

    for model in models:
        abs_model = model if os.path.isabs(model) else os.path.join(base_dir, model)
        abs_rules = te_rules if os.path.isabs(te_rules) else os.path.join(base_dir, te_rules)

        if not os.path.exists(abs_model):
            continue

        cmd = [te_exe, abs_model, "-A", abs_rules, "-V"]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0: final_code = res.returncode
            out = res.stdout
        except Exception:
            continue

        # Parse BPA
        for ln in out.split('\n'):
            ln = ln.strip()
            if not ln: continue
            # Model\Tables\Sales: [Rule] (Warning) Msg
            m = re.match(r'^(.*?):\s*\[(.*?)\]\s*\((\w+)\)(?:\s+(.*))?$', ln)
            if m:
                obj = m.group(1).strip()
                rule = m.group(2).strip()
                sevRaw = m.group(3).lower()
                msg = m.group(4)
                msg = msg.strip() if msg else ""
                if sevRaw not in ['error', 'warning', 'info']: sevRaw = 'info'
                all_findings.append({
                    'rule': rule,
                    'severity': sevRaw,
                    'file': '',
                    'object': obj,
                    'message': msg
                })
                summary[sevRaw] += 1

    report = {
        'tool': 'bpa-review',
        'findings': all_findings,
        'summary': summary
    }

    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
    sys.exit(final_code)

if __name__ == '__main__':
    main()
