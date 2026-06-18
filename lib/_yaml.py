#!/usr/bin/env python3
"""Dependency-free YAML reader for coop.

coop must work on a fresh machine where the system python has no PyYAML. This
reader uses PyYAML when importable (full fidelity) and otherwise falls back to a
focused parser that handles the subset coop's .coop/project.yml uses: nested
block maps, block lists, inline flow lists [a, b], inline flow maps {k: v},
scalars (quoted/unquoted), and # comments.

Usage:
    python3 _yaml.py get  FILE dotted.key [default]   -> prints scalar (or default)
    python3 _yaml.py list FILE dotted.key             -> prints list items, one per line
"""
import sys


def _strip_comment(line):
    out = []
    q = None
    for i, c in enumerate(line):
        if q:
            out.append(c)
            if c == q:
                q = None
        elif c in ('"', "'"):
            q = c
            out.append(c)
        elif c == '#' and (i == 0 or line[i - 1] in ' \t'):
            break
        else:
            out.append(c)
    return ''.join(out).rstrip()


def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]
    return s


def _split_top(s, sep):
    parts, depth, q, cur = [], 0, None, ''
    for c in s:
        if q:
            cur += c
            if c == q:
                q = None
        elif c in ('"', "'"):
            q = c
            cur += c
        elif c in '[{':
            depth += 1
            cur += c
        elif c in ']}':
            depth -= 1
            cur += c
        elif c == sep and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += c
    parts.append(cur)
    return parts


def _parse_value(s):
    s = s.strip()
    if s.startswith('['):
        inner = s[1:-1].strip()
        return [] if not inner else [_parse_value(x) for x in _split_top(inner, ',')]
    if s.startswith('{'):
        inner = s[1:-1].strip()
        d = {}
        if inner:
            for part in _split_top(inner, ','):
                if ':' in part:
                    k, v = part.split(':', 1)
                    d[_unquote(k)] = _parse_value(v)
        return d
    return _unquote(s)


def _load_fallback(text):
    lines = []
    for ln in text.split('\n'):
        s = _strip_comment(ln)
        if s.strip() in ('', '---'):
            continue
        lines.append((len(s) - len(s.lstrip(' ')), s.strip()))
    pos = [0]

    def parse(min_indent):
        if pos[0] >= len(lines):
            return None
        _, content = lines[pos[0]]
        if content.startswith('- '):
            lst = []
            while pos[0] < len(lines):
                indent, content = lines[pos[0]]
                if indent < min_indent or not content.startswith('- '):
                    break
                item = content[2:].strip()
                pos[0] += 1
                if item == '':
                    lst.append(parse(min_indent + 1))
                elif ':' in item and not item[:1] in '[{"\'':
                    k, v = item.split(':', 1)
                    lst.append({_unquote(k): _parse_value(v)})
                else:
                    lst.append(_parse_value(item))
            return lst
        d = {}
        while pos[0] < len(lines):
            indent, content = lines[pos[0]]
            if indent < min_indent or content.startswith('- '):
                break
            if ':' not in content:
                pos[0] += 1
                continue
            k, v = content.split(':', 1)
            key, v = _unquote(k), v.strip()
            pos[0] += 1
            if v == '':
                if pos[0] < len(lines) and lines[pos[0]][0] > indent:
                    d[key] = parse(indent + 1)
                else:
                    d[key] = None
            else:
                d[key] = _parse_value(v)
        return d

    return parse(0) or {}


def load(path):
    with open(path) as f:
        text = f.read()
    try:
        import yaml
        return yaml.safe_load(text) or {}
    except Exception:
        return _load_fallback(text)


def dig(data, dotted):
    cur = data
    for part in dotted.split('.'):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def main(argv):
    if len(argv) < 4:
        return 0
    mode, path, key = argv[1], argv[2], argv[3]
    default = argv[4] if len(argv) > 4 else ''
    try:
        data = load(path)
    except Exception:
        if mode == 'get':
            sys.stdout.write(default)
        return 0
    val = dig(data, key)
    if mode == 'get':
        if val is None or isinstance(val, (list, dict)):
            sys.stdout.write(default)
        elif isinstance(val, bool):
            sys.stdout.write('true' if val else 'false')
        else:
            sys.stdout.write(str(val))
    elif mode == 'list':
        if isinstance(val, list):
            for item in val:
                if item is not None and not isinstance(item, (list, dict)):
                    print(item)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
