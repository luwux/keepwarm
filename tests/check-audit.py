#!/usr/bin/env python3
"""Fails if keepwarm makes a request or a change that bypasses the audit layer.

Every raw effectful call ($.model, $.mcp, $.prompt.submit, $.session.compact/append,
$.process.run/spawn, $.ui.copy) must sit inside an audited* helper, inside a function that
only reads, or within a few lines of an explicit audit(...) call.
"""
import re, sys, pathlib

src = pathlib.Path(__file__).resolve().parent.parent / 'hooks' / 'register.tsx'
lines = src.read_text().splitlines()
RAW = re.compile(r'\$\.(model\.(fork|complete)|mcp\.call|prompt\.submit|session\.(compact|append)|process\.(run|spawn)|ui\.copy)\(')
AUDIT_LAYER = {'auditedFork', 'auditedComplete', 'auditedMcp', 'auditedRun', 'auditedSubmit', 'auditedCompact'}
READ_ONLY = {'idleSeconds', 'desktopSession', 'busGet', 'busAll', 'ntfyConfig'}  # these only read
FN = re.compile(r'^(?:export\s+)?(?:async\s+)?function\s+(\w+)')

fn = None
bad = []
for i, line in enumerate(lines):
    m = FN.match(line)
    if m:
        fn = m.group(1)
    if line.lstrip().startswith('//') or not RAW.search(line):
        continue
    if fn in AUDIT_LAYER or fn in READ_ONLY:
        continue
    near = '\n'.join(lines[max(0, i - 3): i + 4])
    if 'audit($' in near:
        continue
    bad.append(f'{src.name}:{i + 1} in {fn}(): {line.strip()}')

for name in READ_ONLY:  # a read-only helper must not grow a write
    body = re.search(rf'function {name}\(.*?\n}}\n', '\n'.join(lines), re.S)
    if body and re.search(r'>\s*"|\bmv\b|\brm\b|-delete|mkdir|curl|terminal-notifier', body.group(0)):
        bad.append(f'{name}() is listed read-only but looks like it writes')

if bad:
    print('UNAUDITED:\n  ' + '\n  '.join(bad))
    sys.exit(1)
print(f'ok: every effectful call in {src.name} goes through the audit layer')
