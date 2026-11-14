#!/usr/bin/env python3
"""Najja AI service (v1.8): background removal and image upscaling for the editor's home tools.

Runs next to the Node server: its own container under Docker (see Dockerfile.ai), or started by the Node server when
it runs on a PC. Plain standard-library HTTP; inference with onnxruntime on the CPU, one job at a time. It only reads
and writes files under <data>/ai, and only fetches the pinned model files listed in models.json (sha256-checked).

  GET  /health                         versions, memory, which models are ready
  POST /models/ensure {"names": [...]} download missing models in the background
  POST /run {"task": "cutout"|"upscale", "input": path, "output": path without extension, "scale": 2|4}
       → NDJSON lines {"progress": 0..1, "stage": ...}; the last line is {"done": {...}} or {"error": "..."}

Models (licenses in models.json): BiRefNet lite 512 (MIT) cuts out the subject; on servers with little memory IS-Net
(MIT) does instead; Real-ESRGAN General x4v3 (BSD-3) upscales, tile by tile.
"""
import argparse
import gc
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '1.0'
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, 'models.json'), encoding='utf-8') as f:
    MODELS = json.load(f)

ARGS = None
AI_DIR = MODELS_DIR = ''
STATE = {name: {'state': 'missing', 'progress': 0.0, 'error': None} for name in MODELS}
STATE_LOCK = threading.Lock()
RUN_LOCK = threading.Lock()  # one inference at a time (memory)
SESSIONS = {}  # model name -> [session, last used]
IDLE_RELEASE_S = 300  # free a model's memory after this long without use
MAX_OUT = 4096  # longest side of any output image


