"""Photo-preserving composition of locally generated pixels.

No fonts are rendered here. Glyphs and erased-region pixels come from the
pinned model; this module only validates, keys, fits and composites them.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import unicodedata

import numpy as np
from PIL import Image, ImageOps

SCHEMA = 'aiworker-protected-cover/v1'
RESULT_SCHEMA = 'aiworker-protected-cover-result/v1'
MAX_SOURCE_PIXELS = 24 * 1024 * 1024
MAX_SOURCE_BYTES = 40 * 1024 * 1024
MAX_SIDE = 8192
RECT_KEYS = {'x', 'y', 'width', 'height'}
TEXT_ROLES = {'kicker', 'title', 'subtitle', 'caption'}


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def source_image(data):
    if not isinstance(data, bytes) or not 0 < len(data) <= MAX_SOURCE_BYTES:
        raise ValueError('protected_source_size_invalid')
    try:
        with Image.open(io.BytesIO(data)) as raw:
            if raw.format not in ('PNG', 'JPEG', 'WEBP') or getattr(raw, 'n_frames', 1) != 1:
                raise ValueError('protected_source_format_invalid')
            if max(raw.size) > MAX_SIDE or raw.width * raw.height > MAX_SOURCE_PIXELS:
                raise ValueError('protected_source_dimensions_invalid')
            # Canonical displayed pixels, not JPEG/PNG encoding bytes, are the
            # authority used by the independent protection verification.
            normalized = ImageOps.exif_transpose(raw)
            if normalized.mode not in ('RGB', 'RGBA'):
                raise ValueError('protected_source_rgb_photo_required')
            if 'A' in normalized.getbands() and normalized.getchannel('A').getextrema() != (255, 255):
                raise ValueError('protected_source_must_be_opaque_photo')
            image = normalized.convert('RGB')
            image.load()
            if min(image.size) < 64:
                raise ValueError('protected_source_dimensions_invalid')
            image.info['icc_profile'] = raw.info.get('icc_profile', b'')
            return image
    except (OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise ValueError('protected_source_decode_failed') from error


def checked_rect(value, size):
    if not isinstance(value, dict) or set(value) != RECT_KEYS:
        raise ValueError('protected_region_invalid')
    if any(type(value[k]) is not int for k in RECT_KEYS):
        raise ValueError('protected_region_invalid')
    x, y, w, h = (value[k] for k in ('x', 'y', 'width', 'height'))
    if min(x, y) < 0 or min(w, h) < 1 or x + w > size[0] or y + h > size[1]:
        raise ValueError('protected_region_outside_source')
    return {'x': x, 'y': y, 'width': w, 'height': h}


def _clean_text(value, maximum, field):
    if (not isinstance(value, str) or not 0 < len(value) <= maximum
            or value != value.strip() or any(unicodedata.category(c).startswith('C') for c in value)):
        raise ValueError('protected_' + field + '_invalid')
    return value


def default_text_role(index, count):
    """Give new protected cover requests a stable editorial hierarchy."""
    if index == 0:
        return 'title'
    if index == 1:
        return 'subtitle'
    return 'caption'


def _layout_inset(size):
    return max(12, round(min(size) * .02))


def _layout_minimums(role, size):
    width, height = size
    if role == 'title':
        return max(160, round(width * .30)), max(48, round(height * .10))
    if role == 'subtitle':
        return max(120, round(width * .18)), max(24, round(height * .035))
    if role == 'kicker':
        return max(96, round(width * .12)), max(20, round(height * .026))
    return 32, 12


def validate_text_box_layout(box, role, size):
    """Reject a layout that is technically valid but visually undersized."""
    if role not in TEXT_ROLES:
        raise ValueError('protected_text_role_invalid')
    minimum_width, minimum_height = _layout_minimums(role, size)
    if box['width'] < minimum_width or box['height'] < minimum_height:
        raise ValueError('protected_' + role + '_box_too_small')
    if role in {'title', 'subtitle', 'kicker'}:
        inset = _layout_inset(size)
        if (box['x'] < inset or box['y'] < inset
                or box['x'] + box['width'] > size[0] - inset
                or box['y'] + box['height'] > size[1] - inset):
            raise ValueError('protected_' + role + '_unsafe_margin')


def text_layout_summary(size, layers, placements):
    """Bind intended hierarchy to the actual native glyph placement."""
    if len(layers) != len(placements):
        raise ValueError('protected_text_layout_count_invalid')
    if not layers:
        return {'schema': 'aiworker-text-layout/v1', 'safeInset': _layout_inset(size), 'layers': []}
    if any('role' not in layer for layer in layers):
        raise ValueError('protected_text_layout_role_missing')
    title_count = sum(layer['role'] == 'title' for layer in layers)
    if title_count > 1:
        raise ValueError('protected_title_role_duplicate')
    entries = []
    for layer, placement in zip(layers, placements):
        role, box = layer['role'], layer['box']
        placed = placement.get('placedBox')
        if not isinstance(placed, dict) or set(placed) != RECT_KEYS:
            raise ValueError('protected_text_placement_invalid')
        validate_text_box_layout(box, role, size)
        if (placed['x'] < box['x'] or placed['y'] < box['y']
                or placed['x'] + placed['width'] > box['x'] + box['width']
                or placed['y'] + placed['height'] > box['y'] + box['height']):
            raise ValueError('protected_text_placement_outside_box')
        width_fill = round(placed['width'] * 100 / box['width'])
        height_fill = round(placed['height'] * 100 / box['height'])
        if role == 'title':
            minimum_width, minimum_height = _layout_minimums(role, size)
            if (placed['width'] < minimum_width or placed['height'] < minimum_height
                    or width_fill < 60 or height_fill < 60):
                raise ValueError('protected_title_placement_too_small')
        entries.append({'role': role, 'text': layer['text'], 'requestedBox': box,
                        'placedBox': placed, 'widthFillPercent': width_fill,
                        'heightFillPercent': height_fill})
    title = next((entry for entry in entries if entry['role'] == 'title'), None)
    subtitles = [entry for entry in entries if entry['role'] == 'subtitle']
    if title and subtitles:
        if any(title['placedBox']['height'] * 100 < subtitle['placedBox']['height'] * 160
               for subtitle in subtitles):
            raise ValueError('protected_title_subtitle_hierarchy_invalid')
    return {'schema': 'aiworker-text-layout/v1', 'safeInset': _layout_inset(size), 'layers': entries}


def normalize_protected(spec, source_bytes, *, compile_prompt=True, assign_default_roles=False):
    if (not isinstance(spec, dict) or set(spec) - {'schema', 'eraseRegions', 'textLayers'}
            or spec.get('schema') != SCHEMA):
        raise ValueError('protected_spec_invalid')
    image = source_image(source_bytes)
    erases, layers = spec.get('eraseRegions', []), spec.get('textLayers', [])
    if (not isinstance(erases, list) or not isinstance(layers, list)
            or max(len(erases), len(layers)) > 4 or not erases and not layers):
        raise ValueError('protected_edit_count_invalid')
    regions = [checked_rect(r, image.size) for r in erases]
    for r in regions:
        if max(r['width'], r['height']) > 1920:
            raise ValueError('protected_erase_region_too_large')
    texts = []
    for index, value in enumerate(layers):
        if (not isinstance(value, dict) or set(value) - {'text', 'style', 'box', 'align', 'role'}
                or not {'text', 'box'} <= set(value)):
            raise ValueError('protected_text_layer_invalid')
        box = checked_rect(value['box'], image.size)
        if box['width'] < 32 or box['height'] < 12:
            raise ValueError('protected_text_box_too_small')
        align = value.get('align', 'left')
        if align not in ('left', 'center'):
            raise ValueError('protected_text_align_invalid')
        item = {'text': _clean_text(value['text'], 128, 'text'), 'box': box, 'align': align}
        role = value.get('role')
        if role is None and assign_default_roles:
            role = default_text_role(index, len(layers))
        if role is not None:
            if role not in TEXT_ROLES:
                raise ValueError('protected_text_role_invalid')
            validate_text_box_layout(box, role, image.size)
            item['role'] = role
        if 'style' in value:
            item['style'] = _clean_text(value['style'], 1000, 'style')
        texts.append(item)
    if len({r['text'] for r in texts}) != len(texts):
        raise ValueError('protected_text_duplicate')
    all_boxes = [*regions, *[r['box'] for r in texts]]
    for i, a in enumerate(all_boxes):
        for b in all_boxes[i + 1:]:
            if (max(a['x'], b['x']) < min(a['x'] + a['width'], b['x'] + b['width'])
                    and max(a['y'], b['y']) < min(a['y'] + a['height'], b['y'] + b['height'])):
                raise ValueError('protected_edit_regions_overlap')
    if sum(r['width'] * r['height'] for r in all_boxes) > image.width * image.height * .4:
        raise ValueError('protected_edit_area_too_large')
    canonical = {'schema': SCHEMA, 'eraseRegions': regions, 'textLayers': texts}
    if compile_prompt:
        # Each model stage renders one layer. Budget the actual first/retry
        # prompts rather than compiling a multi-line font sample sheet.
        for layer in texts:
            if any(len(font_prompt(layer, retry).encode('utf-8')) > 16 * 1024
                   for retry in (False, True)):
                raise ValueError('protected_font_prompt_too_large')
    return canonical, image.size


def implementation_digest():
    root = Path(__file__).resolve().parents[2]
    names = ('src/image_generation/protected_cover.py', 'src/image_generation/protected_worker.py',
             'src/image_generation/stage_cache.py', 'src/image_generation/font_selection.py',
             'src/image_generation/ocr.py', 'scripts/aiworker-image-ocr.swift')
    records = []
    for name in names:
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise ValueError('protected_implementation_incomplete')
        records.append([name, digest_bytes(path.read_bytes())])
    return digest_bytes(json.dumps(records, separators=(',', ':')).encode())


def edit_mask(size, spec):
    mask = np.zeros((size[1], size[0]), dtype=bool)
    for r in [*spec['eraseRegions'], *[r['box'] for r in spec['textLayers']]]:
        mask[r['y']:r['y'] + r['height'], r['x']:r['x'] + r['width']] = True
    return mask


def protection_summary(source, output, spec):
    if source.mode != 'RGB' or output.mode != 'RGB' or source.size != output.size:
        raise ValueError('protected_output_dimensions_or_mode_invalid')
    before, after = np.asarray(source), np.asarray(output)
    mask = edit_mask(source.size, spec)
    changed = np.any(before != after, axis=2)
    return {'schema': 'aiworker-photo-protection/v1', 'sourceWidth': source.width,
            'sourceHeight': source.height, 'protectedPixels': int((~mask).sum()),
            'changedPixels': int(changed.sum()), 'outsideChangedPixels': int((changed & ~mask).sum()),
            'sourcePixelsSha256': digest_bytes(before.tobytes()),
            'protectedSourceSha256': digest_bytes(before[~mask].tobytes()),
            'protectedOutputSha256': digest_bytes(after[~mask].tobytes())}


def verify_protected_result(source_path, output_path, spec, receipt, *, strict_live=True, stage_cache=None):
    original = Path(source_path).read_bytes()
    # Older sealed results do not have editorial-role evidence. Keep their
    # existing composition readable; new results always carry textLayout.
    has_layout = receipt.get('textLayout') is not None
    canonical, size = normalize_protected(spec, original, compile_prompt=strict_live,
                                         assign_default_roles=has_layout)
    source = source_image(original)
    raw = Path(output_path).read_bytes()
    if (receipt.get('schema') != RESULT_SCHEMA or receipt.get('postProcessing') is not True
            or receipt.get('sourceFileSha256') != digest_bytes(original)
            or receipt.get('outputSha256') != digest_bytes(raw)
            or receipt.get('outputBytes') != len(raw)):
        raise ValueError('protected_result_receipt_invalid')
    with Image.open(io.BytesIO(raw)) as image:
        if image.format != 'PNG' or image.size != size or image.mode != 'RGB':
            raise ValueError('protected_result_image_invalid')
        image.load()
        proof = protection_summary(source, image, canonical)
        final_image = image.copy()
    if proof != receipt.get('photoProtection') or proof['outsideChangedPixels'] != 0:
        raise ValueError('protected_photo_pixels_changed')
    text = receipt.get('textValidation', {})
    if (text.get('matched') is not True or text.get('expectedCount') != len(canonical['textLayers'])
            or text.get('observedCount') != len(canonical['textLayers'])):
        raise ValueError('protected_text_not_verified')
    assets = receipt.get('assets')
    if not isinstance(assets, list) or not assets:
        raise ValueError('protected_native_assets_missing')
    job = Path(output_path).parent
    cached = {}
    if stage_cache is not None:
        from .stage_cache import cached_asset_paths
        cached = cached_asset_paths(stage_cache, job)
        cache_file = job / 'stage-cache.json'
        if cache_file.is_symlink() or digest_bytes(cache_file.read_bytes()) != receipt.get('stageCacheSha256'):
            raise ValueError('protected_stage_cache_changed')
    elif receipt.get('stageCacheSha256') is not None:
        raise ValueError('protected_stage_cache_missing')
    decoded = {}
    for asset in assets:
        p = checked_native_file(Path(asset.get('path', '')), job, cached)
        entry = cached.get(str(p))
        if (p.name != 'model.png' or not entry and p.parent.parent != job / 'stages'
                or digest_bytes(p.read_bytes()) != asset.get('sha256')):
            raise ValueError('protected_native_asset_changed')
        if entry:
            if (asset.get('cacheSourceJobId') != entry['sourceJobId'] or asset.get('sha256') != entry['sha256']
                    or asset.get('receiptSha256') != entry['receiptSha256']
                    or asset.get('selectionMode') != entry.get('selectionMode')):
                raise ValueError('protected_cached_asset_binding_changed')
        elif asset.get('cacheSourceJobId') is not None or asset.get('selectionMode') is not None:
            raise ValueError('protected_cached_asset_binding_changed')
        proof_path = checked_native_file(p.with_suffix('.receipt.json'), job, cached)
        raw_proof = proof_path.read_bytes()
        proof = json.loads(raw_proof)
        if (digest_bytes(raw_proof) != asset.get('receiptSha256')
                or proof.get('currentState') != 'GENERATED_PENDING_REVIEW'
                or proof.get('output') != str(p) or proof.get('outputBytes') != p.stat().st_size
                or proof.get('outputSha256') != asset['sha256']
                or proof.get('postProcessing') is not False
                or proof.get('repository') != receipt.get('repository')
                or proof.get('revision') != receipt.get('revision')
                or proof.get('precision') != 'BF16' or proof.get('offline') is not True
                or set(proof.get('componentDtypes', {}).values()) != {'torch.bfloat16'}
                or any(proof.get(key) != receipt.get(key) for key in ('steps', 'guidance', 'seed'))):
            raise ValueError('protected_native_asset_receipt_invalid')
        input_paths = [p.parent / 'prompt.txt', p.parent / 'reference.png']
        for member in input_paths:checked_native_file(member, job, cached)
        if proof.get('inputs') != [{'path': str(f), 'sha256': digest_bytes(f.read_bytes())} for f in input_paths]:
            raise ValueError('protected_native_asset_inputs_changed')
        if proof.get('promptSha256') != digest_bytes(input_paths[0].read_bytes()):
            raise ValueError('protected_native_asset_inputs_changed')
        with Image.open(p) as native:
            if (native.format != 'PNG' or native.size != (proof.get('width'), proof.get('height'))
                    or not all(type(v) is int and 512 <= v <= 2048 and v % 16 == 0 for v in native.size)):
                raise ValueError('protected_native_asset_dimensions_invalid')
            native.load();decoded[str(p)] = native.convert('RGB')
    # Rebuild from the source and the verified model assets, not the receipt's
    # self-reported OCR/protection booleans. This also binds the final pixels to
    # the particular glyph asset and exact requested placement.
    rebuilt = source.copy()
    erasures = [a for a in assets if a.get('role') == 'erasure']
    lettering = [a for a in assets if a.get('role') == 'lettering']
    if (len(erasures) != len(canonical['eraseRegions']) or len(erasures) + len(lettering) != len(assets)
            or len(lettering) > 2 * len(canonical['textLayers']) or bool(lettering) != bool(canonical['textLayers'])):
        raise ValueError('protected_native_asset_roles_invalid')
    for index, (asset, region) in enumerate(zip(erasures, canonical['eraseRegions'])):
        if asset.get('region') != region:raise ValueError('protected_erase_asset_region_changed')
        if asset['path'] in cached and cached[asset['path']]['stage'] != 'erase_' + str(index + 1):
            raise ValueError('protected_cached_asset_stage_changed')
        if strict_live:
            crop, context = erase_context(source, region)
            local = {'x': region['x'] - context['x'], 'y': region['y'] - context['y'],
                     'width': region['width'], 'height': region['height']}
            if asset.get('selectionMode') == 'erasure-material':
                if cached[asset['path']].get('referenceRegion') != local:
                    raise ValueError('protected_cached_erasure_region_changed')
                _verify_asset_reference(asset, crop, None, reference_region=local)
            else:
                _verify_asset_reference(asset, crop, erasure_prompt(local))
            paste_erasure(rebuilt, decoded[asset['path']], region, context)
    if lettering:
        selected = receipt.get('selectedLetteringAssets')
        if not isinstance(selected, list) or len(selected) != len(canonical['textLayers']):
            raise ValueError('protected_selected_text_asset_invalid')
        bindings = text.get('layers')
        if not isinstance(bindings, list) or len(bindings) != len(canonical['textLayers']):
            raise ValueError('protected_final_ocr_binding_missing')
        placements = []
        for i, (layer, binding) in enumerate(zip(canonical['textLayers'], bindings)):
            attempts = [a for a in lettering if a.get('layerIndex') == i]
            if not 1 <= len(attempts) <= 2 or [a.get('attempt') for a in attempts] != list(range(1, len(attempts) + 1)):
                raise ValueError('protected_text_asset_attempts_invalid')
            chosen = attempts[-1]
            if selected[i] != {'layerIndex': i, 'path': chosen['path'], 'sha256': chosen['sha256']}:
                raise ValueError('protected_selected_text_asset_invalid')
            for item in attempts:
                if item['path'] in cached and cached[item['path']]['stage'] != 'text_layer_' + str(i) + '_attempt_' + str(item['attempt']):
                    raise ValueError('protected_cached_asset_stage_changed')
            if strict_live:
                native = decoded[chosen['path']]
                _verify_asset_reference(chosen, Image.new('RGB', native.size, (255, 0, 255)),
                    None if chosen.get('selectionMode') == 'complete-line' else font_prompt(layer, chosen.get('attempt', 1) > 1))
                matte = keyed_letters(native)
                row, selection = lettering_row(matte, binding.get('nativeObserved', {}), layer)
                if selection != binding.get('assetSelection'):
                    raise ValueError('protected_native_line_selection_changed')
                native_preview = white_preview(matte)
                asset_preview = white_preview(row)
                placements.extend(paste_letters(rebuilt, [row], [layer]))
            expected_stage = job / 'stages' / ('text_layer_' + str(i) + '_attempt_' + str(chosen['attempt']))
            for prefix in ('native', 'asset'):
                if strict_live or prefix + 'PreviewPath' in binding:
                    expected = (native_preview if prefix == 'native' else asset_preview) if strict_live else None
                    verify_lettering_preview(binding, prefix, expected_stage, job, expected)
            validate_ocr([layer], binding.get('assetObserved', {}))
            crop = text_roi(final_image, layer)
            if binding.get('layerIndex') != i or binding.get('pixelSha256') != digest_bytes(crop.tobytes()):
                raise ValueError('protected_final_ocr_pixels_changed')
            preview = checked_stage_file(Path(binding.get('previewPath', '')), job)
            expected_preview_parent = job / 'stages' / ('text_layer_' + str(i) + '_attempt_' + str(chosen['attempt']))
            if preview.parent != expected_preview_parent or digest_bytes(preview.read_bytes()) != binding.get('previewSha256'):
                raise ValueError('protected_final_ocr_preview_changed')
            with Image.open(preview) as view:
                if view.mode != 'RGB' or view.size != crop.size or view.tobytes() != crop.tobytes():
                    raise ValueError('protected_final_ocr_preview_changed')
            validate_ocr([layer], binding.get('observed', {}))
        if strict_live:
            if placements != receipt.get('textPlacements'):
                raise ValueError('protected_text_placement_changed')
            if has_layout and text_layout_summary(size, canonical['textLayers'], placements) != receipt.get('textLayout'):
                raise ValueError('protected_text_layout_changed')
        if any(type(a.get('layerIndex')) is not int or not 0 <= a['layerIndex'] < len(canonical['textLayers']) for a in lettering):
            raise ValueError('protected_text_asset_layer_invalid')
    if strict_live and rebuilt.tobytes() != final_image.tobytes():
        raise ValueError('protected_final_not_composed_from_assets')
    # A sealed result remains readable after prompt/matting improvements. The
    # actual composed regions are frozen at first acceptance, so historical
    # readback verifies bytes and placement without re-running today's renderer.
    frozen = receipt.get('compositionRegions')
    expected = ([('erasure', i, box) for i, box in enumerate(canonical['eraseRegions'])]
                + [('text', i, layer['box']) for i, layer in enumerate(canonical['textLayers'])])
    if not isinstance(frozen, list) or len(frozen) != len(expected):
        raise ValueError('protected_composition_regions_missing')
    historical = source.copy()
    for number, (item, (role, index, box)) in enumerate(zip(frozen, expected)):
        if not isinstance(item, dict) or (item.get('role'), item.get('index'), item.get('box')) != (role, index, box):
            raise ValueError('protected_composition_region_binding_changed')
        path = checked_stage_file(Path(item.get('path', '')), job)
        if path != job / 'stages' / 'composition_regions' / ('region-' + str(number) + '.png'):
            raise ValueError('protected_composition_region_path_invalid')
        if digest_bytes(path.read_bytes()) != item.get('sha256'):
            raise ValueError('protected_composition_region_changed')
        with Image.open(path) as part:
            part.load()
            if (part.format != 'PNG' or part.mode != 'RGB' or part.size != (box['width'], box['height'])
                    or digest_bytes(part.tobytes()) != item.get('pixelSha256')):
                raise ValueError('protected_composition_region_changed')
            historical.paste(part, (box['x'], box['y']))
    if historical.tobytes() != final_image.tobytes():
        raise ValueError('protected_frozen_composition_changed')


def checked_stage_file(path, job):
    path, job = Path(path), Path(job)
    if (not path.is_absolute() or '..' in path.parts or not path.is_relative_to(job / 'stages')):
        raise ValueError('protected_stage_path_invalid')
    for member in [path, *path.parents]:
        if member.is_symlink():raise ValueError('protected_stage_path_invalid')
        if member == job:break
    if not path.is_file() or not path.resolve(strict=True).is_relative_to((job / 'stages').resolve(strict=True)):
        raise ValueError('protected_stage_path_invalid')
    return path


def checked_native_file(path, job, cached):
    """Allow only application-authorized original native members across jobs."""
    path, job = Path(path), Path(job)
    entry = cached.get(str(path.parent / 'model.png'))
    if entry is None:
        return checked_stage_file(path, job)
    if path.name not in ('model.png', 'model.receipt.json', 'prompt.txt', 'reference.png'):
        raise ValueError('protected_cached_member_invalid')
    root = job.parent
    for member in [path, *path.parents]:
        if member.is_symlink():raise ValueError('protected_stage_path_invalid')
        if member == root:break
    if not path.is_file() or not path.resolve(strict=True).is_relative_to(root.resolve(strict=True)):
        raise ValueError('protected_stage_path_invalid')
    return path


def _verify_asset_reference(asset, expected_image, expected_prompt, *, reference_region=None):
    parent = Path(asset['path']).parent
    if expected_prompt is not None and (parent / 'prompt.txt').read_text() != expected_prompt:
        raise ValueError('protected_asset_prompt_changed')
    with Image.open(parent / 'reference.png') as reference:
        if reference_region is not None:
            from .stage_cache import erasure_reference_matches
            equal = erasure_reference_matches(reference, expected_image, reference_region)
        else:
            equal = reference.convert('RGB').tobytes() == expected_image.convert('RGB').tobytes() and reference.size == expected_image.size
        if not equal:
            raise ValueError('protected_asset_reference_changed')


def white_preview(rgba):
    preview = Image.new('RGB', rgba.size, 'white')
    preview.paste(rgba, (0, 0), rgba.getchannel('A'))
    return preview


def lettering_row(matte, observed, layer):
    """Retain all ink or select an audited complete line; never repair glyphs."""
    if not isinstance(observed, dict) or not isinstance(observed.get('lines'), list):
        raise ValueError('protected_ocr_response_invalid')
    try:
        validate_ocr([layer], observed)
    except ValueError:
        if any(not isinstance(line, dict) or 'box' not in line or 'confidence' not in line
               for line in observed.get('lines', [])):
            raise ValueError('protected_generated_text_mismatch')
        from .font_selection import select_lettering_line
        return select_lettering_line(matte, observed, layer['text'])
    return split_letter_rows(matte, 1)[0], None


def verify_lettering_preview(binding, prefix, stage, job, expected=None):
    path = checked_stage_file(Path(binding.get(prefix + 'PreviewPath', '')), job)
    if path.parent != stage or digest_bytes(path.read_bytes()) != binding.get(prefix + 'PreviewSha256'):
        raise ValueError('protected_lettering_preview_changed')
    with Image.open(path) as view:
        view.load()
        if (view.format != 'PNG' or view.mode != 'RGB' or max(view.size) > 2048
                or digest_bytes(view.tobytes()) != binding.get(prefix + 'PreviewPixelSha256')
                or expected is not None and (view.size != expected.size or view.tobytes() != expected.tobytes())):
            raise ValueError('protected_lettering_preview_changed')


def text_roi(image, layer):
    r = layer['box']
    return image.crop((r['x'], r['y'], r['x'] + r['width'], r['y'] + r['height'])).convert('RGB')


def erasure_prompt(local):
    if set(local) != RECT_KEYS or any(type(local[key]) is not int for key in RECT_KEYS):
        raise ValueError('protected_erase_prompt_region_invalid')
    # The compositor owns exact coordinates. Asking the model to paint a JSON
    # rectangle can leave a flat replacement panel instead of real texture.
    return ('清除参考画面中后期叠加的文字、赞助商标、节目角标，以及它们的底板、边框和实心色块。'
            '把被遮挡的区域自然补回周围连续的真实背景纹理，不能残留长方形色块或广告底板。'
            '不要用纯色、模糊块、贴纸或矩形遮盖。保留原有草地、木条、绳索、人物和动物的真实结构与位置。'
            '不新增文字、标志、图案或物体，不全图调色，不磨皮。')


def font_prompt(layer, retry=False):
    """Compile one text asset, never a typography comparison/sample sheet."""
    if not isinstance(layer, dict) or not isinstance(layer.get('text'), str) or not layer['text']:
        raise ValueError('protected_font_layer_invalid')
    text = layer['text']
    style = layer.get('style', 'Readable documentary display lettering with subtle material and crisp edges.')
    role = layer.get('role')
    role_instruction = {
        'title': '这是封面主标题。字面要厚实、饱满、占据可用宽度的大部分，轮廓和材质清楚。',
        'subtitle': '这是副标题。保持清晰、克制，并与主标题形成明显字号层级。',
        'kicker': '这是导语短句。保持小而清晰，不抢主标题。',
        'caption': '这是说明文字。保持清晰可读，不模仿主标题。',
    }.get(role, '')
    if retry:
        style += ' 优先保证笔画准确清楚，可以简化装饰，但保留指定文字颜色。'
    # Styling prose is not a second copy of the target inscription.
    style = style.replace(text, '').strip()
    return ('标题文字内容：' + text + '\n'
            + '在纯品红色背景上设计这行艺术字，文字完整只写一次，水平单行，四周留足背景。\n'
            + (role_instruction + '\n' if role_instruction else '')
            + '字体样式：' + style + '\n'
            + '字形准确，边缘清晰，不要引号、标签、其他文字或多排对照，不要照片或场景。'
            + '文字、描边和阴影不用品红色。')


def keyed_letters(image):
    """Extract native model glyph pixels; no font substitution or drawing."""
    rgb = np.asarray(image.convert('RGB')).astype(np.float32)
    edge = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]), axis=0)
    key = np.median(edge, axis=0)
    if np.quantile(np.max(np.abs(edge - key), axis=1), .85) > 24:
        raise ValueError('protected_text_background_not_uniform')
    # A white backdrop would silently erase ivory/white glyph fills. Accept a
    # uniformly pink-magenta key even when its blue channel is softened by the
    # model, while rejecting red/orange or low-chroma backdrops that can blend
    # into bronze and ivory lettering.
    if (max(key[0], key[2]) < 180 or min(key[0], key[2]) < 96
            or key[1] > min(key[0], key[2]) - 60):
        raise ValueError('protected_text_background_key_mismatch')
    distance = np.max(np.abs(rgb - key), axis=2)
    chroma = rgb / np.maximum(rgb.max(axis=2, keepdims=True), 1)
    key_chroma = key / max(key)
    chroma_distance = np.max(np.abs(chroma - key_chroma), axis=2)
    # Real model key canvases have slight magenta shading/noise. Treat that
    # connected-looking chromatic family as backdrop rather than glyph ink.
    background = (chroma_distance < .25) & (rgb.max(axis=2) >= 120) & (distance < 96)
    alpha = np.clip(distance / max(float(max(key)), 255 - float(min(key))), 0, 1)
    alpha[background] = 0
    strong_ink = (chroma_distance > .7) & (distance > 100)
    alpha[strong_ink] = 1
    occupied = alpha > .15
    fraction = float(occupied.mean())
    if not .003 <= fraction <= .55:
        raise ValueError('protected_text_matte_invalid')
    if (alpha[:2] > .7).any() or (alpha[-2:] > .7).any() or (alpha[:, :2] > .7).any() or (alpha[:, -2:] > .7).any():
        raise ValueError('protected_text_asset_clipped')
    # Unmix only a balanced magenta key. With a warm pink key, subtracting the
    # softer blue channel reverses the hue of semi-transparent bronze edges;
    # retaining the model's native RGB is visually safer and keeps the text
    # material truthful.
    if min(key[0], key[2]) >= 150:
        a = np.maximum(alpha[:, :, None], .001)
        foreground = np.clip((rgb - (1 - a) * key) / a, 0, 255).astype('uint8')
    else:
        foreground = rgb.astype('uint8')
    rgba = np.dstack((foreground, np.round(alpha * 255).astype('uint8')))
    return Image.fromarray(rgba, 'RGBA')


def split_letter_rows(rgba, expected_count):
    a = np.asarray(rgba.getchannel('A'))
    active = (a > 0).any(axis=1)
    # Close within-glyph horizontal gaps, without joining separate text rows.
    radius = max(3, rgba.height // (expected_count * 8))
    for i in range(1, len(active)):
        if active[i] and not active[i - 1]:
            start = i - 1
            while start >= 0 and not active[start] and i - start <= radius:
                start -= 1
            if start >= 0 and active[start]:active[start:i] = True
    ranges = []
    start = None
    for i, value in enumerate([*active.tolist(), False]):
        if value and start is None:start = i
        elif not value and start is not None:
            ranges.append((start, i))
            start = None
    if len(ranges) != expected_count:
        raise ValueError('protected_text_row_count_invalid')
    result = []
    for y0, y1 in ranges:
        part = rgba.crop((0, y0, rgba.width, y1))
        bbox = part.getchannel('A').getbbox()
        if not bbox:raise ValueError('protected_text_row_empty')
        result.append(part.crop(bbox))
    if sum(np.count_nonzero(np.asarray(row.getchannel('A'))) for row in result) != np.count_nonzero(a):
        raise ValueError('protected_text_pixels_lost_during_split')
    return result


def normalized_text(value):
    value = unicodedata.normalize('NFKC', value).replace('•', '·').replace('・', '·')
    # Ignore layout whitespace, not missing punctuation or unexpected quotes.
    # In particular, never repair a wrong Chinese character or V1 into VI.
    return ''.join(c for c in value if not c.isspace())


def validate_ocr(expected, observed):
    lines = observed.get('lines')
    if not isinstance(lines, list):raise ValueError('protected_ocr_response_invalid')
    # Vision may split one artistic line into several blocks. Reading order is
    # established by the engine; compare the full normalized text sequence.
    actual = ''.join(normalized_text(line.get('text', '')) for line in lines)
    wanted = ''.join(normalized_text(line['text']) for line in expected)
    if not wanted or actual != wanted:
        raise ValueError('protected_generated_text_mismatch')


def paste_letters(base, rows, layers):
    if len(rows) != len(layers):raise ValueError('protected_text_row_count_invalid')
    placements = []
    for row, layer in zip(rows, layers):
        box = layer['box']
        scale = min(box['width'] / row.width, box['height'] / row.height)
        if scale > 1:
            raise ValueError('protected_text_native_resolution_too_low')
        size = (max(1, round(row.width * scale)), max(1, round(row.height * scale)))
        fitted = row.resize(size, Image.Resampling.LANCZOS) if size != row.size else row
        x = box['x'] + ((box['width'] - size[0]) // 2 if layer['align'] == 'center' else 0)
        y = box['y'] + (box['height'] - size[1]) // 2
        base.paste(fitted.convert('RGB'), (x, y), fitted.getchannel('A'))
        placements.append({'text': layer['text'], 'placedBox': {'x': x, 'y': y,
                           'width': size[0], 'height': size[1]}, 'nativeSize': list(row.size),
                           'scale': scale})
    return placements


def erase_context(image, region):
    def aligned(n):return (n + 15) // 16 * 16
    w = min(2048, aligned(max(512, region['width'] + 160)))
    h = min(2048, aligned(max(512, region['height'] + 160)))
    x = max(0, min(region['x'] + region['width'] // 2 - w // 2, max(0, image.width - w)))
    y = max(0, min(region['y'] + region['height'] // 2 - h // 2, max(0, image.height - h)))
    return image.crop((x, y, x + w, y + h)), {'x': x, 'y': y, 'width': w, 'height': h}


def paste_erasure(base, patch, region, context):
    if patch.size != (context['width'], context['height']):
        raise ValueError('protected_erase_patch_dimensions_invalid')
    x0, y0 = region['x'] - context['x'], region['y'] - context['y']
    replacement = patch.crop((x0, y0, x0 + region['width'], y0 + region['height'])).convert('RGB')
    h, w = region['height'], region['width']
    yy, xx = np.mgrid[:h, :w]
    edge = np.minimum.reduce((xx + 1, w - xx, yy + 1, h - yy))
    # Feather only INSIDE the explicitly allowed rectangle.
    alpha = np.minimum(1.0, edge / min(8, max(1, min(w, h) // 6)))
    base.paste(replacement, (region['x'], region['y']), Image.fromarray((alpha * 255).astype('uint8')))
