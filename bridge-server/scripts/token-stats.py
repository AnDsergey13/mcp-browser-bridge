#!/usr/bin/env python3
"""token-stats.py — агрегатор расхода по journal.jsonl (П2-4).

Единственный способ проверить, что П0–П2 реально сэкономили токены:
journal пишет bytes аргументов/результатов каждого вызова.

Использование:
  token-stats.py [journal.jsonl] [--since 2026-08-15] [--top N]

По умолчанию читает <repo>/memory/journal.jsonl.
"""
import argparse
import collections
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('journal', nargs='?', default=os.path.join(ROOT, 'memory', 'journal.jsonl'))
    ap.add_argument('--since', help='ISO-дата/время: только записи новее (ts >= since)')
    ap.add_argument('--top', type=int, default=0, help='показать только топ-N инструментов по bytes')
    a = ap.parse_args()

    stats = collections.defaultdict(lambda: {'calls': 0, 'ok': 0, 'args_bytes': 0, 'result_bytes': 0})
    total_calls = 0
    try:
        fh = open(a.journal, encoding='utf-8')
    except OSError as e:
        print(f'не открыть {a.journal}: {e}', file=sys.stderr)
        return 1
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if a.since and str(e.get('ts', '')) < a.since:
                continue
            tool = e.get('tool') or '?'
            s = stats[tool]
            s['calls'] += 1
            s['ok'] += 1 if e.get('ok') is True else 0
            s['args_bytes'] += (e.get('args_digest') or {}).get('bytes', 0)
            s['result_bytes'] += (e.get('result_digest') or {}).get('bytes', 0)
            total_calls += 1

    rows = sorted(stats.items(), key=lambda kv: kv[1]['result_bytes'], reverse=True)
    if a.top:
        rows = rows[:a.top]
    print(f'{"tool":24} {"calls":>6} {"ok":>5} {"args_B":>9} {"result_B":>10}')
    tot_args = tot_res = 0
    for tool, s in rows:
        print(f'{tool:24} {s["calls"]:>6} {s["ok"]:>5} {s["args_bytes"]:>9} {s["result_bytes"]:>10}')
        tot_args += s['args_bytes']
        tot_res += s['result_bytes']
    print(f'{"TOTAL":24} {total_calls:>6} {"":>5} {tot_args:>9} {tot_res:>10}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
