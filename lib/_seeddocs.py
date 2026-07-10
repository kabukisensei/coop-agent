#!/usr/bin/env python3
"""Seed coop-data-doc.yml from .coop/project.yml's `repositories:` (issue #25).

The project contract declares each repo's local_path once; coop-data-doc needs
the same paths in its own `repos:` (two slots: `sql` and `powerbi`). This helper
reads the contract, classifies each FILLED repository into a slot, and prints a
JSON patch for `coop-data-doc config-set --from-json -` on STDOUT. A human
mapping summary goes to STDERR (so `coop init --seed-docs` can show it above the
confirmation without polluting the pipe).

Classification (best-effort, first match wins per slot):
  - a repo with a `sql_root` key, or whose name/description mentions
    sql / warehouse / lakehouse / dw / database  -> repos.sql
    (path includes the sql_root subfolder when set and not a TODO)
  - a repo whose name/description mentions
    power bi / pbi / semantic / report / model / fabric -> repos.powerbi
  - with exactly two filled repos, an unclassified one takes the remaining slot

TODO-placeholder local_paths are skipped (never scanned/seeded).

Usage:  python3 _seeddocs.py <path-to-project.yml>
Exit:   0 = patch printed; 3 = nothing to seed (no repositories / all TODO);
        2 = usage or unreadable file.

Dependency-free: reuses lib/_yaml.py (PyYAML when available, else its fallback).
"""
import json
import os
import re
import sys

# Our lib dir must precede everything else: PyYAML ships a C module also named
# `_yaml`, which would otherwise win the import.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _yaml  # noqa: E402

SQL_HINT = re.compile(r'sql|warehouse|lakehouse|(?:^|[^a-z])dw(?:[^a-z]|$)|database', re.I)
PBI_HINT = re.compile(r'power\s*_?bi|(?:^|[^a-z])pbi(?:[^a-z]|$)|semantic|report|model|fabric', re.I)


def is_todo(value):
    return not value or str(value).strip().upper().startswith('TODO')


def classify(name, entry):
    text = '{} {}'.format(name, entry.get('description') or '')
    if 'sql_root' in entry or SQL_HINT.search(text):
        return 'sql'
    if PBI_HINT.search(text):
        return 'powerbi'
    return None


def main(argv):
    if len(argv) != 2:
        sys.stderr.write('usage: _seeddocs.py <path-to-project.yml>\n')
        return 2
    try:
        data = _yaml.load(argv[1])
    except Exception as e:
        sys.stderr.write('could not read {}: {}\n'.format(argv[1], e))
        return 2
    repos = data.get('repositories') if isinstance(data, dict) else None
    if not isinstance(repos, dict) or not repos:
        sys.stderr.write('no repositories: section in {} — nothing to seed.\n'.format(argv[1]))
        return 3

    slots = {}
    todo = []
    unclassified = []
    for name, entry in repos.items():
        if not isinstance(entry, dict):
            continue
        local_path = entry.get('local_path')
        if is_todo(local_path):
            todo.append(name)
            continue
        path = str(local_path)
        slot = classify(name, entry)
        if slot == 'sql':
            sql_root = entry.get('sql_root')
            if not is_todo(sql_root):
                path = os.path.join(path, str(sql_root))
        if slot is None:
            unclassified.append((name, path))
        elif slot not in slots:
            slots[slot] = (name, path)
        else:
            sys.stderr.write("note: repos.{} already mapped — '{}' left out.\n".format(slot, name))

    # With one slot taken and exactly one filled-but-unclassified repo, it gets the other.
    if len(unclassified) == 1 and len(slots) == 1:
        other = 'powerbi' if 'sql' in slots else 'sql'
        slots[other] = unclassified.pop()

    for name in todo:
        sys.stderr.write('note: repositories.{}.local_path is a TODO placeholder — skipped.\n'.format(name))
    for name, _ in unclassified:
        sys.stderr.write("note: couldn't classify repositories.{} as sql or powerbi — left out.\n".format(name))

    if not slots:
        sys.stderr.write('nothing to seed — fill repositories.*.local_path in the contract first.\n')
        return 3

    for slot in ('sql', 'powerbi'):
        if slot in slots:
            sys.stderr.write('  repos.{:<8} <- repositories.{}  ({})\n'.format(slot, slots[slot][0], slots[slot][1]))

    patch = {'repos': {slot: {'path': path} for slot, (_, path) in slots.items()}}
    print(json.dumps(patch, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