def log(*a):
    print('[najja-ai]', *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------------------------
# Memory: the container's limit (cgroup) when there is one, else the machine's RAM.
def _meminfo(key):
    try:
        with open('/proc/meminfo') as f:
            for line in f:
                if line.startswith(key + ':'):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def _read_int(path):
    try:
        with open(path) as f:
            v = f.read().strip()
        return int(v) if v.isdigit() else None
    except OSError:
        return None


def memory():
    total = _meminfo('MemTotal') or 0
    avail = _meminfo('MemAvailable') or total
    limit = None
    for f in ('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'):
        v = _read_int(f)
        if v and v < (1 << 60):
            limit = v // 1048576
            break
    used = None
    for f in ('/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'):
        v = _read_int(f)
        if v is not None:
            used = v // 1048576
            break
    if limit:
        avail = min(avail, limit - (used or 0))
    return {'totalMB': total, 'limitMB': limit, 'availableMB': max(0, avail)}


def cpu_quota():
    """CPUs this container may use (cgroup quota), else the machine's cores."""
    try:
        with open('/sys/fs/cgroup/cpu.max') as f:
            q, period = f.read().split()
        if q != 'max':
            return max(1, round(int(q) / int(period)))
    except (OSError, ValueError):
        pass
    try:
        q, period = _read_int('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), _read_int('/sys/fs/cgroup/cpu/cpu.cfs_period_us')
        if q and period and q > 0:
            return max(1, round(q / period))
    except Exception:  # noqa: BLE001
        pass
    return os.cpu_count() or 1


def cutout_model():
    """BiRefNet when this container may use enough memory for it, else IS-Net (or nothing)."""
    want = os.environ.get('NAJJA_AI_CUTOUT', 'auto')
    if want in ('hq', 'cutout'):
        return 'cutout'
    if want in ('lite', 'cutout-lite'):
        return 'cutout-lite'
    m = memory()
    cap = m['limitMB'] or m['totalMB']
    if cap >= MODELS['cutout']['memMB']:
        return 'cutout'
    return 'cutout-lite'


def deps():
    out = {'python': sys.version.split()[0]}
    try:
        import numpy
        out['numpy'] = numpy.__version__
    except Exception as e:  # noqa: BLE001
        out['numpy'] = None
        out['error'] = f'numpy: {e}'
    try:
        import PIL
        out['pillow'] = PIL.__version__
    except Exception as e:  # noqa: BLE001
        out['pillow'] = None
        out['error'] = f'pillow: {e}'
    try:
        import onnxruntime
        out['onnxruntime'] = onnxruntime.__version__
    except Exception as e:  # noqa: BLE001
        out['onnxruntime'] = None
        out['error'] = f'onnxruntime: {e}'
    return out


# ---------------------------------------------------------------------------------------------------------------
# Models: downloaded once into <data>/models, checked against the pinned sha256.
def model_files(name):
    m = MODELS[name]
    return [os.path.join(MODELS_DIR, f) for f in (m.get('extract') or [m['file']])]


def _ok_marker(name):
    return os.path.join(MODELS_DIR, MODELS[name]['file'] + '.ok')


def is_ready(name):
    if not all(os.path.exists(f) for f in model_files(name)):
        return False
    try:
        with open(_ok_marker(name)) as f:
            return f.read().strip() == MODELS[name]['sha256']
    except OSError:
        pass
    # files copied in by hand: check once, then remember
    if 'zip' not in MODELS[name] and _sha256(model_files(name)[0]) == MODELS[name]['sha256']:
        with open(_ok_marker(name), 'w') as f:
            f.write(MODELS[name]['sha256'])
        return True
    return False


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _set(name, **kw):
    with STATE_LOCK:
        STATE[name].update(kw)


def refresh_states():
    for name in MODELS:
        if STATE[name]['state'] != 'downloading':
            _set(name, state='ready' if is_ready(name) else ('error' if STATE[name]['error'] else 'missing'))


def download(name):
    m = MODELS[name]
    url = m.get('zip') or m['url']
    os.makedirs(MODELS_DIR, exist_ok=True)
    part = os.path.join(MODELS_DIR, m['file'] + '.part')
    _set(name, state='downloading', progress=0.0, error=None)
    log('downloading', name, url)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'najja-ai/' + VERSION})
        h = hashlib.sha256()
        got = 0
        with urllib.request.urlopen(req, timeout=60) as r, open(part, 'wb') as f:
            total = int(r.headers.get('Content-Length') or m.get('size') or 0)
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                h.update(chunk)
                got += len(chunk)
                if total:
                    _set(name, progress=min(0.99, got / total))
        if h.hexdigest() != m['sha256']:
            raise ValueError(f'sha256 mismatch ({h.hexdigest()[:12]}…), file discarded')
        if 'zip' in m:
            with zipfile.ZipFile(part) as z:
                for member in z.namelist():
                    base = os.path.basename(member)
                    if base in m['extract']:
                        with z.open(member) as src, open(os.path.join(MODELS_DIR, base + '.tmp'), 'wb') as dst:
                            shutil.copyfileobj(src, dst)
            for base in m['extract']:
                os.replace(os.path.join(MODELS_DIR, base + '.tmp'), os.path.join(MODELS_DIR, base))
            os.remove(part)
        else:
            os.replace(part, os.path.join(MODELS_DIR, m['file']))
        with open(_ok_marker(name), 'w') as f:
            f.write(m['sha256'])
        _set(name, state='ready', progress=1.0, error=None)
        log('ready', name)
    except Exception as e:  # noqa: BLE001
        try:
            os.remove(part)
        except OSError:
            pass
        _set(name, state='error', error=str(e)[:200])
        log('download failed', name, e)


DOWNLOADS = {}


def ensure(names):
    for name in names:
        if name not in MODELS or is_ready(name):
            continue
        t = DOWNLOADS.get(name)
        if t and t.is_alive():
            continue
        t = threading.Thread(target=download, args=(name,), daemon=True)
        DOWNLOADS[name] = t
        t.start()


def default_models():
    return [cutout_model(), 'upscale']


