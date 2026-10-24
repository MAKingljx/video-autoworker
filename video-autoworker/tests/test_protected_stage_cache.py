"""Pinned native-stage reuse; fixtures never call a model or production API."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
import test_protected_cover as fixtures
from image_generation.protected_cover import verify_protected_result
from image_generation.protected_worker import NativeRunner,build_protected
from image_generation.stage_cache import (SCHEMA,cached_asset_paths,
    read_cached_asset,validate_stage_cache)

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
