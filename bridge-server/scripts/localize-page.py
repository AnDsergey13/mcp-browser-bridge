#!/usr/bin/env python3
"""localize-page.py — сохранить страницу как самодостаточный markdown-документ.

page.extract → markdown с инлайн-картинками ![alt](url) и маркерами embed'ов
[embedded: url] / [video: url]; скрипт скачивает картинки через браузерный
релей (file.download) в <out>/images/ и подменяет URL на локальные пути.
Внешние ссылки (документы, магазины) НЕ трогаем — остаются ссылками.

Если в <out> уже лежит скачанное видео, чьё имя содержит id embed'а
(wistia: /embed/(iframe|medias)/<id>), маркер подменяется на локальный
<video src> + ссылку. Остальные embed'ы остаются маркерами с исходным URL.

Использование:
  python3 localize-page.py --tab 40 --out downloads/cps3/01_lecture [--title "Имя"]

Требования: живой live-repl, активная сессия, грант download на домены картинок.
"""
import argparse, json, os, re, time, urllib.parse

CMD = '/workspace/.bridge/cmd.json'
RES = '/workspace/.bridge/result.json'
DL = '/workspace/downloads'


def bridge(tool, args, wait=60):
    before = os.path.getmtime(RES) if os.path.exists(RES) else 0
    with open(CMD, 'w') as f:
        json.dump({'tool': tool, 'args': args}, f)
    for _ in range(wait * 2):
        time.sleep(0.5)
        if not os.path.exists(CMD) and os.path.getmtime(RES) != before:
            break
    with open(RES) as f:
        d = json.load(f)
    if not d.get('ok'):
        raise RuntimeError(f"{tool}: {d.get('error_code')} {d.get('hint')}")
    return d['data']


def img_name(n, url):
    base = urllib.parse.urlparse(url).path.rsplit('/', 1)[-1] or f'img{n}'
    base = re.sub(r'[^\w.-]', '_', urllib.parse.unquote(base))
    if '.' not in base:
        base += '.bin'
    return f'{n:02d}_{base}'


def find_local_video(outdir, embed_url):
    """Ищем в outdir видеофайл, привязанный к embed'у (wistia id и пр.)."""
    m = re.search(r'/embed/(?:iframe|medias)/([A-Za-z0-9]+)', embed_url)
    if not m:
        return None
    vid = m.group(1)
    for f in sorted(os.listdir(outdir)):
        if vid in f and os.path.splitext(f)[1] in ('.ts', '.mp4', '.webm', '.mkv'):
            return f
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tab', type=int, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--title')
    a = ap.parse_args()

    os.makedirs(os.path.join(a.out, 'images'), exist_ok=True)
    d = bridge('page.extract', {'tabId': a.tab, 'max_chars': 60000})
    md = d['markdown']
    source_url = d['url']

    # Картинки: скачать и заменить URL на локальный путь (по манифесту n↔src).
    for im in d['images']:
        src = im['src']
        if not src or src == 'data:(inline)':
            continue
        local = 'images/' + img_name(im['n'], src)
        target = os.path.join(a.out, 'images', img_name(im['n'], src))
        if not os.path.exists(target):
            got = bridge('file.download', {'tabId': a.tab, 'url': src,
                                           'name': img_name(im['n'], src)})
            os.rename(os.path.join(DL, got['file']), target)
            print(f"img {im['n']}: {got['size']}B", flush=True)
        # В markdown src может отличаться от currentSrc (без ?width=…):
        # подменяем оба варианта.
        for variant in {src, src.split('?')[0]}:
            md = md.replace(f']({variant})', f']({local})')

    # Embed'ы: 1) точное совпадение по id из URL (wistia и пр.); 2) фолбэк —
    # по ПОРЯДКУ: i-й маркер в тексте ↔ i-й видеофайл в каталоге.
    videos = [f for f in sorted(os.listdir(a.out))
              if os.path.splitext(f)[1] in ('.ts', '.mp4', '.webm', '.mkv')]
    embed_count = [0]

    def sub_embed(m):
        kind, url = m.group(1), m.group(2)
        local = find_local_video(a.out, url)
        if not local:
            i = embed_count[0]
            if i < len(videos):
                local = videos[i]
        embed_count[0] += 1
        if local:
            return (f'\n\n<video controls src="{local}"></video>\n'
                    f'[▶ {local}]({local})\n\n')
        return m.group(0) + f' <!-- не скачано: {url} -->'
    md = re.sub(r'\[(embedded|video|audio): (\S+)\]', sub_embed, md)

    title = a.title or d['title']
    header = f'# {title}\n\nИсточник: {source_url}\n\n'
    out_path = os.path.join(a.out, 'content.md')
    with open(out_path, 'w') as f:
        f.write(header + md + '\n')
    print(f'OK: {out_path}', flush=True)


main()
