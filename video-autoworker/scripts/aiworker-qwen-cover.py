#!/usr/bin/env python3
"""Verify and run the isolated, pinned Qwen cover quality candidate."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import struct
import sys
import time
import uuid
import unicodedata


MODEL_ROOT = Path('/Users/heisenbergs-1/models/qwen-image-edit-2511')
OUTPUT_ROOT = Path('/Users/heisenbergs-1/ai-worker/output/covers')
REPOSITORY = 'Qwen/Qwen-Image-Edit-2511'
REVISION = '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'
EXPECTED_BYTES = 57_720_454_694
SNAPSHOT = MODEL_ROOT / 'hf-home/hub/models--Qwen--Qwen-Image-Edit-2511/snapshots' / REVISION
DESIGN_PROFILES = Path(__file__).with_name('cover-design-profiles.json')
TEXT_FIELDS = ('kicker', 'title', 'subtitle', 'caption')


def cover_design_prompt(design, profiles):
    """Compile a reusable design specification; this never renders pixels."""
    if (not isinstance(design, dict)
            or design.get('schema') != 'aiworker-qwen-cover-design/v1'
            or set(design) - {'schema', 'profile', 'text', 'scene'}):
        raise ValueError('qwen_cover_design_invalid')
    if (not isinstance(profiles, dict)
            or profiles.get('schema') != 'aiworker-qwen-cover-profiles/v1'):
        raise ValueError('qwen_cover_profiles_invalid')
    profile_name = design.get('profile')
    definitions = profiles.get('profiles')
    if not isinstance(profile_name, str) or not isinstance(definitions, dict):
        raise ValueError('qwen_cover_profile_unknown')
    profile = definitions.get(profile_name)
    if not isinstance(profile, dict):
        raise ValueError('qwen_cover_profile_unknown')
    text_fields = design.get('text')
    if not isinstance(text_fields, dict) or set(text_fields) != set(TEXT_FIELDS):
        raise ValueError('qwen_cover_text_fields_invalid')
    for key, maximum in zip(TEXT_FIELDS, (16, 24, 40, 64)):
        value = text_fields[key]
        if (not isinstance(value, str) or not 0 < len(value) <= maximum
                or value != value.strip()
                or any(unicodedata.category(c).startswith('C') for c in value)):
            raise ValueError('qwen_cover_text_invalid:' + key)
    if len(set(text_fields.values())) != len(TEXT_FIELDS):
        raise ValueError('qwen_cover_text_duplicate')
    scene = design.get('scene', '')
    if (not isinstance(scene, str) or len(scene) > 1000
            or any(unicodedata.category(c).startswith('C') for c in scene)):
        raise ValueError('qwen_cover_scene_invalid')
    instructions = profile.get('instructions')
    styles = profile.get('text_styles')
    acceptance = profile.get('acceptance')
    if (not isinstance(instructions, list) or not instructions
            or not isinstance(styles, dict) or set(styles) != set(TEXT_FIELDS)
            or not isinstance(acceptance, list) or not acceptance
            or any(not isinstance(v, str) or not v
                   for v in [*instructions, *styles.values(), *acceptance])):
        raise ValueError('qwen_cover_profile_contract_invalid')
    lines = ['生成完整的视频封面，画面与所有文字都由模型直接输出。',
             '图1只提供人物和场景。若提供图2，它只指导字体材质、层次和设计风格；',
             '不复制图2的人物身份或任何文字，只绘制下面给定的四组文字。',
             *instructions]
    if scene:
        lines.append('本次场景要求：' + scene)
    lines.append('四组文字必须逐字正确、各出现一次；引号只是说明，不画到封面里：')
    labels = ('栏目标签', '主标题', '副标题', '底部说明')
    for key, label in zip(TEXT_FIELDS, labels):
        lines.append(label + '：' + json.dumps(text_fields[key], ensure_ascii=False)
                     + '；' + styles[key])
    lines.extend(['最终画面验收要求：', *acceptance])
    prompt = '\n'.join(lines) + '\n'
    if len(prompt.encode('utf-8')) > 16 * 1024:
        raise ValueError('qwen_cover_compiled_prompt_too_large')
    return prompt


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def private_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.incoming-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)


def specification():
    spec = json.loads((MODEL_ROOT / 'asset-spec.json').read_text())
    if (spec.get('repository') != REPOSITORY or spec.get('revision') != REVISION
            or spec.get('totalBytes') != EXPECTED_BYTES or len(spec.get('files', [])) != 33):
        raise ValueError('qwen_model_pin_invalid')
    names = [f['path'] for f in spec['files']]
    if len(set(names)) != 33 or any(Path(n).is_absolute() or '..' in Path(n).parts for n in names):
        raise ValueError('qwen_asset_members_invalid')
    return spec


def identity(path):
    st = path.stat()
    return {'dev': st.st_dev, 'ino': st.st_ino, 'bytes': st.st_size,
            'mtimeNs': st.st_mtime_ns, 'ctimeNs': st.st_ctime_ns}


def member_path(name):
    p = (SNAPSHOT / name).resolve(strict=True)
    if not p.is_file() or not p.is_relative_to(MODEL_ROOT.resolve(strict=True)):
        raise ValueError('qwen_asset_escaped_model_root')
    return p


def download():
    """Resume the pinned assets in the same cache, with one writer per model."""
    spec = specification()
    with (MODEL_ROOT / 'download.lock').open('a') as lock:
        os.fchmod(lock.fileno(), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        status_path = MODEL_ROOT / 'download-status.json'
        base = {'repository': REPOSITORY, 'revision': REVISION,
                'totalBytes': EXPECTED_BYTES, 'pid': os.getpid(),
                'startedAt': datetime.now(timezone.utc).isoformat()}
        private_json(status_path, {**base, 'currentState': 'DOWNLOADING',
                                   'nextAction': 'wait_for_cached_asset_resume'})
        started = time.monotonic()
        try:
            os.environ.update({'HF_HOME': str(MODEL_ROOT / 'hf-home'),
                               'HF_HUB_DISABLE_XET': '1', 'HF_HUB_OFFLINE': '0'})
            from huggingface_hub import snapshot_download

            # Hugging Face reuses complete blobs and resumes incomplete files.
            path = snapshot_download(
                repo_id=REPOSITORY, revision=REVISION,
                cache_dir=str(MODEL_ROOT / 'hf-home/hub'),
                allow_patterns=[item['path'] for item in spec['files']],
                max_workers=2)
            if Path(path).resolve() != SNAPSHOT.resolve(strict=True):
                raise ValueError('qwen_download_snapshot_mismatch')
            for item in spec['files']:
                if member_path(item['path']).stat().st_size != item['bytes']:
                    raise ValueError('qwen_download_size_mismatch:' + item['path'])
            result = {**base, 'currentState': 'DOWNLOADED_PENDING_VERIFICATION',
                      'errorCode': None, 'nextAction': 'verify_assets',
                      'elapsedSeconds': round(time.monotonic() - started, 3)}
            private_json(status_path, result)
            return result
        except BaseException as error:
            private_json(status_path, {**base, 'currentState': 'DOWNLOAD_FAILED',
                                      'errorCode': type(error).__name__,
                                      'nextAction': 'inspect_network_and_resume_same_cache',
                                      'elapsedSeconds': round(time.monotonic() - started, 3)})
            raise


def verify():
    spec = specification()
    records = []
    started = time.monotonic()
    for i, item in enumerate(spec['files'], 1):
        p = member_path(item['path'])
        before = identity(p)
        actual = digest(p)
        if before['bytes'] != item['bytes'] or actual != item['sha256'] or identity(p) != before:
            raise ValueError('qwen_asset_integrity_failed:' + item['path'])
        records.append({**item, 'identity': before})
        print(json.dumps({'verifiedFiles': i, 'totalFiles': 33}), flush=True)
    receipt = {'schema': 'aiworker-qwen-model-integrity/v1', 'currentState': 'VERIFIED',
               'repository': REPOSITORY, 'revision': REVISION,
               'assetSpecSha256': digest(MODEL_ROOT / 'asset-spec.json'),
               'files': records, 'totalBytes': EXPECTED_BYTES,
               'elapsedSeconds': round(time.monotonic() - started, 3)}
    private_json(MODEL_ROOT / 'model-integrity.json', receipt)
    return {'currentState': 'VERIFIED', 'files': 33, 'totalBytes': EXPECTED_BYTES,
            'elapsedSeconds': receipt['elapsedSeconds']}


def readiness():
    spec = specification()
    receipt = json.loads((MODEL_ROOT / 'model-integrity.json').read_text())
    if (receipt.get('currentState') != 'VERIFIED' or receipt.get('revision') != REVISION
            or receipt.get('assetSpecSha256') != digest(MODEL_ROOT / 'asset-spec.json')
            or len(receipt.get('files', [])) != 33 or version('diffusers') != '0.40.0'
            or version('torch') != '2.14.0' or version('transformers') != '5.17.0'):
        raise ValueError('qwen_candidate_not_verified')
    by_name = {f['path']: f for f in receipt['files']}
    for item in spec['files']:
        old = by_name.get(item['path'])
        if not old or old['sha256'] != item['sha256'] or identity(member_path(item['path'])) != old['identity']:
            raise ValueError('qwen_asset_identity_drift:' + item['path'])
    return {'currentState': 'READY', 'repository': REPOSITORY, 'revision': REVISION,
            'diffusersVersion': version('diffusers'), 'torchVersion': version('torch'),
            'backend': 'Apple MPS', 'precision': 'BF16', 'offline': True}


def checked_input(path, maximum):
    p = Path(path).expanduser().resolve(strict=True)
    if not p.is_file() or not 0 < p.stat().st_size <= maximum:
        raise ValueError('qwen_input_invalid')
    return p


def generate(args):
    ready = readiness()
    design_file = getattr(args, 'design_file', None)
    if design_file:
        design_path = checked_input(design_file, 16 * 1024)
        profiles_path = checked_input(getattr(args, 'profiles_file', None) or DESIGN_PROFILES, 16 * 1024)
        design = json.loads(design_path.read_text(encoding='utf-8'))
        profiles = json.loads(profiles_path.read_text(encoding='utf-8'))
        prompt_text = cover_design_prompt(design, profiles)
        prompt_inputs = [design_path, profiles_path]
        design_metadata = {'designProfile': design['profile'], 'expectedText': design['text'],
                           'designAcceptance': profiles['profiles'][design['profile']]['acceptance']}
    else:
        if getattr(args, 'profiles_file', None):
            raise ValueError('qwen_profiles_require_design_file')
        prompt = checked_input(args.prompt_file, 16 * 1024)
        prompt_text = prompt.read_text(encoding='utf-8')
        prompt_inputs = [prompt]
        design_metadata = {}
    images = [checked_input(p, 20 * 1024 * 1024) for p in args.images]
    if not 1 <= len(images) <= 3:
        raise ValueError('qwen_reference_count_invalid')
    if any(p.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp') for p in images):
        raise ValueError('qwen_reference_format_invalid')
    if not 1 <= args.steps <= 60 or not 1 <= args.guidance <= 8 or not 0 <= args.seed < 2**31:
        raise ValueError('qwen_generation_parameters_invalid')
    if any(not 512 <= n <= 2048 or n % 16 for n in (args.width, args.height)):
        raise ValueError('qwen_dimensions_must_align_16')
    output = Path(args.output).expanduser()
    if not output.is_absolute() or output.suffix.lower() != '.png':
        raise ValueError('qwen_output_must_be_absolute_png')
    if not output.resolve().is_relative_to(OUTPUT_ROOT.resolve(strict=True)):
        raise ValueError('qwen_output_outside_cover_root')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not output.parent.resolve().is_relative_to(OUTPUT_ROOT.resolve(strict=True)):
        raise ValueError('qwen_output_parent_escaped')
    receipt_path = output.with_suffix('.receipt.json')
    intent = output.with_suffix('.intent.json')
    if any(p.exists() for p in (output, receipt_path, intent)):
        raise FileExistsError('qwen_output_or_intent_already_exists')
    inputs = [{'path': str(p), 'sha256': digest(p)} for p in [*prompt_inputs, *images]]
    private_json(intent, {'currentState': 'RUNNING', 'pid': os.getpid(),
                          'repository': REPOSITORY, 'revision': REVISION,
                          'seed': args.seed, 'output': str(output)})
    os.environ.update({'HF_HOME': str(MODEL_ROOT / 'hf-home'),
                       'XDG_CACHE_HOME': str(MODEL_ROOT / 'xdg-cache'),
                       'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'})
    started = time.monotonic()
    temporary_output = output.with_name(output.stem + '.incoming-' + uuid.uuid4().hex + '.png')
    try:
        import torch
        from PIL import Image
        from diffusers import QwenImageEditPlusPipeline

        if not torch.backends.mps.is_available():
            raise RuntimeError('qwen_mps_unavailable')
        # Official 2511 implementation preserves reference-token zero-time conditioning.
        pipeline = QwenImageEditPlusPipeline.from_pretrained(
            str(SNAPSHOT), torch_dtype=torch.bfloat16,
            local_files_only=True, use_safetensors=True).to('mps')
        dtypes = {name: str(next(getattr(pipeline, name).parameters()).dtype)
                  for name in ('transformer', 'text_encoder', 'vae')}
        if any(value != 'torch.bfloat16' for value in dtypes.values()):
            raise RuntimeError('qwen_runtime_precision_mismatch')

        def heartbeat(_pipeline, step, _timestep, values):
            private_json(intent, {'currentState': 'RUNNING', 'pid': os.getpid(),
                                  'completedSteps': step + 1, 'totalSteps': args.steps,
                                  'elapsedSeconds': round(time.monotonic() - started, 3),
                                  'mpsAllocatedBytes': torch.mps.current_allocated_memory()})
            return values

        references = [Image.open(p) for p in images]
        try:
            image = pipeline(image=references, prompt=prompt_text,
                             generator=torch.Generator(device='cpu').manual_seed(args.seed),
                             num_inference_steps=args.steps, true_cfg_scale=args.guidance,
                             negative_prompt=' ', guidance_scale=1.0,
                             width=args.width, height=args.height,
                             callback_on_step_end=heartbeat).images[0]
            image.save(temporary_output, format='PNG')
        finally:
            for reference in references:
                reference.close()
        with temporary_output.open('rb') as f:
            header = f.read(24)
        if (header[:8] != b'\x89PNG\r\n\x1a\n'
                or struct.unpack('>II', header[16:24]) != (args.width, args.height)):
            raise ValueError('qwen_generated_image_dimensions_mismatch')
        if any(digest(Path(item['path'])) != item['sha256'] for item in inputs):
            raise ValueError('qwen_input_changed_during_generation')
        temporary_output.chmod(0o600)
        os.link(temporary_output, output)
        temporary_output.unlink()
        result = {**ready, **design_metadata, 'schema': 'aiworker-qwen-cover-result/v1',
                  'currentState': 'GENERATED_PENDING_REVIEW', 'errorCode': None,
                  'nextAction': 'review_raw_image_and_exact_chinese_text', 'inputs': inputs,
                  'output': str(output), 'outputBytes': output.stat().st_size,
                  'outputSha256': digest(output), 'postProcessing': False,
                  'width': args.width, 'height': args.height, 'steps': args.steps,
                  'guidance': args.guidance, 'seed': args.seed,
                  'promptSha256': hashlib.sha256(prompt_text.encode('utf-8')).hexdigest(),
                  'elapsedSeconds': round(time.monotonic() - started, 3),
                  'componentDtypes': dtypes,
                  'mpsAllocatedBytes': torch.mps.current_allocated_memory(),
                  'mpsDriverAllocatedBytes': torch.mps.driver_allocated_memory()}
        private_json(receipt_path, result)
        private_json(intent, {'currentState': 'GENERATED_PENDING_REVIEW',
                              'outputSha256': result['outputSha256'], 'pid': os.getpid()})
        return result
    except BaseException as error:
        private_json(intent, {'currentState': 'CANCELLED' if isinstance(error, KeyboardInterrupt) else 'FAILED',
                              'errorCode': type(error).__name__, 'pid': os.getpid(),
                              'elapsedSeconds': round(time.monotonic() - started, 3)})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('download')
    sub.add_parser('verify-assets')
    sub.add_parser('status')
    p = sub.add_parser('generate')
    prompt_source = p.add_mutually_exclusive_group(required=True)
    prompt_source.add_argument('--prompt-file')
    prompt_source.add_argument('--design-file')
    p.add_argument('--profiles-file', help='Defaults to the installed design profiles next to this script')
    p.add_argument('--images', nargs='+', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--width', type=int, default=1280)
    p.add_argument('--height', type=int, default=720)
    p.add_argument('--steps', type=int, default=40)
    p.add_argument('--guidance', type=float, default=4.0)
    p.add_argument('--seed', type=int, default=111)
    args = parser.parse_args()
    try:
        result = (download() if args.action == 'download' else
                  verify() if args.action == 'verify-assets' else
                  readiness() if args.action == 'status' else generate(args))
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({'currentState': 'FAILED', 'errorCode': str(error),
                          'nextAction': 'inspect_candidate_inputs_and_runtime'}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
