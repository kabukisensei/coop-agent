#!/usr/bin/env python3
"""fleet-digest — Fleet health watchdog digest for coop.

Reads published `coop doctor --json --publish` snapshots from fleet.publish_dir,
aggregates them into a single markdown or HTML table, and highlights:
 - Failures and warnings (with the failing check names)
 - Tool versions vs the expected tested_with versions
 - Stale check-ins (>7 days)

Usage:
  fleet-digest.py [--config PATH] [--format md|html] [--send] [--dry-run] [--verbose]
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
import ado_lib as A  # reusing GraphMailer
import _yaml

def _days_since(iso, now):
    if not iso: return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
        return max(0, (now - dt).days)
    except ValueError:
        return None

def main(argv):
    ap = argparse.ArgumentParser(prog="fleet-digest", description="Fleet health digest.")
    ap.add_argument("--config", help="config path (default: ~/.coop/config)")
    ap.add_argument("--format", choices=("md", "html"), default="md")
    ap.add_argument("--send", action="store_true", help="send email via Microsoft Graph")
    ap.add_argument("--dry-run", action="store_true", help="print only, send nothing (default)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    coop_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    def_path = os.path.join(coop_root, "config", "defaults.yml")
    defs = _yaml.load(def_path) if os.path.isfile(def_path) else {}

    cfg_path = args.config or os.path.expanduser("~/.coop/config")
    cfg = _yaml.load(cfg_path) if os.path.isfile(cfg_path) else {}

    pub_dir = _yaml.dig(cfg, "fleet.publish_dir") or _yaml.dig(defs, "fleet.publish_dir")
    if not pub_dir:
        sys.stderr.write("fleet.publish_dir not configured in ~/.coop/config or config/defaults.yml\n")
        return 1

    if not os.path.isdir(pub_dir):
        sys.stderr.write(f"fleet.publish_dir '{pub_dir}' is not a valid directory\n")
        return 1

    tested_with = defs.get("tested_with") or {}

    now = datetime.now(timezone.utc)
    machines = []
    
    for fname in os.listdir(pub_dir):
        if not fname.endswith(".json"): continue
        path = os.path.join(pub_dir, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            machines.append(data)
        except Exception as e:
            if args.verbose: sys.stderr.write(f"Error reading {fname}: {e}\n")

    machines.sort(key=lambda m: (m.get("hostname", ""), m.get("user", "")))

    if args.format == "html":
        out = _render_html(machines, now, tested_with)
    else:
        out = _render_md(machines, now, tested_with)

    sending = args.send and not args.dry_run
    if sending:
        sender_cfg = cfg.get("sender") or _yaml.dig(defs, "sender")
        rec = _yaml.dig(cfg, "fleet.recipients") or _yaml.dig(defs, "fleet.recipients") or {}
        if not sender_cfg:
            sys.stderr.write("cannot --send: missing sender config\n")
            return 1
        
        # Load GraphMailer from ado-digest.py
        import importlib.util
        spec = importlib.util.spec_from_file_location("ado_digest", os.path.join(coop_root, "scripts", "ado-digest.py"))
        ado_digest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ado_digest)
        
        mailer = ado_digest.GraphMailer(sender_cfg)
        try:
            mailer.validate()
        except Exception as exc:
            sys.stderr.write(f"mailer validation failed: {exc}\n")
            return 1

        subject = f"Fleet Health Digest ({now.strftime('%Y-%m-%d')})"
        html_body = _render_html(machines, now, tested_with)
        try:
            mailer.send(subject, html_body, rec.get("to"), rec.get("cc"))
            sys.stderr.write(f"Sent fleet digest to {', '.join(rec.get('to') or [])}\n")
        except Exception as exc:
            sys.stderr.write(f"Send failed: {exc}\n")
            return 1
    else:
        sys.stdout.write(out + "\n")

    return 0

def _render_md(machines, now, tested_with):
    lines = ["# Fleet Health Digest", ""]
    lines.append(f"_Generated {now.strftime('%Y-%m-%d %H:%M UTC')}_")
    lines.append("")
    lines.append("| Machine | User | Last Check-in | Failures | Warnings | Versions |")
    lines.append("|---------|------|--------------:|----------|----------|----------|")

    for m in machines:
        days = _days_since(m.get("timestamp"), now)
        days_str = f"{days}d ago" if days is not None else "unknown"
        if days is not None and days > 7:
            days_str += " ⚠ stale"

        fail_count = m.get("fail", 0)
        warn_count = m.get("warn", 0)

        fails = [c["name"] for c in m.get("checks", []) if c.get("status") == "fail"]
        warns = [c["name"] for c in m.get("checks", []) if c.get("status") == "warn"]

        f_str = f"**{fail_count}** ({', '.join(fails)})" if fail_count else "0"
        w_str = f"{warn_count} ({', '.join(warns)})" if warn_count else "0"

        cv = m.get("coop_version", "unknown")
        pv = m.get("pi_version", "unknown")
        
        pv_expected = tested_with.get("pi")
        if pv_expected and pv != "unknown" and pv != pv_expected:
            pv_str = f"{pv} (⚠ != {pv_expected})"
        else:
            pv_str = pv
            
        # extract tool versions from check names: "coop-data-doc  (0.33.0)"
        import re
        tool_mismatches = []
        for chk in m.get("checks", []):
            name = chk.get("name", "")
            match = re.match(r'^([\w\-]+)\s+\(([^)]+)\)$', name)
            if match:
                tool_bin = match.group(1)
                tool_ver = match.group(2)
                # tested_with keys have underscores: "coop_data_doc"
                tw_key = tool_bin.replace("-", "_")
                if tool_bin == "fab": tw_key = "ms_fabric_cli"
                if tw_key in tested_with and tool_ver != tested_with[tw_key]:
                    tool_mismatches.append(f"{tool_bin} {tool_ver} (⚠ != {tested_with[tw_key]})")
        
        if tool_mismatches:
            pv_str += "<br>" + "<br>".join(tool_mismatches)
        
        lines.append(f"| {m.get('hostname', 'unknown')} | {m.get('user', 'unknown')} | {days_str} | {f_str} | {w_str} | coop {cv}, pi {pv_str} |")

    return "\n".join(lines)

def _render_html(machines, now, tested_with):
    css_td = 'style="padding:4px 8px;border:1px solid #d0d7de;font-family:Segoe UI,Arial,sans-serif;font-size:13px"'
    css_th = 'style="padding:4px 8px;border:1px solid #d0d7de;background:#00416b;color:#fff;font-family:Segoe UI,Arial,sans-serif;font-size:13px;text-align:left"'
    
    html = ['<div style="font-family:Segoe UI,Arial,sans-serif;color:#24292f">']
    html.append('<h2 style="color:#00416b;margin:0 0 4px">Fleet Health Digest</h2>')
    html.append(f'<div style="color:#57606a;font-size:12px;margin-bottom:12px">Generated {now.strftime("%Y-%m-%d %H:%M UTC")}</div>')

    html.append('<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:16px">')
    html.append(f'<tr><th {css_th}>Machine</th><th {css_th}>User</th><th {css_th}>Last Check-in</th><th {css_th}>Failures</th><th {css_th}>Warnings</th><th {css_th}>Versions</th></tr>')

    for m in machines:
        days = _days_since(m.get("timestamp"), now)
        days_str = f"{days}d ago" if days is not None else "unknown"
        if days is not None and days > 7:
            days_str += ' <b style="color:#b26a00">⚠ stale</b>'

        fail_count = m.get("fail", 0)
        warn_count = m.get("warn", 0)

        fails = [c["name"] for c in m.get("checks", []) if c.get("status") == "fail"]
        warns = [c["name"] for c in m.get("checks", []) if c.get("status") == "warn"]

        f_str = f'<b style="color:#cf222e">{fail_count}</b><br><small>{", ".join(fails)}</small>' if fail_count else "0"
        w_str = f'<span style="color:#b26a00">{warn_count}</span><br><small>{", ".join(warns)}</small>' if warn_count else "0"

        pv_expected = tested_with.get("pi")
        if pv_expected and pv != "unknown" and pv != pv_expected:
            pv_str = f'{pv} <b style="color:#cf222e">(⚠ != {pv_expected})</b>'
        else:
            pv_str = pv

        import re
        tool_mismatches = []
        for chk in m.get("checks", []):
            name = chk.get("name", "")
            match = re.match(r'^([\w\-]+)\s+\(([^)]+)\)$', name)
            if match:
                tool_bin = match.group(1)
                tool_ver = match.group(2)
                tw_key = tool_bin.replace("-", "_")
                # fabric CLI pipx package is ms-fabric-cli but command is fab
                if tool_bin == "fab": tw_key = "ms_fabric_cli"
                if tw_key in tested_with and tool_ver != tested_with[tw_key]:
                    tool_mismatches.append(f'{tool_bin} {tool_ver} <b style="color:#b26a00">(⚠ != {tested_with[tw_key]})</b>')

        if tool_mismatches:
            pv_str += "<br>" + "<br>".join(tool_mismatches)

        html.append(f'<tr><td {css_td}>{m.get("hostname", "unknown")}</td><td {css_td}>{m.get("user", "unknown")}</td><td {css_td}>{days_str}</td><td {css_td}>{f_str}</td><td {css_td}>{w_str}</td><td {css_td}>coop {cv}<br>pi {pv_str}</td></tr>')

    html.append('</table></div>')
    return "".join(html)

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
