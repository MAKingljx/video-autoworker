"""One application job: model patches and glyph assets, then protected compose."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from PIL import Image

from .protected_cover import (RESULT_SCHEMA, digest_bytes, erase_context, font_prompt,
    implementation_digest, keyed_letters, normalize_protected, paste_erasure, erasure_prompt,
    paste_letters, protection_summary, source_image, split_letter_rows,
    validate_ocr, verify_protected_result, text_roi)
from .ocr import recognize
from .stage_cache import HEX, read_cached_asset, validate_stage_cache


def atomic_json(path, value):
    temp = path.with_name(path.name + '.incoming-' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n');f.flush();os.fsync(f.fileno())
    os.replace(temp, path)


def save_png(path, image):
    with path.open('xb') as f:image.save(f, 'PNG')
    path.chmod(0o600)


class NativeRunner:
    def __init__(self, backend_script, steps, guidance, seed, *, stage_cache=None, job_folder=None):
        self.script = Path(backend_script).resolve(strict=True)
        self.steps, self.guidance, self.seed = steps, guidance, seed
        self.sha = digest_bytes(self.script.read_bytes())
        definition = importlib.util.spec_from_file_location('protected_qwen_backend', self.script)
        module = importlib.util.module_from_spec(definition);definition.loader.exec_module(module)
        self.repository, self.revision = module.REPOSITORY, module.REVISION
        self.job_folder=Path(job_folder)if job_folder is not None else None
        if stage_cache is not None and self.job_folder is None:
            raise ValueError('protected_stage_cache_job_invalid')
        self.stage_cache=validate_stage_cache(stage_cache,self.job_folder)if stage_cache is not None else None

    def cached(self,folder,reference,prompt,width,height):
        if self.stage_cache is None:return None
        if folder.parent.parent!=self.job_folder:
            raise ValueError('protected_stage_cache_job_invalid')
        entry=next((e for e in self.stage_cache['assets']if e['stage']==folder.name),None)
        if entry is None:return None
        native,receipt=read_cached_asset(entry,self.job_folder)
        if (receipt.get('repository')!=self.repository or receipt.get('revision')!=self.revision
                or receipt.get('precision')!='BF16'or receipt.get('offline')is not True
                or not isinstance(receipt.get('componentDtypes'),dict)
                or set(receipt.get('componentDtypes',{}).values())!={'torch.bfloat16'}
                or receipt.get('width')!=width or receipt.get('height')!=height
                or receipt.get('steps')!=self.steps or receipt.get('guidance')!=self.guidance
                or receipt.get('seed')!=self.seed):
            return None
        path=Path(receipt['output']);parent=path.parent
        if (parent/'prompt.txt').read_text()!=prompt:return None
        with Image.open(parent/'reference.png')as old:
            if old.size!=reference.size or old.convert('RGB').tobytes()!=reference.convert('RGB').tobytes():
                return None
        return native,{'path':str(path),'sha256':receipt['outputSha256'],
            'receiptSha256':entry['receiptSha256'],'repository':self.repository,
            'revision':self.revision,'precision':'BF16','offline':True,
            'cacheSourceJobId':entry['sourceJobId']}

    def __call__(self, folder, reference, prompt, width, height, progress):
        output = folder / 'model.png';receipt_file = output.with_suffix('.receipt.json')
        ref = folder / 'reference.png';prompt_file = folder / 'prompt.txt'
        if any(p.is_symlink()for p in (output,receipt_file,ref,prompt_file)):
            raise ValueError('protected_stage_path_invalid')
        if digest_bytes(self.script.read_bytes())!=self.sha:
            raise ValueError('protected_backend_changed')
        if not ref.exists():save_png(ref, reference)
        else:
            with Image.open(ref) as old:
                if old.convert('RGB').tobytes() != reference.convert('RGB').tobytes() or old.size != reference.size:
                    raise ValueError('protected_stage_reference_drift')
        if not prompt_file.exists():
            with prompt_file.open('x') as f:f.write(prompt)
            prompt_file.chmod(0o600)
        if prompt_file.read_text() != prompt:
            raise ValueError('protected_stage_prompt_drift')
        cached=self.cached(folder,reference,prompt,width,height)
        if cached is not None and not receipt_file.exists():
            if output.exists()or output.with_suffix('.intent.json').exists():
                raise ValueError('protected_cached_stage_incomplete')
            progress(self.steps,self.steps)
            return cached
        if not receipt_file.exists():
            if output.exists() or output.with_suffix('.intent.json').exists():
                raise ValueError('protected_cached_stage_incomplete')
            if digest_bytes(self.script.read_bytes()) != self.sha:
                raise ValueError('protected_backend_changed')
            command = [sys.executable, str(self.script), 'generate', '--wait-for-model',
                '--prompt-file', str(prompt_file), '--images', str(ref), '--output', str(output),
                '--width', str(width), '--height', str(height), '--steps', str(self.steps),
                '--guidance', str(self.guidance), '--seed', str(self.seed)]
            with (folder / 'generator.log').open('xb') as log:
                os.chmod(log.name, 0o600)
                # Inherit the service-owned process group so its one cancel
                # operation also stops the model child and later OCR utility.
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
                try:
                    while process.poll() is None:
                        current = {}
                        try:current = json.loads(output.with_suffix('.intent.json').read_text())
                        except (OSError, ValueError):pass
                        progress(current.get('completedSteps', 0), current.get('totalSteps', self.steps))
                        time.sleep(.5)
                except BaseException:
                    if process.poll() is None:
                        process.terminate()
                        try:process.wait(timeout=5)
                        except subprocess.TimeoutExpired:process.kill();process.wait()
                    raise
                if process.returncode != 0:
                    raise ValueError('protected_native_model_stage_failed')
        receipt = json.loads(receipt_file.read_text())
        if (receipt.get('repository') != self.repository or receipt.get('revision') != self.revision
                or receipt.get('currentState') != 'GENERATED_PENDING_REVIEW'
                or receipt.get('precision') != 'BF16' or receipt.get('offline') is not True
                or set(receipt.get('componentDtypes', {}).values()) != {'torch.bfloat16'}
                or receipt.get('postProcessing') is not False
                or receipt.get('width') != width or receipt.get('height') != height
                or receipt.get('steps') != self.steps or receipt.get('guidance') != self.guidance
                or receipt.get('seed') != self.seed or receipt.get('output') != str(output)
                or receipt.get('outputSha256') != digest_bytes(output.read_bytes())
                or receipt.get('promptSha256') != digest_bytes(prompt.encode())):
            raise ValueError('protected_native_asset_receipt_invalid')
        expected = [prompt_file, ref]
        if receipt.get('inputs') != [{'path': str(p), 'sha256': digest_bytes(p.read_bytes())} for p in expected]:
            raise ValueError('protected_native_asset_inputs_changed')
        with Image.open(output) as image:
            image.load()
            if image.format != 'PNG' or image.size != (width, height):
                raise ValueError('protected_native_asset_dimensions_invalid')
            result = image.convert('RGB')
        return result, {'path': str(output), 'sha256': receipt['outputSha256'],
                        'receiptSha256': digest_bytes(receipt_file.read_bytes()),
                        'repository': receipt['repository'], 'revision': receipt['revision'],
                        'precision': 'BF16', 'offline': True}


def build_protected(spec_file, source_path, output, runner, *, steps=30, guidance=4,
                    seed=301, ocr=recognize, stage_cache=None):
    started = time.monotonic();output = Path(output);source_path = Path(source_path);spec_file = Path(spec_file)
    if any(p.is_symlink() for p in (output, source_path, spec_file)):
        raise ValueError('protected_job_path_invalid')
    if output.exists() or output.with_suffix('.receipt.json').exists():
        raise ValueError('protected_output_already_exists')
    if source_path.parent != output.parent or spec_file.parent != output.parent:
        raise ValueError('protected_job_members_invalid')
    spec_raw, source_raw = spec_file.read_bytes(), source_path.read_bytes()
    cache_file=output.parent/'stage-cache.json';cache_raw=None
    if stage_cache is not None:
        if cache_file.is_symlink()or not cache_file.is_file()or cache_file.stat().st_size>64*1024:
            raise ValueError('protected_stage_cache_file_invalid')
        cache_raw=cache_file.read_bytes()
        stage_cache=validate_stage_cache(stage_cache,output.parent)
        if validate_stage_cache(json.loads(cache_raw),output.parent)!=stage_cache:
            raise ValueError('protected_stage_cache_file_changed')
    spec, _ = normalize_protected(json.loads(spec_raw), source_raw)
    original = source_image(source_raw);composed = original.copy()
    implementation = implementation_digest()
    intent = output.with_suffix('.intent.json');assets=[];completed=0
    stages = len(spec['eraseRegions']) + 2 * len(spec['textLayers'])
    def progress(stage, count=0, total=steps):
        atomic_json(intent, {'currentState':'RUNNING','pid':os.getpid(),'stage':stage,
            'completedSteps': completed + max(0, int(count)), 'totalSteps': max(steps, stages * steps),
            'elapsedSeconds':round(time.monotonic()-started,3)})
    def stage_folder(name):
        p=output.parent/'stages'/name
        if p.parent.is_symlink() or p.is_symlink():raise ValueError('protected_stage_path_invalid')
        p.mkdir(parents=True,exist_ok=True,mode=0o700)
        if not p.resolve(strict=True).is_relative_to(output.parent.resolve(strict=True)):
            raise ValueError('protected_stage_path_invalid')
        return p
    try:
        for index, region in enumerate(spec['eraseRegions']):
            stage='erase_'+str(index+1);progress(stage)
            crop, context=erase_context(original,region)
            local={'x':region['x']-context['x'],'y':region['y']-context['y'],
                   'width':region['width'],'height':region['height']}
            prompt=erasure_prompt(local)
            patch, record=runner(stage_folder(stage),crop,prompt,crop.width,crop.height,
                lambda count,total:progress(stage,count,total))
            paste_erasure(composed,patch,region,context)
            assets.append({'role':'erasure','region':region,**record});completed+=steps
        placements=[];selected_lettering=[]
        text_validation={'matched':True,'engine':'apple-vision' if spec['textLayers'] else 'not-applicable','mode':'normalized_text_sequence',
                         'expectedCount':len(spec['textLayers']),'observedCount':0}
        if spec['textLayers']:
            bindings=[];asset_attempts=0
            quality_errors={'protected_text_background_not_uniform',
                'protected_text_background_key_mismatch','protected_text_matte_invalid',
                'protected_text_asset_clipped','protected_text_row_count_invalid',
                'protected_text_row_empty','protected_text_pixels_lost_during_split',
                'protected_generated_text_mismatch','protected_text_native_resolution_too_low'}
            for index,layer in enumerate(spec['textLayers']):
                # Each exact string gets its own native asset. A later layer's
                # retry does not regenerate earlier accepted model stages.
                previous_error=None
                native_size=(1024 if len(layer['text'])<=4 else 1536),512
                for attempt in range(2):
                    stage='text_layer_'+str(index)+'_attempt_'+str(attempt+1);progress(stage)
                    # More pixels address insufficient native glyph size, not
                    # spelling, repeated lines or an unsuitable background.
                    width,height=((2048,768) if previous_error=='protected_text_native_resolution_too_low'
                                  else native_size)
                    canvas=Image.new('RGB',(width,height),(255,0,255))
                    raw,record=runner(stage_folder(stage),canvas,font_prompt(layer,attempt>0),
                        width,height,lambda count,total:progress(stage,count,total))
                    completed+=steps;asset_attempts+=1
                    assets.append({'role':'lettering','layerIndex':index,'attempt':attempt+1,**record})
                    try:
                        matte=keyed_letters(raw)
                        rows=split_letter_rows(matte,1)
                        # Check the actual model bitmap before fitting, then
                        # independently check the exact pixels in its final ROI.
                        preview=Image.new('RGB',matte.size,'white')
                        preview.paste(matte,(0,0),matte.getchannel('A'))
                        preview_path=stage_folder(stage)/'ocr-preview.png'
                        if preview_path.is_symlink():raise ValueError('protected_ocr_preview_drift')
                        if not preview_path.exists():save_png(preview_path,preview)
                        else:
                            with Image.open(preview_path)as cached:
                                if cached.mode!='RGB' or cached.size!=preview.size or cached.tobytes()!=preview.tobytes():
                                    raise ValueError('protected_ocr_preview_drift')
                        progress('ocr_layer_'+str(index));observed=ocr(preview_path)
                        validate_ocr([layer],observed)
                        trial=composed.copy();placed=paste_letters(trial,rows,[layer])
                        crop=text_roi(trial,layer)
                        path=stage_folder(stage)/('final-ocr-layer-'+str(index)+'.png')
                        if path.is_symlink():raise ValueError('protected_final_ocr_preview_drift')
                        if not path.exists():save_png(path,crop)
                        else:
                            with Image.open(path)as cached:
                                if cached.mode!='RGB' or cached.size!=crop.size or cached.tobytes()!=crop.tobytes():
                                    raise ValueError('protected_final_ocr_preview_drift')
                        actual=ocr(path);validate_ocr([layer],actual)
                        bindings.append({'layerIndex':index,'assetObserved':observed,
                            'previewPath':str(path),'previewSha256':digest_bytes(path.read_bytes()),
                            'pixelSha256':digest_bytes(crop.tobytes()),'observed':actual})
                        composed=trial;placements.extend(placed)
                        selected_lettering.append({'layerIndex':index,'path':record['path'],
                                                   'sha256':record['sha256']})
                        text_validation.update({'observedCount':len(bindings),
                            'assetAttempts':asset_attempts,'layers':bindings})
                        break
                    except ValueError as error:
                        atomic_json(stage_folder(stage)/'validation.json',{'matched':False,'errorCode':str(error)})
                        if attempt==1 or str(error) not in quality_errors:raise
                        previous_error=str(error)
        progress('verify')
        proof=protection_summary(original,composed,spec)
        if proof['outsideChangedPixels']!=0:raise ValueError('protected_photo_pixels_changed')
        if source_path.read_bytes()!=source_raw or spec_file.read_bytes()!=spec_raw:
            raise ValueError('protected_inputs_changed')
        if cache_raw is not None and (cache_file.is_symlink()or cache_file.read_bytes()!=cache_raw):
            raise ValueError('protected_stage_cache_file_changed')
        # Seal the actual accepted pixels, not a recipe tied to today's prompt
        # compiler or matting implementation. Historical readback can reproduce
        # this composition even after either implementation evolves.
        composition_regions=[]
        regions=([('erasure',i,box)for i,box in enumerate(spec['eraseRegions'])]
                 +[('text',i,layer['box'])for i,layer in enumerate(spec['textLayers'])])
        folder=stage_folder('composition_regions')
        for number,(role,index,box)in enumerate(regions):
            crop=text_roi(composed,{'box':box})
            path=folder/('region-'+str(number)+'.png')
            if path.is_symlink():raise ValueError('protected_composition_region_cache_invalid')
            if not path.exists():save_png(path,crop)
            else:
                if not path.is_file():raise ValueError('protected_composition_region_cache_invalid')
                with Image.open(path)as cached:
                    cached.load()
                    if (cached.format!='PNG' or cached.mode!='RGB' or cached.size!=crop.size
                            or cached.tobytes()!=crop.tobytes()):
                        raise ValueError('protected_composition_region_cache_changed')
            composition_regions.append({'role':role,'index':index,'box':box,'path':str(path),
                'sha256':digest_bytes(path.read_bytes()),'pixelSha256':digest_bytes(crop.tobytes())})
        if implementation_digest()!=implementation:raise ValueError('protected_implementation_changed')
        temp=output.with_name(output.stem+'.incoming-'+uuid.uuid4().hex+'.png')
        with temp.open('xb')as f:composed.save(f,'PNG',icc_profile=original.info.get('icc_profile',b''))
        temp.chmod(0o600)
        result={'schema':RESULT_SCHEMA,'currentState':'GENERATED_PENDING_REVIEW','errorCode':None,
            'nextAction':'inspect_composed_cover_and_text','repository':runner.repository,
            'revision':runner.revision,'precision':'BF16','offline':True,'postProcessing':True,
            'composition':'original_photo_plus_local_model_assets','sourceFileSha256':digest_bytes(source_raw),
            'inputs':[{'path':str(spec_file),'sha256':digest_bytes(spec_raw)},
                      {'path':str(source_path),'sha256':digest_bytes(source_raw)}],
            'assets':assets,'selectedLetteringAssets':selected_lettering,'compositionRegions':composition_regions,
            'textPlacements':placements,'textValidation':text_validation,
            'photoProtection':proof,'width':original.width,'height':original.height,
            'steps':steps,'guidance':guidance,'seed':seed,'protectedSourceSha256':implementation,
            'elapsedSeconds':round(time.monotonic()-started,3),'output':str(output),
            'outputBytes':temp.stat().st_size,'outputSha256':digest_bytes(temp.read_bytes())}
        if cache_raw is not None:result['stageCacheSha256']=digest_bytes(cache_raw)
        # Verify the actual encoded PNG independently before making it visible.
        verify_protected_result(source_path,temp,spec,result,
                                **({'stage_cache':stage_cache}if stage_cache is not None else{}))
        os.link(temp,output);temp.unlink()
        atomic_json(output.with_suffix('.receipt.json'),result)
        atomic_json(intent,{'currentState':'GENERATED_PENDING_REVIEW','pid':os.getpid(),
                           'stage':'complete','outputSha256':result['outputSha256']})
        return result
    except BaseException as error:
        atomic_json(intent,{'currentState':'FAILED','pid':os.getpid(),'errorCode':str(error),
                           'elapsedSeconds':round(time.monotonic()-started,3)})
        raise


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('spec-file','source','output','backend-script'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--steps',type=int,default=30)
    parser.add_argument('--guidance',type=float,default=4)
    parser.add_argument('--seed',type=int,default=301)
    parser.add_argument('--stage-cache-file')
    parser.add_argument('--stage-cache-sha256')
    args=parser.parse_args()
    if not 1<=args.steps<=60 or not 1<=args.guidance<=8 or not 0<=args.seed<2**31:
        raise ValueError('protected_generation_parameters_invalid')
    if bool(args.stage_cache_file)!=bool(args.stage_cache_sha256):
        raise ValueError('protected_stage_cache_arguments_invalid')
    cache=None
    if args.stage_cache_file:
        path=Path(args.stage_cache_file)
        if (path!=Path(args.output).parent/'stage-cache.json'or not path.is_absolute()
                or path.is_symlink()or not path.is_file()or path.stat().st_size>64*1024
                or not HEX.fullmatch(args.stage_cache_sha256)):
            raise ValueError('protected_stage_cache_file_invalid')
        raw=path.read_bytes()
        if digest_bytes(raw)!=args.stage_cache_sha256:raise ValueError('protected_stage_cache_file_changed')
        cache=validate_stage_cache(json.loads(raw),Path(args.output).parent)
    runner=NativeRunner(args.backend_script,args.steps,args.guidance,args.seed,
                        stage_cache=cache,job_folder=Path(args.output).parent)
    try:result=build_protected(Path(args.spec_file),Path(args.source),Path(args.output),runner,
                              steps=args.steps,guidance=args.guidance,seed=args.seed,stage_cache=cache)
    except (ValueError,OSError)as error:
        print(json.dumps({'currentState':'FAILED','errorCode':str(error)}),file=sys.stderr);return 1
    print(json.dumps(result,ensure_ascii=False));return 0


if __name__=='__main__':raise SystemExit(main())
