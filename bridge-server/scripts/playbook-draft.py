#!/usr/bin/env python3
"""playbook-draft.py — экспорт «успешная цепочка → черновик плейбука» (П2-4).

Читает journal.jsonl (нужен journal_full_args: true в policy.yaml — иначе
в журнале только дайджесты) и печатает по доменам черновик плейбука:
последовательность успешных вызовов с args (пароли уже замаскированы
сервером на записи). Черновик — ЧЕЛОВЕКУ/агенту на ревизию: в
memory/domains/<domain>.md попадает после проверки, не автоматически.

Использование:
  playbook-draft.py [journal.jsonl] [--domain example.com] [--last N]
"""
import argparse
import collections
import json
import os
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SKIP_TOOLS = {'policy.status'}  # служебные вызовы в плейбуке не нужны


def fmt_args(args):
    if not isinstance(args, dict):
        return ''
    parts = []
    for k, v in args.items():
        if k == 'tabId':
            continue
        parts.append(f'{k}={json.dumps(v, ensure_ascii=False)}')
    return ' '.join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('journal', nargs='?', default=os.path.join(ROOT, 'memory', 'journal.jsonl'))
    ap.add_argument('--domain', help='только этот домен (host из url записи)')
    ap.add_argument('--last', type=int, default=50, help='последние N успешных вызовов на домен')
    a = ap.parse_args()

    chains = collections.defaultdict(list)
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
            if e.get('ok') is not True:
                continue
            tool = e.get('tool') or ''
            if tool in SKIP_TOOLS:
                continue
            host = urllib.parse.urlparse(e.get('url') or '').netloc or '(no-url)'
            if a.domain and host != a.domain:
                continue
            chains[host].append(e)

    if not chains:
        print('успешных вызовов с args не найдено. Включи journal_full_args: true в policy.yaml '
              'и повтори задачу.', file=sys.stderr)
        return 1

    for host, entries in chains.items():
        print(f'## {host}\n')
        for e in entries[-a.last:]:
            args = e.get('args')
            suffix = (' ' + fmt_args(args)) if args else ''
            print(f'- `{e.get("tool")}`{suffix}')
        print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