# ---------------------------------------------------------------------------------------------------------------
# Inference
def session(name):
    import onnxruntime as ort
    s = SESSIONS.get(name)
    if s:
        s[1] = time.time()
        return s[0]
    if not is_ready(name):
        raise RuntimeError('model belum siap (sedang diunduh?)')
    so = ort.SessionOptions()
    # as many threads as CPUs this container may use: more only wait for each other under a CPU quota
    threads = int(os.environ.get('NAJJA_AI_THREADS') or 0) or min(4, cpu_quota())
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    # without the memory arena the peak is ~25% lower (BiRefNet 512: ~2.0 GB instead of ~3.2 GB)
    so.enable_cpu_mem_arena = False
    so.enable_mem_pattern = False
    so.log_severity_level = 3
    sess = ort.InferenceSession(model_files(name)[0], so, providers=['CPUExecutionProvider'])
    SESSIONS[name] = [sess, time.time()]
    return sess


def release_idle():
    while True:
        time.sleep(60)
        now = time.time()
        with RUN_LOCK:
            for name in [n for n, (_, used) in SESSIONS.items() if now - used > IDLE_RELEASE_S]:
                del SESSIONS[name]
                log('released', name)
            gc.collect()


class Cancelled(Exception):
    pass


def _open_image(path):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 80_000_000
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    alpha = None
    if im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info):
        im = im.convert('RGBA')
        alpha = im.getchannel('A')
    return im.convert('RGB'), alpha


def cutout(inp, out_base, report, cancelled):
    import numpy as np
    from PIL import Image, ImageChops
    rgb, alpha_in = _open_image(inp)
    if max(rgb.size) > MAX_OUT:
        k = MAX_OUT / max(rgb.size)
        rgb = rgb.resize((round(rgb.width * k), round(rgb.height * k)), Image.LANCZOS)
        alpha_in = alpha_in.resize(rgb.size, Image.LANCZOS) if alpha_in else None
    W, H = rgb.size
    name = cutout_model()
    if memory()['availableMB'] < MODELS[name]['memMB'] * 0.6 and name not in SESSIONS:
        if name == 'cutout' and is_ready('cutout-lite'):
            name = 'cutout-lite'
        else:
            raise RuntimeError('memori server sedang tidak cukup, coba lagi sebentar lagi')
    report(0.1, 'model')
    s = session(name)
    inp_meta = s.get_inputs()[0]
    n = inp_meta.shape[2] if isinstance(inp_meta.shape[2], int) else 1024
    x = np.asarray(rgb.resize((n, n), Image.BILINEAR), dtype=np.float32) / 255.0
    if name == 'cutout':
        x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    else:  # IS-Net: (v - 128) / 256 on 0..255
        x = x - 0.5
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None], dtype=np.float32)
    if cancelled():
        raise Cancelled()
    report(0.3, 'cutout')
    y = s.run(None, {inp_meta.name: x})[0][0, 0]
    if name == 'cutout':
        m = 1.0 / (1.0 + np.exp(-y))
    else:
        m = (y - y.min()) / max(1e-6, float(y.max() - y.min()))
    report(0.85, 'save')
    alpha = Image.fromarray((np.clip(m, 0, 1) * 255 + 0.5).astype(np.uint8)).resize((W, H), Image.BICUBIC)
    if alpha_in is not None:
        alpha = ImageChops.multiply(alpha, alpha_in)
    res = rgb.copy()
    res.putalpha(alpha)
    path = out_base + '.png'
    res.save(path, 'PNG', compress_level=6)
    # where the subject is (for the editor: crop / centre)
    box = alpha.point(lambda v: 255 if v > 24 else 0).getbbox()
    return {'file': os.path.basename(path), 'width': W, 'height': H, 'model': name, 'subject': list(box) if box else None}


def _positions(length, tile, step):
    if length <= tile:
        return [0]
    out = list(range(0, length - tile, step))
    out.append(length - tile)
    return out


