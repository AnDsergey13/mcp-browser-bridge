#!/usr/bin/env python3
"""hls-download.py — скачать HLS-поток(и) через мост браузерного релея.

Универсальный: любой m3u8 (master или variant), доступный браузеру с его
сессией/cookies. Контейнер egress не имеет — качает БРАУЗЕР (file.download),
склейка сегментов локальная. Если рядом есть ffmpeg — ремукс в .mp4 (-c copy).

Использование:
  python3 hls-download.py --tab 40 --out <dir> URL [URL...]
  python3 hls-download.py --tab 40 --out <dir> --net        # все m3u8 из net.list
  --quality max|min|720   (по ширине RESOLUTION; default max)
  --name NAME             (для одного URL; иначе — по id/хэшу URL)

Требования: живой live-repl (scripts/live-repl.mjs), активная сессия, грант
download на домены мастер-плейлиста и сегментов (policy: проверяется домен ФАЙЛА).
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CMD = os.path.join(ROOT, '.bridge', 'cmd.json')
RES = os.path.join(ROOT, '.bridge', 'result.json')
DL = os.path.join(ROOT, 'downloads')


def bridge(tool, args, wait=180):
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


def download(tab, url, name):
    d = bridge('file.download', {'tabId': tab, 'url': url, 'name': name})
    print(f'  {name} {d["size"]}B', flush=True)
    return os.path.join(DL, d['file'])


def pick_variant(master_text, quality):
    best, best_w = None, -1
    lines = master_text.splitlines()
    for i, ln in enumerate(lines):
        if not ln.startswith('#EXT-X-STREAM-INF'):
            continue
        m = re.search(r'RESOLUTION=(\d+)x(\d+)', ln)
        w = int(m.group(1)) if m else 0
        take = (quality == 'max' and w > best_w) or \
               (quality == 'min' and (best is None or w < best_w)) or \
               (quality.isdigit() and w == int(quality))
        if take:
            best, best_w = lines[i + 1].strip(), w
    return best


def default_name(url):
    base = url.split('?')[0].rstrip('/').rsplit('/', 1)[-1]
    base = re.sub(r'\.m3u8$', '', base)
    return re.sub(r'[^\w.-]', '_', base) or 'stream'


# ffmpeg: сначала встроенный в репозиторий (tools/ffmpeg), потом системный.
FFMPEG = os.path.join(ROOT, 'tools', 'ffmpeg', 'ffmpeg')
if not os.path.exists(FFMPEG):
    FFMPEG = shutil.which('ffmpeg')


def download_hls(tab, url, outdir, quality, name=None):
    """Возвращает (путь к файлу, URL выбранного variant-плейлиста или None)."""
    name = name or default_name(url)
    final_ts = os.path.join(outdir, name + '.ts')
    final_mp4 = os.path.join(outdir, name + '.mp4')
    if os.path.exists(final_ts) or os.path.exists(final_mp4):
        print(f'{name}: уже есть, пропуск', flush=True)
        return (final_mp4 if os.path.exists(final_mp4) else final_ts), None
    os.makedirs(outdir, exist_ok=True)
    tmp = os.path.join(outdir, '.tmp-' + name)
    os.makedirs(tmp, exist_ok=True)

    master = download(tab, url, name + '.m3u8')
    text = open(master).read()
    playlist_url = url
    variant_url = None
    if '#EXT-X-STREAM-INF' in text:
        vurl = pick_variant(text, quality)
        if not vurl:
            raise RuntimeError(f'{name}: нет вариантов в master')
        variant_url = playlist_url = urllib.parse.urljoin(url, vurl)
        os.remove(master)
        master = download(tab, playlist_url, name + '.variant.m3u8')
        text = open(master).read()
    segs = [l.strip() for l in text.splitlines()
            if l.strip() and not l.startswith('#')]
    print(f'{name}: сегментов {len(segs)}', flush=True)

    parts = []
    for i, s in enumerate(segs, 1):
        surl = urllib.parse.urljoin(playlist_url, s)
        pname = f'{name}-seg-{i:04d}.ts'
        p = os.path.join(tmp, pname)
        if os.path.exists(p) and os.path.getsize(p) > 0:
            parts.append(p)
            continue
        got = download(tab, surl, pname)
        shutil.move(got, p)
        parts.append(p)

    with open(final_ts, 'wb') as out:
        for p in parts:
            with open(p, 'rb') as f:
                shutil.copyfileobj(f, out)
    if open(final_ts, 'rb').read(1) != b'\x47':
        raise RuntimeError(f'{name}: результат не MPEG-TS (нет sync-байта)')
    shutil.rmtree(tmp)
    os.rename(master, os.path.join(outdir, name + '.m3u8'))

    if FFMPEG:
        subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', final_ts,
                        '-c', 'copy', final_mp4], check=True)
        os.remove(final_ts)
        print(f'{name}: OK {final_mp4}', flush=True)
        return final_mp4, variant_url
    print(f'{name}: OK {final_ts} (ffmpeg не найден — оставлен .ts)', flush=True)
    return final_ts, variant_url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tab', type=int, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--quality', default='max')
    ap.add_argument('--name')
    ap.add_argument('--net', action='store_true',
                    help='взять все *.m3u8 из net.list вкладки')
    ap.add_argument('urls', nargs='*')
    a = ap.parse_args()

    urls = list(a.urls)
    if a.net:
        reqs = bridge('net.list', {'tabId': a.tab})['requests']
        seen = set()
        for r in reqs:
            u = r['url']
            if u.endswith('.m3u8') or '.m3u8?' in u:
                if u not in seen:
                    seen.add(u)
                    urls.append(u)
    if not urls:
        ap.error('нет URL (передай аргументами или --net)')

    consumed = set()
    for u in urls:
        if u in consumed:
            print(f'пропуск (уже скачан как вариант мастера): {u}', flush=True)
            continue
        _, vurl = download_hls(a.tab, u, a.out, a.quality,
                               a.name if len(urls) == 1 else None)
        if vurl:
            consumed.add(vurl)
    print('ALL DONE', flush=True)


main()
