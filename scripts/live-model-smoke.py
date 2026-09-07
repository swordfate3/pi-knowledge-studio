#!/usr/bin/env python3
"""Opt-in public-model smoke; isolated artifacts, no production service or KB data.
Run download with stdlib Python, then run with the isolated CPU venv (see docs).
"""
import argparse
import base64
import gc
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = Path('/tmp/studio-model-validation')
REPO = Path(__file__).resolve().parents[1]
MODELS = {
    'reranker': ('cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
                 '1427fd652930e4ba29e8149678df786c240d8825'),
    'vision': ('HuggingFaceTB/SmolVLM-256M-Instruct',
               '7e3e67edbbed1bf9888184d9df282b700a323964'),
}


def fetch(url, destination):
    """Two bounded attempts total: configured proxy, then direct; normal TLS."""
    partial = destination.with_suffix(destination.suffix + '.part')
    for direct in (False, True):
        command = ['curl', '--fail', '--location', '--connect-timeout', '15',
                   '--max-time', '600', '--retry', '0', '--continue-at', '-',
                   '--output', str(partial)]
        if direct:
            command += ['--noproxy', '*']
        with (ROOT / 'downloads.log').open('a') as log:
            log.write(f'\n{destination.name} direct={direct}\n')
            log.flush()
            result = subprocess.run(command + [url], stdout=log, stderr=log,
                                    timeout=620, check=False)
        if result.returncode == 0:
            partial.replace(destination)
            return
    raise RuntimeError(f'Download blocked: {destination.name}; see downloads.log')


def fetch_ranges(url, destination, size):
    """At most 8 MiB per chunk, two attempts/chunk, 12-minute invocation cap.

    Preserve contiguous bytes only after exact Content-Range validation. Full
    pinned metadata hash is checked by the caller before any model is loaded.
    """
    partial = destination.with_suffix(destination.suffix + '.part')
    deadline = time.monotonic() + 720
    while (partial.stat().st_size if partial.exists() else 0) < size:
        start = partial.stat().st_size if partial.exists() else 0
        end = min(size - 1, start + 8 * 1024**2 - 1)
        advanced = False
        for direct in (False, True):
            remaining = int(deadline - time.monotonic())
            if remaining <= 0:
                raise RuntimeError('12-minute range-download budget exhausted; partial retained')
            chunk = destination.with_suffix('.chunk')
            headers = destination.with_suffix('.headers')
            command = ['curl', '--http1.1', '--fail', '--location', '--retry', '0',
                       '--connect-timeout', '15', '--max-time', str(min(90, remaining)),
                       '--range', f'{start}-{end}', '--dump-header', str(headers),
                       '--output', str(chunk)]
            if direct:
                command += ['--noproxy', '*']
            # Different ranges must not reuse an intermediary's cached response.
            with (ROOT / 'downloads.log').open('a') as log:
                log.write(f'\n{destination.name} range={start}-{end} direct={direct}\n')
                log.flush()
                result = subprocess.run(command + [url + f'?range_start={start}'],
                                        stdout=log, stderr=log, timeout=min(90, remaining) + 5,
                                        check=False)
            expected = f'content-range: bytes {start}-{end}/{size}'
            received = headers.read_text().lower().splitlines() if headers.exists() else []
            # Redirect headers may contain signed URLs: never retain them.
            headers.unlink(missing_ok=True)
            if (result.returncode == 0 and expected in received and chunk.exists()
                    and chunk.stat().st_size == end - start + 1):
                with partial.open('ab') as output, chunk.open('rb') as source:
                    shutil.copyfileobj(source, output)
                advanced = True
            chunk.unlink(missing_ok=True)
            if advanced:
                break
        if not advanced:
            raise RuntimeError(f'Range {start}-{end} blocked after proxy/direct attempts; partial retained')
    if partial.stat().st_size != size:
        raise RuntimeError('Partial file size exceeds pinned metadata')
    partial.replace(destination)