def upscale(inp, out_base, scale, report, cancelled):
    import numpy as np
    from PIL import Image
    scale = 4 if int(scale or 2) >= 4 else 2
    rgb, alpha_in = _open_image(inp)
    # the output stays within MAX_OUT: a larger input is reduced first (it would not gain anything visible)
    if max(rgb.size) * scale > MAX_OUT:
        k = MAX_OUT / (max(rgb.size) * scale)
        rgb = rgb.resize((max(1, round(rgb.width * k)), max(1, round(rgb.height * k))), Image.LANCZOS)
    W, H = rgb.size
    report(0.05, 'model')
    s = session('upscale')
    inp_meta = s.get_inputs()[0]
    T = inp_meta.shape[2] if isinstance(inp_meta.shape[2], int) else 128
    S = 4
    P = 12  # overlap margin: each tile's edge pixels (less context) are not used
    x = np.asarray(rgb, dtype=np.float32) / 255.0
    ph, pw = max(0, T - H), max(0, T - W)
    if ph or pw:
        x = np.pad(x, ((0, ph), (0, pw), (0, 0)), mode='edge')
    h, w = x.shape[:2]
    out = np.zeros((h * S, w * S, 3), np.float32)
    ys, xs = _positions(h, T, T - 2 * P), _positions(w, T, T - 2 * P)
    total = len(ys) * len(xs)
    done = 0
    for y0 in ys:
        for x0 in xs:
            if cancelled():
                raise Cancelled()
            tile = np.ascontiguousarray(x[y0:y0 + T, x0:x0 + T].transpose(2, 0, 1)[None])
            r = s.run(None, {inp_meta.name: tile})[0][0].transpose(1, 2, 0)
            ty0 = 0 if y0 == 0 else P
            tx0 = 0 if x0 == 0 else P
            ty1 = T if y0 + T >= h else T - P
            tx1 = T if x0 + T >= w else T - P
            out[(y0 + ty0) * S:(y0 + ty1) * S, (x0 + tx0) * S:(x0 + tx1) * S] = r[ty0 * S:ty1 * S, tx0 * S:tx1 * S]
            done += 1
            report(0.05 + 0.85 * done / total, 'upscale')
    res = Image.fromarray((np.clip(out[:H * S, :W * S], 0, 1) * 255 + 0.5).astype(np.uint8))
    del out
    if scale != S:
        res = res.resize((W * scale, H * scale), Image.LANCZOS)
    report(0.95, 'save')
    if alpha_in is not None:
        res.putalpha(alpha_in.resize(res.size, Image.LANCZOS))
        path = out_base + '.png'
        res.save(path, 'PNG', compress_level=6)
    else:
        path = out_base + '.jpg'
        res.save(path, 'JPEG', quality=95, subsampling=0)
    return {'file': os.path.basename(path), 'width': res.width, 'height': res.height, 'model': 'upscale', 'scale': scale}


# ---------------------------------------------------------------------------------------------------------------
# HTTP
def _resolve(path):
    """A path inside <data>/ai (relative to it, as the editor sends them), or None."""
    if not path:
        return None
    real = os.path.realpath(path if os.path.isabs(path) else os.path.join(AI_DIR, path))
    return real if real.startswith(AI_DIR + os.sep) else None


