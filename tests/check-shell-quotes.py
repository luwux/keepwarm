#!/usr/bin/env python3
"""Fails if a `sh -c` script written as a JS template literal contains \\" .

Inside a template literal \\" is just ", and sh then strips it as a quote, so
grep -F "\\"key\\":\\"$1\\"" silently searches for key:<value> and never matches
(this broke the notification deep link). Pass such strings as arguments ($1, $2) instead.
"""
import pathlib, re, sys

src = pathlib.Path(__file__).resolve().parent.parent / 'hooks' / 'register.tsx'
bad = [f'{src.name}:{i}: {line.strip()}' for i, line in enumerate(src.read_text().splitlines(), 1)
       if re.search(r"\['sh',\s*'-c',\s*`[^`]*\\\"", line)]
if bad:
    print('sh -c template with \\" (quotes get eaten):\n  ' + '\n  '.join(bad))
    sys.exit(1)
print(f'ok: no escaped quotes inside sh -c templates in {src.name}')