def verified_file(path, entry):
    data = path.read_bytes()
    if 'lfs' in entry:
        expected = entry['lfs']['sha256']
        actual = hashlib.sha256(data).hexdigest()
        valid = len(data) == entry['lfs']['size'] and actual == expected
    else:
        expected = entry['blobId']
        # Git's published blob ID is SHA-1; additionally retain SHA-256 below.
        actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data,
                              usedforsecurity=False).hexdigest()
        valid = actual == expected
    if not valid:
        raise RuntimeError(f'Hash mismatch: {path}')
    return {'file': entry['rfilename'], 'bytes': len(data),
            'metadataHash': expected, 'sha256': hashlib.sha256(data).hexdigest()}


def manifest(kind):
    model, revision = MODELS[kind]
    metadata = json.loads((ROOT / f'{kind}-metadata.json').read_text())
    if metadata['sha'] != revision or metadata['id'] != model:
        raise RuntimeError('Metadata identity mismatch')
    # Only root configuration/tokenizer files and safetensors; never pickle/code.
    files = [e for e in metadata['siblings'] if '/' not in e['rfilename'] and
             (e['rfilename'].endswith(('.json', '.txt', '.model')) or
              e['rfilename'] == 'model.safetensors')]
    return model, revision, files


def download(selected):
    if shutil.disk_usage(ROOT).free < 4 * 1024**3:
        raise RuntimeError('Need at least 4 GiB free disk')
    for kind in selected:
        model, revision = MODELS[kind]
        metadata = ROOT / f'{kind}-metadata.json'
        if not metadata.exists():
            fetch(f'https://huggingface.co/api/models/{model}/revision/{revision}?blobs=true', metadata)
        model, revision, files = manifest(kind)
        directory = ROOT / kind
        directory.mkdir(exist_ok=True)
        records = []
        for entry in files:
            path = directory / entry['rfilename']
            if not path.exists():
                url = f'https://huggingface.co/{model}/resolve/{revision}/{entry["rfilename"]}'
                if entry.get('lfs', {}).get('size', 0) > 8 * 1024**2:
                    fetch_ranges(url, path, entry['lfs']['size'])
                else:
                    fetch(url, path)
            records.append(verified_file(path, entry))
            print(kind, path.name, 'verified', flush=True)
        (ROOT / f'{kind}-hashes.json').write_text(json.dumps(records, indent=2) + '\n')