class Handler(BaseHTTPRequestHandler):
    server_version = 'najja-ai/' + VERSION

    def log_message(self, fmt, *a):  # quiet
        pass

    def _auth(self):
        tok = os.environ.get('NAJJA_AI_TOKEN')
        if tok and self.headers.get('x-najja-ai-token') != tok:
            self._json(401, {'error': 'unauthorized'})
            return False
        return True

    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 1 << 16:
            raise ValueError('request too large')
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        # (status only, no data: open, so the container health check can use it)
        if self.path.split('?')[0] == '/health':
            refresh_states()
            with STATE_LOCK:
                models = {k: {**v, 'title': MODELS[k]['title'], 'size': MODELS[k]['size'], 'license': MODELS[k]['license']} for k, v in STATE.items()}
            d = deps()
            return self._json(200, {'ok': not d.get('error'), 'version': VERSION, 'deps': d, 'memory': memory(), 'cpus': cpu_quota(),
                                    'cutoutModel': cutout_model(), 'models': models, 'busy': RUN_LOCK.locked()})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self._auth():
            return
        route = self.path.split('?')[0]
        try:
            body = self._body()
        except Exception as e:  # noqa: BLE001
            return self._json(400, {'error': str(e)})
        if route == '/models/ensure':
            names = body.get('names') or default_models()
            ensure([n for n in names if n in MODELS])
            refresh_states()
            return self._json(200, {'ok': True})
        if route == '/run':
            return self._run(body)
        self._json(404, {'error': 'not found'})

    def _run(self, body):
        task, inp, out = body.get('task'), _resolve(body.get('input')), _resolve(body.get('output'))
        if task not in ('cutout', 'upscale') or not inp or not out:
            return self._json(400, {'error': 'bad task or path'})
        if not os.path.exists(inp):
            return self._json(400, {'error': 'input missing'})
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        gone = {'v': False}

        def line(obj):
            try:
                self.wfile.write((json.dumps(obj) + '\n').encode())
                self.wfile.flush()
            except OSError:
                gone['v'] = True  # the caller went away (cancelled): stop at the next tile

        last = {'t': 0.0}

        def report(p, stage):
            now = time.time()
            if now - last['t'] > 0.25 or p >= 0.95:
                last['t'] = now
                line({'progress': round(p, 3), 'stage': stage})

        line({'progress': 0, 'stage': 'queued'})
        with RUN_LOCK:
            t0 = time.time()
            try:
                if task == 'cutout':
                    res = cutout(inp, out, report, lambda: gone['v'])
                else:
                    res = upscale(inp, out, body.get('scale') or 2, report, lambda: gone['v'])
                res['ms'] = round((time.time() - t0) * 1000)
                line({'done': res})
            except Cancelled:
                line({'error': 'dibatalkan'})
            except MemoryError:
                SESSIONS.clear()
                gc.collect()
                line({'error': 'memori server tidak cukup untuk gambar ini'})
            except Exception as e:  # noqa: BLE001
                log('run failed', task, repr(e))
                line({'error': str(e)[:300] or e.__class__.__name__})
            finally:
                gc.collect()


def main():
    global ARGS, AI_DIR, MODELS_DIR
    p = argparse.ArgumentParser()
    p.add_argument('--host', default=os.environ.get('NAJJA_AI_HOST', '127.0.0.1'))
    p.add_argument('--port', type=int, default=int(os.environ.get('NAJJA_AI_PORT', '8099')))
    p.add_argument('--data', default=os.environ.get('NAJJA_DATA_DIR', '/data'))
    p.add_argument('--models', default=os.environ.get('NAJJA_AI_MODELS', ''))
    p.add_argument('--no-download', action='store_true', help='do not fetch missing models at start')
    p.add_argument('--exit-with-parent', action='store_true', help='stop when the process that started it is gone')
    ARGS = p.parse_args()
    AI_DIR = os.path.realpath(os.path.join(ARGS.data, 'ai'))
    MODELS_DIR = os.path.realpath(ARGS.models or os.path.join(ARGS.data, 'models'))
    os.makedirs(AI_DIR, exist_ok=True)
    os.makedirs(MODELS_DIR, exist_ok=True)
    refresh_states()
    if not ARGS.no_download and not os.environ.get('NAJJA_AI_NO_DOWNLOAD'):
        ensure(default_models())
    threading.Thread(target=release_idle, daemon=True).start()
    if ARGS.exit_with_parent:
        parent = os.getppid()

        def watch():
            while True:
                time.sleep(2)
                if os.getppid() != parent:
                    os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    srv.daemon_threads = True
    print(f'NAJJA-AI LISTENING {srv.server_address[1]}', flush=True)
    log('models in', MODELS_DIR, '· memory', memory(), '· cutout model', cutout_model())
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
