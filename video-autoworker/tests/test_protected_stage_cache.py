"""Pinned native-stage reuse; fixtures never call a model or production API."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image,ImageDraw

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
import test_protected_cover as fixtures
from image_generation.protected_cover import verify_protected_result
from image_generation.protected_worker import NativeRunner,build_protected
from image_generation.stage_cache import (SCHEMA,cached_asset_paths,
    read_cached_asset,validate_stage_cache,erasure_reference_matches)

FAKE='''import argparse,hashlib,json
from pathlib import Path
from PIL import Image
REPOSITORY='fixture'
REVISION='fixture'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('action');p.add_argument('--wait-for-model',action='store_true')
 p.add_argument('--prompt-file');p.add_argument('--images');p.add_argument('--output')
 for name in ('width','height','steps','seed'):p.add_argument('--'+name,type=int)
 p.add_argument('--guidance',type=float);a=p.parse_args()
 out=Path(a.output);Image.new('RGB',(a.width,a.height),'navy').save(out)
 sha=lambda data:hashlib.sha256(data).hexdigest()
 inputs=[Path(a.prompt_file),Path(a.images)]
 proof={'currentState':'GENERATED_PENDING_REVIEW','repository':REPOSITORY,'revision':REVISION,
 'output':str(out),'outputBytes':out.stat().st_size,'outputSha256':sha(out.read_bytes()),
 'postProcessing':False,'precision':'BF16','offline':True,
 'componentDtypes':{'transformer':'torch.bfloat16'},'width':a.width,'height':a.height,
 'steps':a.steps,'guidance':a.guidance,'seed':a.seed,'promptSha256':sha(inputs[0].read_bytes()),
 'inputs':[{'path':str(f),'sha256':sha(f.read_bytes())}for f in inputs]}
 out.with_suffix('.receipt.json').write_text(json.dumps(proof))
'''


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


class ProtectedStageCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        self.old=self.root/('a'*32);self.old.mkdir()
        self.job=self.root/('b'*32);self.job.mkdir()
        self.backend=self.root/'fixture_backend.py';self.backend.write_text(FAKE)

    def tearDown(self):self.temp.cleanup()

    def source_stage(self,stage='erase_1',prompt='erase requested'):
        folder=self.old/'stages'/stage;folder.mkdir(parents=True)
        reference=Image.new('RGB',(512,512),'green')
        fixtures.FixtureRunner()(folder,reference,prompt,512,512,lambda *_:None)
        return reference,self.entry(stage)

    def entry(self,stage='erase_1',target=None):
        path=self.old/'stages'/stage/'model.png'
        return {'stage':target or stage,'sourceJobId':self.old.name,'sourceStage':stage,
                'sourcePayloadSha256':'c'*64,'sha256':sha(path),
                'receiptSha256':sha(path.with_suffix('.receipt.json'))}

    def manifest(self,entry):return {'schema':SCHEMA,'assets':[entry]}

    def runner(self,entry,**kwargs):
        return NativeRunner(self.backend,kwargs.get('steps',30),kwargs.get('guidance',4),kwargs.get('seed',301),
                            stage_cache=self.manifest(entry),job_folder=self.job)

    def target(self,stage='erase_1'):
        folder=self.job/'stages'/stage;folder.mkdir(parents=True,exist_ok=True);return folder

    def test_structural_bounds_unique_targets_and_unique_source_paths(self):
        _,entry=self.source_stage()
        manifest=self.manifest(entry)
        checked=validate_stage_cache(manifest,self.job)
        self.assertEqual(checked,manifest)
        path=str(self.old/'stages'/'erase_1'/'model.png')
        self.assertEqual(cached_asset_paths(manifest,self.job),{path:entry})
        bad=[{'schema':SCHEMA,'assets':[entry]*9},
             {**manifest,'path':'/untrusted'},
             self.manifest({**entry,'stage':'text_layer_0_attempt_2'}),
             self.manifest({**entry,'sourceJobId':'../outside'}),
             self.manifest({**entry,'sourceStage':'erase_1/../../secret'}),
             self.manifest({**entry,'sourcePayloadSha256':'x'*64}),
             self.manifest({**entry,'sourceJobId':self.job.name}),
             self.manifest({**entry,'unexpected':'field'}),
             {'schema':SCHEMA,'assets':[entry,{**entry,'stage':'erase_2'}]}]
        for value in bad:
            with self.subTest(value=value),self.assertRaises(ValueError):validate_stage_cache(value,self.job)

    def test_failed_parent_native_sheet_keeps_complete_line_and_rechecks_final_roi(self):
        stage='text_layer_0_attempt_2';folder=self.old/'stages'/stage;folder.mkdir(parents=True)
        native=Image.new('RGB',(2048,768),(255,0,255));draw=ImageDraw.Draw(native)
        draw.rectangle((200,100,1600,280),fill=(75,35,4))
        draw.rectangle((200,430,1600,610),fill=(75,35,4))
        fixtures.FixtureRunner()(folder,Image.new('RGB',native.size,(255,0,255)),
                                 'older native sample-sheet prompt',*native.size,lambda *_:None)
        path=folder/'model.png';path.write_bytes(fixtures.png(native))
        proof_path=path.with_suffix('.receipt.json');proof=json.loads(proof_path.read_text())
        proof.update(outputSha256=sha(path),outputBytes=path.stat().st_size)
        proof_path.write_text(json.dumps(proof))
        entry={**self.entry(stage,'text_layer_0_attempt_1'),'selectionMode':'complete-line'}
        manifest=self.manifest(entry)
        source=self.job/'reference-0.png';source.write_bytes(fixtures.png(fixtures.ProtectedCoverTest().source()))
        spec={'schema':'aiworker-protected-cover/v1','textLayers':[
            {'text':'北极驯鹿人','style':'brown brush lettering','box':{'x':40,'y':30,'width':320,'height':80}}]}
        specfile=self.job/'input.json';specfile.write_text(json.dumps(spec))
        (self.job/'stage-cache.json').write_text(json.dumps(manifest))
        runner=NativeRunner(self.backend,30,4,301,stage_cache=manifest,job_folder=self.job)
        seen=[]
        def ocr(image):
            seen.append(Path(image).name)
            if Path(image).name=='native-ocr-preview.png':
                return {'engine':'apple-vision','width':2048,'height':768,'lines':[
                    {'text':'北极驯鹿人','confidence':1,'box':[200,100,1401,181]},
                    {'text':'北极驯鹿人','confidence':1,'box':[200,430,1401,181]}]}
            return {'engine':'apple-vision','lines':[{'text':'北极驯鹿人'}]}
        before=path.read_bytes();output=self.job/'image.png'
        with patch('image_generation.protected_worker.subprocess.Popen',side_effect=AssertionError('no model replay')):
            result=build_protected(specfile,source,output,runner,ocr=ocr,stage_cache=manifest)
        self.assertEqual(seen,['native-ocr-preview.png','ocr-preview.png','final-ocr-layer-0.png'])
        self.assertEqual(result['assets'][0]['path'],str(path))
        self.assertEqual(result['assets'][0]['selectionMode'],'complete-line')
        self.assertEqual(result['photoProtection']['outsideChangedPixels'],0)
        self.assertEqual(path.read_bytes(),before)
        binding=result['textValidation']['layers'][0]
        self.assertEqual(binding['assetSelection']['selectedLineIndex'],0)
        binding['assetSelection']['selectedLineIndex']=1
        with self.assertRaisesRegex(ValueError,'native_line_selection_changed'):
            verify_protected_result(source,output,spec,result,stage_cache=manifest)

    def test_source_asset_and_all_owned_ancestors_reject_symlinks(self):
        _,entry=self.source_stage();path=self.old/'stages'/'erase_1'/'model.png'
        external=self.root/'outside.png';path.rename(external);path.symlink_to(external)
        with self.assertRaisesRegex(ValueError,'path_invalid'):validate_stage_cache(self.manifest(entry),self.job)
        path.unlink();external.rename(path)
        stage=path.parent;external_folder=self.root/'outside-stage';stage.rename(external_folder)
        stage.symlink_to(external_folder,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'path_invalid'):read_cached_asset(entry,self.job)

    def test_oversized_native_input_is_rejected_before_reading_it(self):
        _,entry=self.source_stage()
        reference=self.old/'stages'/'erase_1'/'reference.png'
        with reference.open('r+b') as stream:stream.truncate(40*1024*1024+1)
        with self.assertRaisesRegex(ValueError,'asset_invalid'):
            read_cached_asset(entry,self.job)

    def test_erasure_hit_keeps_old_receipt_and_avoids_generator(self):
        reference,entry=self.source_stage();oldpath=self.old/'stages'/'erase_1'/'model.png'
        proofpath=oldpath.with_suffix('.receipt.json');before=proofpath.read_bytes()
        runner=self.runner(entry);folder=self.target();progress=[]
        with patch('image_generation.protected_worker.subprocess.Popen',side_effect=AssertionError('no model call')):
            image,record=runner(folder,reference,'erase requested',512,512,lambda *args:progress.append(args))
        self.assertEqual(record['path'],str(oldpath));self.assertEqual(record['cacheSourceJobId'],self.old.name)
        self.assertEqual(image.size,(512,512));self.assertEqual(progress,[(30,30)])
        self.assertEqual(proofpath.read_bytes(),before)
        self.assertTrue((folder/'prompt.txt').is_file());self.assertTrue((folder/'reference.png').is_file())
        self.assertFalse((folder/'model.png').exists())

    def test_erasure_material_prompt_and_inside_roi_change_reuse_complete_native_without_model(self):
        reference,entry=self.source_stage();region={'x':20,'y':30,'width':50,'height':60}
        entry={**entry,'stage':'erase_2','selectionMode':'erasure-material','referenceRegion':region}
        current=reference.copy();ImageDraw.Draw(current).rectangle((20,30,69,89),fill='purple')
        self.assertTrue(erasure_reference_matches(reference,current,region))
        checked=validate_stage_cache(self.manifest(entry),self.job)
        self.assertIsNot(checked['assets'][0]['referenceRegion'],region)
        native=self.old/'stages'/'erase_1'/'model.png';proof=native.with_suffix('.receipt.json')
        before=native.read_bytes(),proof.read_bytes();folder=self.target('erase_2');runner=self.runner(entry)
        with patch('image_generation.protected_worker.subprocess.Popen',side_effect=AssertionError('no model replay')):
            image,record=runner(folder,current,'新的中文擦除指令',512,512,lambda *_:None)
        self.assertEqual(record['path'],str(native));self.assertEqual(record['selectionMode'],'erasure-material')
        self.assertEqual(record['cacheSourceJobId'],self.old.name);self.assertNotIn('referenceRegion',record)
        self.assertEqual((native.read_bytes(),proof.read_bytes()),before)
        self.assertEqual(image.tobytes(),Image.open(native).convert('RGB').tobytes())
        self.assertEqual((folder/'prompt.txt').read_text(),'新的中文擦除指令')
        with Image.open(folder/'reference.png')as saved:self.assertEqual(saved.tobytes(),current.tobytes())
        self.assertFalse((folder/'model.png').exists())

    def test_erasure_material_outside_pixels_and_size_miss_generate_new_stage(self):
        reference,entry=self.source_stage();region={'x':20,'y':30,'width':50,'height':60}
        entry={**entry,'selectionMode':'erasure-material','referenceRegion':region}
        cases=[]
        for name,point in [('left',(19,50)),('right',(70,50)),('top',(30,29)),('bottom',(30,90))]:
            changed=reference.copy();changed.putpixel(point,(1,2,3));cases.append((name,changed,512,512))
        cases.extend([('native-size',Image.new('RGB',(768,512),'green'),768,512),
                      ('reference-size',Image.new('RGB',(768,512),'green'),512,512)])
        for name,current,width,height in cases:
            with self.subTest(name=name):
                self.job=self.root/hashlib.md5(('erasure-material-'+name).encode()).hexdigest();self.job.mkdir()
                folder=self.target();runner=self.runner(entry)
                self.assertFalse(erasure_reference_matches(reference,current,region))
                _,record=runner(folder,current,'new erasure prompt',width,height,lambda *_:None)
                self.assertEqual(record['path'],str(folder/'model.png'))
                self.assertNotIn('cacheSourceJobId',record);self.assertNotIn('selectionMode',record)

    def test_erasure_material_region_types_modes_and_paths_are_closed(self):
        _,base=self.source_stage();region={'x':20,'y':30,'width':50,'height':60}
        entry={**base,'selectionMode':'erasure-material','referenceRegion':region}
        invalid_regions=[None,{},[20,30,50,60],{**region,'x':True},{**region,'width':50.0},
                         {**region,'width':0},{**region,'y':-1},{**region,'extra':1}]
        invalid=[{**entry,'referenceRegion':value}for value in invalid_regions]
        invalid.extend([{**base,'selectionMode':'erasure-material'},
                        {**base,'referenceRegion':region},
                        {**entry,'selectionMode':'complete-line'},
                        {**entry,'stage':'text_layer_0_attempt_1','sourceStage':'text_layer_0_attempt_1'},
                        {**entry,'stage':'text_layer_0_attempt_1'},
                        {**entry,'sourceJobId':self.job.name},
                        {**entry,'sourceJobId':'d'*32},
                        {**entry,'sourceStage':'erase_1/../../secret'},
                        {**entry,'path':'/untrusted.png'}])
        for value in invalid:
            with self.subTest(value=value),self.assertRaises(ValueError):validate_stage_cache(self.manifest(value),self.job)
        for oversized in ({**region,'x':511,'width':2},{**region,'y':511,'height':2}):
            with self.subTest(region=oversized),self.assertRaisesRegex(ValueError,'reference_region_invalid'):
                read_cached_asset({**entry,'referenceRegion':oversized},self.job)

    def test_erasure_material_region_must_fit_both_native_and_reference(self):
        _,entry=self.source_stage();folder=self.old/'stages'/'erase_1'
        reference=folder/'reference.png';proofpath=folder/'model.receipt.json'
        original=json.loads(proofpath.read_text())
        for size,region in [((1024,512),{'x':600,'y':20,'width':30,'height':40}),
                            ((256,512),{'x':300,'y':20,'width':30,'height':40})]:
            with self.subTest(size=size):
                Image.new('RGB',size,'green').save(reference)
                updated={**original,'inputs':[dict(member)for member in original['inputs']]}
                updated['inputs'][1]['sha256']=sha(reference);proofpath.write_text(json.dumps(updated))
                material={**entry,'receiptSha256':sha(proofpath),'selectionMode':'erasure-material','referenceRegion':region}
                with self.assertRaisesRegex(ValueError,'reference_region_invalid'):read_cached_asset(material,self.job)

    def test_erasure_material_runtime_fingerprint_remains_strict(self):
        reference,entry=self.source_stage();entry={**entry,'selectionMode':'erasure-material',
            'referenceRegion':{'x':20,'y':30,'width':50,'height':60}}
        folder=self.target()
        for kwargs in ({'steps':31},{'guidance':5},{'seed':302}):
            with self.subTest(kwargs=kwargs),patch('image_generation.protected_worker.subprocess.Popen',side_effect=AssertionError('no model call')):
                self.assertIsNone(self.runner(entry,**kwargs).cached(folder,reference,'any new prompt',512,512))

    def test_changed_native_png_receipt_and_input_fail_before_generation(self):
        reference,entry=self.source_stage();folder=self.target();native=self.old/'stages'/'erase_1'/'model.png'
        runner=self.runner(entry)
        for path,error in [(native,'asset_changed'),(native.with_suffix('.receipt.json'),'asset_changed'),
                           (native.parent/'reference.png','inputs_changed'),(native.parent/'prompt.txt','inputs_changed')]:
            raw=path.read_bytes();path.write_bytes(raw+b'tamper')
            with self.subTest(path=path),patch('image_generation.protected_worker.subprocess.Popen',side_effect=AssertionError('no model call')):
                with self.assertRaisesRegex(ValueError,error):runner(folder,reference,'erase requested',512,512,lambda *_:None)
            path.write_bytes(raw)
        self.assertFalse((folder/'model.png').exists())

    def test_prompt_reference_and_runtime_mismatch_generate_normal_new_stage(self):
        reference,entry=self.source_stage()
        cases=[('prompt',{},'different prompt',reference,512,512),
               ('reference',{},'erase requested',Image.new('RGB',(512,512),'red'),512,512),
               ('size',{},'erase requested',reference,768,512),
               ('steps',{'steps':31},'erase requested',reference,512,512),
               ('guidance',{'guidance':5},'erase requested',reference,512,512),
               ('seed',{'seed':302},'erase requested',reference,512,512)]
        for name,kwargs,prompt,ref,width,height in cases:
            with self.subTest(name=name):
                # Each case is an independent admitted job and never overwrites
                # a previous stage output merely to exercise a miss.
                self.job=self.root/(hashlib.md5(name.encode()).hexdigest());self.job.mkdir()
                folder=self.target();runner=self.runner(entry,**kwargs)
                _,record=runner(folder,ref,prompt,width,height,lambda *_:None)
                self.assertEqual(record['path'],str(folder/'model.png'))
                self.assertNotIn('cacheSourceJobId',record)

    def test_cached_successful_lettering_is_rechecked_in_new_job_final_roi(self):
        case=fixtures.ProtectedCoverTest();spec=case.spec();spec['eraseRegions']=[];spec['textLayers']=spec['textLayers'][:1]
        source=self.old/'reference-0.png';source.write_bytes(fixtures.png(case.source()))
        specfile=self.old/'input.json';specfile.write_text(json.dumps(spec))
        old_result=build_protected(specfile,source,self.old/'image.png',fixtures.FixtureRunner(),ocr=case.fixture_ocr)
        entry=self.entry('text_layer_0_attempt_1');manifest=self.manifest(entry)
        newsource=self.job/'reference-0.png';newsource.write_bytes(source.read_bytes())
        newspec=self.job/'input.json';newspec.write_bytes(specfile.read_bytes())
        cachefile=self.job/'stage-cache.json';cachefile.write_text(json.dumps(manifest))
        seen=[]
        def actual_ocr(path):seen.append(Path(path));return case.fixture_ocr(path)
        with patch('image_generation.protected_worker.subprocess.Popen',side_effect=AssertionError('no model call')):
            result=build_protected(newspec,newsource,self.job/'image.png',self.runner(entry),ocr=actual_ocr,stage_cache=manifest)
        self.assertEqual(len(seen),2);self.assertTrue(all(p.is_relative_to(self.job/'stages')for p in seen))
        self.assertEqual(result['assets'][0]['path'],old_result['assets'][0]['path'])
        self.assertEqual(result['assets'][0]['cacheSourceJobId'],self.old.name)
        self.assertEqual(result['stageCacheSha256'],sha(cachefile))
        self.assertEqual(result['photoProtection']['outsideChangedPixels'],0)
        self.assertTrue(Path(result['textValidation']['layers'][0]['previewPath']).is_relative_to(self.job))
        verify_protected_result(newsource,self.job/'image.png',spec,result,stage_cache=manifest)

    def test_other_model_precision_or_offline_fingerprint_is_a_miss(self):
        reference,entry=self.source_stage();proofpath=self.old/'stages'/'erase_1'/'model.receipt.json'
        original=json.loads(proofpath.read_text())
        changes=[{'repository':'another/model'},{'revision':'another-revision'},
                 {'precision':'FP16'},{'offline':False},
                 {'componentDtypes':{'transformer':'torch.float16'}},{'componentDtypes':None}]
        for index,change in enumerate(changes):
            with self.subTest(change=change):
                proofpath.write_text(json.dumps({**original,**change}));updated={**entry,'receiptSha256':sha(proofpath)}
                self.job=self.root/(str(index+1)*32);self.job.mkdir()
                folder=self.target();runner=self.runner(updated)
                _,record=runner(folder,reference,'erase requested',512,512,lambda *_:None)
                self.assertEqual(record['path'],str(folder/'model.png'))
                self.assertNotIn('cacheSourceJobId',record)

    def test_cli_requires_paired_fixed_manifest_path_and_matching_sha(self):
        reference,entry=self.source_stage();manifest=self.manifest(entry)
        cachefile=self.job/'stage-cache.json';cachefile.write_text(json.dumps(manifest))
        command=[sys.executable,'-m','image_generation.protected_worker','--spec-file',str(self.job/'input.json'),
                 '--source',str(self.job/'reference-0.png'),'--output',str(self.job/'image.png'),
                 '--backend-script',str(self.backend)]
        cases=[['--stage-cache-file',str(cachefile)],['--stage-cache-sha256',sha(cachefile)],
               ['--stage-cache-file',str(cachefile),'--stage-cache-sha256','0'*64],
               ['--stage-cache-file',str(self.root/'elsewhere.json'),'--stage-cache-sha256',sha(cachefile)]]
        for args in cases:
            with self.subTest(args=args):
                run=subprocess.run(command+args,cwd=ROOT,env={**__import__('os').environ,'PYTHONPATH':str(ROOT/'src')},capture_output=True,text=True)
                self.assertNotEqual(run.returncode,0);self.assertIn('protected_stage_cache_',run.stderr)
        self.assertFalse((self.job/'image.png').exists())


if __name__=='__main__':unittest.main()