def download_mirror(selected, budget_seconds=900):
    """Credential-free exact-revision recovery; one shared 15-minute budget.

    Retained upstream metadata is mandatory. Probe each large file once before
    resuming it; never fall back to upstream or retry a failed mirror request.
    """
    deadline = time.monotonic() + budget_seconds
    environment = {k: v for k, v in os.environ.items() if not any(
        word in k.lower() for word in ('proxy', 'token', 'secret', 'password', 'api_key'))}
    if shutil.disk_usage(ROOT).free < 4 * 1024**3:
        raise RuntimeError('Need at least 4 GiB free disk')

    def request(url, output, size, start=None, end=None):
        remaining = int(deadline - time.monotonic())
        if remaining <= 0:
            raise RuntimeError('Shared 15-minute mirror budget exhausted; partial retained')
        headers = ROOT / 'mirror-transfer.headers'
        command = ['curl', '-q', '--proxy', '', '--noproxy', '*',
                   '--proto', '=https', '--proto-redir', '=https',
                   '--fail', '--location', '--retry', '0', '--connect-timeout', '15',
                   '--max-time', str(min(90, remaining)),
                   # curl also checks redirect bodies; final bytes/hash stay exact.
                   '--max-filesize', str(max(size, 65536)),
                   '--dump-header', str(headers), '--output', str(output)]
        if start is not None:
            command += ['--range', f'{start}-{end}']
            url += f'?range_start={start}&range_end={end}'
        try:
            with (ROOT / 'mirror-downloads.log').open('a') as log:
                log.write(f'\n{url}\n')
                log.flush()
                result = subprocess.run(command + [url], env=environment,
                                        stdout=log, stderr=log,
                                        timeout=min(90, remaining) + 2, check=False)
            received = headers.read_text().lower().splitlines() if headers.exists() else []
            if result.returncode != 0:
                raise RuntimeError(f'Mirror curl {result.returncode}: {output.name}; no retry')
            if not output.exists() or output.stat().st_size != size:
                raise RuntimeError(f'Mirror size mismatch: {output.name}')
            if start is not None and f'content-range: bytes {start}-{end}/{total}' not in received:
                raise RuntimeError(f'Mirror Content-Range mismatch: {output.name}')
        finally:
            # Redirects can contain temporary signed URLs; do not retain them.
            headers.unlink(missing_ok=True)

    for kind in selected:
        model, revision, files = manifest(kind)  # Never obtain trust metadata from mirror.
        directory = ROOT / kind
        directory.mkdir(exist_ok=True)
        records = []
        for entry in files:
            path = directory / entry['rfilename']
            url = f'https://hf-mirror.com/{model}/resolve/{revision}/{entry["rfilename"]}'
            total = entry.get('lfs', {}).get('size', entry['size'])
            if not path.exists():
                partial = path.with_suffix(path.suffix + '.part')
                if total > 8 * 1024**2:
                    probe = path.with_suffix('.mirror-probe')
                    request(url, probe, 65536, 0, 65535)
                    while (partial.stat().st_size if partial.exists() else 0) < total:
                        start = partial.stat().st_size if partial.exists() else 0
                        end = min(total - 1, start + 8 * 1024**2 - 1)
                        chunk = path.with_suffix('.mirror-chunk')
                        request(url, chunk, end - start + 1, start, end)
                        with partial.open('ab') as output, chunk.open('rb') as source:
                            shutil.copyfileobj(source, output)
                        chunk.unlink()
                        print(kind, path.name, partial.stat().st_size, '/', total, flush=True)
                else:
                    request(url, partial, total)
                # Promotion happens only after final upstream hash verification.
                verified_file(partial, entry)
                partial.replace(path)
            records.append(verified_file(path, entry))
            print(kind, path.name, 'verified', flush=True)
        (ROOT / f'{kind}-hashes.json').write_text(json.dumps(records, indent=2) + '\n')


def infer(kind, body):
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    from transformers import AutoModelForVision2Seq, AutoProcessor
    from PIL import Image
    directory = str(ROOT / kind)
    options = {'local_files_only': True, 'trust_remote_code': False}
    started = time.monotonic()
    if body['model'] != MODELS[kind][0]:
        raise ValueError('Unexpected model')
    with torch.inference_mode():
        if kind == 'reranker':
            tokenizer = AutoTokenizer.from_pretrained(directory, **options)
            model = AutoModelForSequenceClassification.from_pretrained(
                directory, use_safetensors=True, **options).to('cpu').eval()
            documents = body['documents']
            if len(documents) != 3 or body['top_n'] != 3:
                raise ValueError('Only the three-candidate smoke is allowed')
            inputs = tokenizer([body['query']] * len(documents), documents,
                               padding=True, truncation=True, max_length=128,
                               return_tensors='pt')
            scores = model(**inputs).logits.flatten().tolist()
            result = {'results': sorted(
                [{'index': i, 'relevance_score': score} for i, score in enumerate(scores)],
                key=lambda row: row['relevance_score'], reverse=True)}
        else:
            processor = AutoProcessor.from_pretrained(directory, **options)
            model = AutoModelForVision2Seq.from_pretrained(
                directory, torch_dtype=torch.float32, use_safetensors=True,
                attn_implementation='eager', **options).to('cpu').eval()
            content = body['messages'][-1]['content']
            data_url = next(item['image_url']['url'] for item in content if item['type'] == 'image_url')
            prefix = 'data:image/png;base64,'
            if not data_url.startswith(prefix):
                raise ValueError('Only inline PNG allowed')
            image = Image.open(io.BytesIO(base64.b64decode(data_url[len(prefix):], validate=True))).convert('RGB')
            if image.size != (256, 256):
                raise ValueError('Only synthetic 256px fixture allowed')
            prompt = next(item['text'] for item in content if item['type'] == 'text')
            # SmolVLM template has no system turn: preserve it as user text.
            messages = [{'role': 'user', 'content': [
                {'type': 'image'}, {'type': 'text', 'text': body['messages'][0]['content'] + '\n' + prompt}]}]
            text = processor.apply_chat_template(messages, add_generation_prompt=True)
            inputs = processor(text=text, images=[image], return_tensors='pt')
            output = model.generate(**inputs, max_new_tokens=64, do_sample=False)
            generated = output[0, inputs['input_ids'].shape[1]:]
            answer = processor.decode(generated, skip_special_tokens=True).strip()
            eos = model.generation_config.eos_token_id
            eos_ids = eos if isinstance(eos, list) else [eos]
            stopped = int(generated[-1]) in eos_ids
            result = {'choices': [{'finish_reason': 'stop' if stopped else 'length',
                                   'message': {'role': 'assistant', 'content': answer}}]}
    elapsed = round(time.monotonic() - started, 3)
    del model, inputs
    gc.collect()
    return result, elapsed


