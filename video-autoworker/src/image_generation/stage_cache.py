"""Bounded, read-only reuse of pinned native stages from an application job.

The application authorizes source jobs by scope and payload identity. This
module accepts no caller-provided paths and never changes a source artifact.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from PIL import Image

SCHEMA='aiworker-protected-stage-cache/v1'
HEX=re.compile(r'[a-f0-9]{64}')
JOB=re.compile(r'[a-f0-9]{32}')
SOURCE_STAGE=re.compile(r'(?:erase_[1-4]|text_layer_[0-3]_attempt_[12])')
TARGET_STAGE=re.compile(r'(?:erase_[1-4]|text_layer_[0-3]_attempt_1)')
ENTRY_KEYS={'stage','sourceJobId','sourceStage','sourcePayloadSha256','sha256','receiptSha256'}
REGION_KEYS={'x','y','width','height'}


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _entry(value):
    if (not isinstance(value,dict) or not ENTRY_KEYS <= set(value) or set(value)-ENTRY_KEYS-{'selectionMode','referenceRegion'}
            or any(not isinstance(value[k],str)for k in ENTRY_KEYS)
            or not TARGET_STAGE.fullmatch(value['stage'])
            or not SOURCE_STAGE.fullmatch(value['sourceStage'])
            or not JOB.fullmatch(value['sourceJobId'])
            or any(not HEX.fullmatch(value[k])for k in ('sourcePayloadSha256','sha256','receiptSha256'))):
        raise ValueError('protected_stage_cache_entry_invalid')
    if value['stage'].startswith('erase_')!=value['sourceStage'].startswith('erase_'):
        raise ValueError('protected_stage_cache_entry_invalid')
    mode=value.get('selectionMode')
    if 'selectionMode'in value and mode not in ('complete-line','erasure-material'):
        raise ValueError('protected_stage_cache_entry_invalid')
    if mode=='complete-line'and (not value['stage'].startswith('text_layer_')
            or value['stage'].split('_')[2]!=value['sourceStage'].split('_')[2]):
        raise ValueError('protected_stage_cache_entry_invalid')
    if mode=='erasure-material':
        if not value['stage'].startswith('erase_')or'referenceRegion'not in value:
            raise ValueError('protected_stage_cache_entry_invalid')
        return {**value,'referenceRegion':_reference_region(value['referenceRegion'])}
    if 'referenceRegion'in value:raise ValueError('protected_stage_cache_entry_invalid')
    return dict(value)


def _reference_region(value,size=None):
    if (not isinstance(value,dict)or set(value)!=REGION_KEYS
            or any(type(value[k])is not int for k in REGION_KEYS)
            or min(value['x'],value['y'])<0 or min(value['width'],value['height'])<1
            or size is not None and (value['x']+value['width']>size[0]or value['y']+value['height']>size[1])):
        raise ValueError('protected_stage_cache_reference_region_invalid')
    return dict(value)


def erasure_reference_matches(old_reference,current_reference,reference_region):
    """Compare the complete photographic context outside an explicit ROI.

    Region values are source-reference pixel coordinates, never caller paths.
    Prompt changes and pixels inside that same erasure ROI do not affect this
    equivalence; the application separately binds original-photo lineage.
    """
    region=_reference_region(reference_region,old_reference.size)
    if old_reference.size!=current_reference.size:return False
    old,current=old_reference.convert('RGB'),current_reference.convert('RGB')
    x,y,w,h=(region[k]for k in ('x','y','width','height'))
    width,height=old.size
    strips=((0,0,width,y),(0,y+h,width,height),(0,y,x,y+h),(x+w,y,width,y+h))
    return all(old.crop(box).tobytes()==current.crop(box).tobytes()for box in strips)


def _paths(entry,job_folder):
    job=Path(job_folder)
    if (not job.is_absolute() or '..'in job.parts or not JOB.fullmatch(job.name)
            or entry['sourceJobId']==job.name):
        raise ValueError('protected_stage_cache_job_invalid')
    root=job.parent
    source=root/entry['sourceJobId']
    stage=source/'stages'/entry['sourceStage']
    folders=(root,job,source,source/'stages',stage)
    # Check every application-owned ancestor rather than accepting a resolved
    # symlink that happens to land somewhere under the same output directory.
    if any(p.is_symlink()or not p.is_dir()or p.stat().st_uid!=os.getuid()for p in folders):
        raise ValueError('protected_stage_cache_path_invalid')
    if not stage.resolve(strict=True).is_relative_to(root.resolve(strict=True)):
        raise ValueError('protected_stage_cache_path_invalid')
    paths=[stage/name for name in ('model.png','model.receipt.json','prompt.txt','reference.png')]
    for path in paths:
        if (path.is_symlink()or not path.is_file()or not stat.S_ISREG(path.stat().st_mode)
                or path.stat().st_uid!=os.getuid()):
            raise ValueError('protected_stage_cache_path_invalid')
    return paths


def validate_stage_cache(manifest,job_folder):
    if (not isinstance(manifest,dict)or set(manifest)!={'schema','assets'}
            or manifest.get('schema')!=SCHEMA or not isinstance(manifest.get('assets'),list)
            or len(manifest['assets'])>8):
        raise ValueError('protected_stage_cache_invalid')
    entries=[_entry(value)for value in manifest['assets']]
    if len({entry['stage']for entry in entries})!=len(entries):
        raise ValueError('protected_stage_cache_duplicate_stage')
    if len({(entry['sourceJobId'],entry['sourceStage'])for entry in entries})!=len(entries):
        raise ValueError('protected_stage_cache_duplicate_source')
    for entry in entries:_paths(entry,job_folder)
    return {'schema':SCHEMA,'assets':entries}


def cached_asset_paths(manifest,job_folder):
    checked=validate_stage_cache(manifest,job_folder)
    return {str(_paths(entry,job_folder)[0]):entry for entry in checked['assets']}


def read_cached_asset(entry,job_folder):
    """Validate immutable bytes and native input provenance before reuse.

    Runtime/prompt/reference equivalence to a new request is intentionally left
    to NativeRunner; a different valid fingerprint is a cache miss, not damage.
    """
    entry=_entry(entry)
    output,receipt_file,prompt_file,reference_file=_paths(entry,job_folder)
    if (output.stat().st_size>40*1024*1024 or receipt_file.stat().st_size>1024*1024
            or prompt_file.stat().st_size>16*1024 or reference_file.stat().st_size>40*1024*1024):
        raise ValueError('protected_stage_cache_asset_invalid')
    raw,proof_raw=output.read_bytes(),receipt_file.read_bytes()
    if _sha(raw)!=entry['sha256']or _sha(proof_raw)!=entry['receiptSha256']:
        raise ValueError('protected_stage_cache_asset_changed')
    try:proof=json.loads(proof_raw)
    except (UnicodeError,ValueError)as error:
        raise ValueError('protected_stage_cache_receipt_invalid')from error
    if (not isinstance(proof,dict)or proof.get('output')!=str(output)
            or proof.get('currentState')!='GENERATED_PENDING_REVIEW'
            or proof.get('postProcessing')is not False
            or proof.get('outputSha256')!=entry['sha256']or proof.get('outputBytes')!=len(raw)):
        raise ValueError('protected_stage_cache_receipt_invalid')
    expected=[{'path':str(p),'sha256':_sha(p.read_bytes())}for p in (prompt_file,reference_file)]
    if proof.get('inputs')!=expected or proof.get('promptSha256')!=expected[0]['sha256']:
        raise ValueError('protected_stage_cache_inputs_changed')
    try:
        with Image.open(output)as native:
            if (native.format!='PNG'or native.size!=(proof.get('width'),proof.get('height'))
                    or not all(type(v)is int and 512<=v<=2048 and v%16==0 for v in native.size)):
                raise ValueError('protected_stage_cache_image_invalid')
            native.load();image=native.convert('RGB')
        with Image.open(reference_file)as reference:
            if reference.format!='PNG':raise ValueError('protected_stage_cache_reference_invalid')
            reference.load()
            if entry.get('selectionMode')=='erasure-material':
                _reference_region(entry['referenceRegion'],image.size)
                _reference_region(entry['referenceRegion'],reference.size)
    except (OSError,SyntaxError,Image.DecompressionBombError)as error:
        raise ValueError('protected_stage_cache_image_invalid')from error
    return image,proof
