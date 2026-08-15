#!/usr/bin/env python3
"""bisect-extract.py — бисекция page.extract по прямым детям <main> (поиск «ядовитого» узла)."""
import json, os, time, sys

CMD = '/workspace/.bridge/cmd.json'
RES = '/workspace/.bridge/result.json'

def bridge(tool, args, wait=60):
    before = os.path.getmtime(RES) if os.path.exists(RES) else 0
    with open(CMD, 'w') as f:
        json.dump({'tool': tool, 'args': args}, f)
    for _ in range(wait * 2):
        time.sleep(0.5)
        if not os.path.exists(CMD) and os.path.getmtime(RES) != before:
            break
    with open(RES) as f:
        return json.load(f)

tab = int(sys.argv[1]) if len(sys.argv) > 1 else 40
for k in range(1, 41):
    sel = f'main > *:nth-child({k})'
    d = bridge('page.extract', {'tabId': tab, 'selector': sel, 'images': 'manifest'})
    if not d.get('ok'):
        print(f'{k}: FAIL {d.get("error_code")} {str(d.get("hint"))[:80]}', flush=True)
        continue
    data = d['data']
    md = data.get('markdown') or ''
    nimg = len(data.get('images') or [])
    if not md and not nimg:
        print(f'{k}: — пусто (конец детей?)', flush=True)
        if k > 3:
            break
        continue
    print(f'{k}: ok md={len(md)} imgs={nimg} | {md[:60]!r}', flush=True)