def run(selected):
    for key in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        os.environ[key] = '2'
    os.environ.update(HF_HOME=str(ROOT / 'hf-cache'), HF_HUB_OFFLINE='1',
                      TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false',
                      HF_HUB_DISABLE_TELEMETRY='1', CUDA_VISIBLE_DEVICES='')
    import torch
    torch.set_num_threads(2)
    if torch.get_num_interop_threads() != 2:
        torch.set_num_interop_threads(2)
    if torch.version.cuda is not None:
        raise RuntimeError('CPU-only torch required')
    available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemAvailable:'))
    if available < 3 * 1024**2:
        raise RuntimeError('Need at least 3 GiB available RAM')
    for kind in selected:
        for entry in manifest(kind)[2]:
            verified_file(ROOT / kind / entry['rfilename'], entry)
    results = {'models': MODELS, 'torch': torch.__version__, 'threads': 2,
               'requests': {}, 'status': 'started'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            kind = {'/rerank': 'reranker', '/v1/chat/completions': 'vision'}.get(self.path)
            try:
                if kind not in selected or kind in results['requests']:
                    raise ValueError('Unknown or repeated request')
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length < 2 * 1024**2:
                    raise ValueError('Request budget exceeded')
                body = json.loads(self.rfile.read(length))
                results['requests'][kind] = {'status': 'started'}
                worker = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve()), 'infer', '--kind', kind],
                    input=json.dumps(body), capture_output=True, text=True, timeout=170,
                    check=False)
                (ROOT / f'{kind}-inference.log').write_text(worker.stderr)
                if worker.returncode != 0:
                    raise RuntimeError(f'{kind} inference failed; see inference log')
                value, seconds = json.loads(worker.stdout)
                results['requests'][kind] = {'seconds': seconds, 'response': value}
                payload = json.dumps(value).encode()
                self.send_response(200)
            except Exception as error:
                results['error'] = f'{type(error).__name__}: {error}'
                payload = json.dumps({'error': results['error']}).encode()
                self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    driver = ROOT / 'adapter-smoke.mjs'
    driver.write_text('''import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [repo, root, port, kind] = process.argv.slice(2);
const { HttpReranker } = await import(pathToFileURL(`${repo}/src/adapters/models/http-reranker.ts`));
const { describeImage, visionFingerprints } = await import(pathToFileURL(`${repo}/src/adapters/models/grounded-model.ts`));
const base = `http://127.0.0.1:${port}`;
const models = JSON.parse(readFileSync(`${root}/models.json`, 'utf8'));
if (kind === "reranker") {
const ranker = new HttpReranker({ endpoint: `${base}/rerank`, model: models.reranker[0], revision: models.reranker[1], approved: true, timeoutMs: 180000 });
const query = '如何让任务等待信号量而不占用CPU？';
const candidates = [
 { id: 'unrelated', text: '番茄炒蛋需要鸡蛋和番茄。' },
 { id: 'relevant', text: '任务调用信号量获取函数并设置等待时间，信号量不可用时进入阻塞态，让其他任务运行。' },
 { id: 'busy', text: '任务在死循环中持续检查标志位，会一直占用CPU。' }
];
const reranking = await ranker.rerank(query, candidates);
writeFileSync(`${root}/reranker-adapter-result.json`, JSON.stringify({ query, candidates, identity: ranker.identity, reranking }, null, 2));
} else {
const image = readFileSync(`${root}/synthetic.png`);
const config = { endpoint: `${base}/v1/chat/completions`, model: models.vision[0], approved: true, timeoutMs: 180000 };
const prompt = 'Describe the shapes and their colors in this image briefly.';
const description = await describeImage(config, image, prompt);
writeFileSync(`${root}/vision-adapter-result.json`, JSON.stringify({ description, prompt, imageSha256: createHash('sha256').update(image).digest('hex'), fingerprints: visionFingerprints(config, prompt, models.vision[1]), endpoint: config.endpoint }, null, 2));
}
''')
    from PIL import Image, ImageDraw
    image = Image.new('RGB', (256, 256), 'white')
    draw = ImageDraw.Draw(image)
    draw.rectangle((25, 75, 105, 155), fill='red')
    draw.ellipse((145, 75, 225, 155), fill='blue')
    image.save(ROOT / 'synthetic.png')
    (ROOT / 'models.json').write_text(json.dumps(MODELS))
    server = HTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_port  # OS-selected free port, fixed for this run.
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    try:
        thread.start()
        result = subprocess.run(['node', '--experimental-strip-types', str(driver),
                                 str(REPO), str(ROOT), str(port), selected[0]], timeout=190,
                                capture_output=True, text=True, check=False)
        (ROOT / f'{selected[0]}-node.log').write_text(result.stdout + result.stderr)
        results['nodeExitCode'] = result.returncode
        results['status'] = 'passed' if result.returncode == 0 else 'failed'
    finally:
        if thread.is_alive():
            server.shutdown()
            thread.join(timeout=5)
        server.server_close()
        results['serverClosed'] = True
        (ROOT / f'{selected[0]}-results.json').write_text(json.dumps(results, indent=2) + '\n')
    if results['status'] != 'passed':
        raise RuntimeError('Actual adapter smoke failed; see results.json and node.log')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['download', 'download-mirror', 'run', 'infer'])
    parser.add_argument('--kind', choices=list(MODELS))
    parser.add_argument('--mirror-budget-seconds', type=int, default=900,
                        choices=range(1, 901), metavar='1..900')
    args = parser.parse_args()
    ROOT.mkdir(exist_ok=True)
    if args.action == 'download-mirror':
        try:
            download_mirror([args.kind] if args.kind else list(MODELS),
                            args.mirror_budget_seconds)
        except Exception as error:
            (ROOT / 'mirror-download-error.txt').write_text(str(error) + '\n')
            print(str(error), file=sys.stderr)
            sys.exit(1)
    elif args.action == 'download':
        failed = False
        for kind in ([args.kind] if args.kind else list(MODELS)):
            try:
                download([kind])
            except Exception as error:
                failed = True
                (ROOT / f'{kind}-download-error.txt').write_text(str(error) + '\n')
                print(f'{kind}: {error}', file=sys.stderr)
        if failed:
            sys.exit(1)
    elif args.action == 'infer':
        if not args.kind or os.environ.get('HF_HUB_OFFLINE') != '1':
            parser.error('infer is an internal offline subprocess mode')
        import torch
        torch.set_num_threads(2)
        torch.set_num_interop_threads(2)
        print(json.dumps(infer(args.kind, json.load(sys.stdin))))
    else:
        failed = False
        for kind in ([args.kind] if args.kind else list(MODELS)):
            try:
                run([kind])
            except Exception as error:
                failed = True
                (ROOT / f'{kind}-run-error.txt').write_text(str(error) + '\n')
                print(f'{kind}: {error}', file=sys.stderr)
        if failed:
            sys.exit(1)
