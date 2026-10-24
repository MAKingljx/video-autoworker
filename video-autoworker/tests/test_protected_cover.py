"""Protection, HD geometry and failure gates; model calls are explicit fixtures."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageDraw

from image_generation.protected_cover import (font_prompt, keyed_letters, normalize_protected,
    paste_letters, normalized_text, protection_summary, source_image,
    split_letter_rows, validate_ocr, verify_protected_result)
from image_generation.protected_worker import build_protected


def png(image):
    stream=io.BytesIO();image.save(stream,'PNG');return stream.getvalue()


class FixtureRunner:
    """Geometric glyph fixtures test mechanics, never pretend to be real OCR."""
    repository='fixture';revision='fixture'
    def __init__(self):self.calls=[]
    def __call__(self, folder, reference, prompt, width, height, progress):
        self.calls.append(folder.name)
        if folder.name.startswith('erase'):
            image=Image.new('RGB',(width,height),(77,110,25))
        else:
            image=Image.new('RGB',(width,height),(255,0,255));draw=ImageDraw.Draw(image)
            draw.rectangle((100,int(height*.2),width-100,int(height*.55)),fill=(75,35,4))
        path=folder/'model.png';raw=png(image);path.write_bytes(raw)
        ref=folder/'reference.png';ref.write_bytes(png(reference))
        prompt_file=folder/'prompt.txt';prompt_file.write_text(prompt)
        digest=hashlib.sha256(raw).hexdigest()
        proof={'output':str(path),'outputSha256':digest,'repository':self.repository,
            'revision':self.revision,'precision':'BF16','offline':True,'postProcessing':False,
            'currentState':'GENERATED_PENDING_REVIEW','outputBytes':len(raw),
            'width':width,'height':height,'steps':30,'guidance':4,'seed':301,
            'componentDtypes':{'transformer':'torch.bfloat16','vae':'torch.bfloat16','text_encoder':'torch.bfloat16'},
            'promptSha256':hashlib.sha256(prompt.encode()).hexdigest(),
            'inputs':[{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}for p in [prompt_file,ref]]}
        proofpath=path.with_suffix('.receipt.json');proofpath.write_text(json.dumps(proof))
        return image,{'path':str(path),'sha256':digest,
            'receiptSha256':hashlib.sha256(proofpath.read_bytes()).hexdigest(),
            'repository':self.repository,'revision':self.revision,'precision':'BF16','offline':True}


class ProtectedCoverTest(unittest.TestCase):
    def fixture_ocr(self,path):
        name=Path(path).name
        strings=['逐鹿而生']if 'text_layer_1_'in str(path)or name=='final-ocr-layer-1.png'else ['北极驯鹿人']
        return {'engine':'apple-vision','lines':[{'text':value}for value in strings]}
    def spec(self):
        return {'schema':'aiworker-protected-cover/v1',
            'eraseRegions':[{'x':510,'y':410,'width':100,'height':40}],
            'textLayers':[{'text':'北极驯鹿人','box':{'x':40,'y':30,'width':320,'height':80}},
                          {'text':'逐鹿而生','box':{'x':40,'y':125,'width':280,'height':40}}]}

    def source(self):
        y,x=np.mgrid[:480,:640]
        return Image.fromarray(np.dstack((x%256,y%256,(x+y)%256)).astype('uint8'),'RGB')

    def test_native_full_hd_size_is_not_aligned_or_rescaled(self):
        raw=png(Image.new('RGB',(1920,1080),'white'))
        spec,size=normalize_protected({'schema':'aiworker-protected-cover/v1',
            'textLayers':[{'text':'标题','box':{'x':40,'y':30,'width':600,'height':140}}]},raw)
        self.assertEqual(size,(1920,1080));self.assertEqual(spec['eraseRegions'],[])

    def test_one_layer_prompt_separates_inscription_from_concise_instructions(self):
        layer={'text':'北极驯鹿人','style':'北极驯鹿人 Warm gold with a dark brown outline.'}
        prompt=font_prompt(layer)
        self.assertEqual(prompt.splitlines()[0],'标题文字内容：'+layer['text'])
        self.assertEqual(prompt.count(layer['text']),1)
        self.assertIn('文字完整只写一次，水平单行',prompt)
        self.assertIn('Warm gold with a dark brown outline.',prompt)
        self.assertNotIn('"'+layer['text']+'"',prompt)
        self.assertNotIn('Line 1',prompt)
        self.assertNotIn('top to bottom',prompt)
        retry=font_prompt(layer,True)
        self.assertEqual(retry.splitlines()[0],'标题文字内容：'+layer['text'])
        self.assertEqual(retry.count(layer['text']),1)
        self.assertIn('笔画准确清楚',retry)
        self.assertIn('Warm gold with a dark brown outline.',retry)
        self.assertIn('保留指定文字颜色',retry)
        with self.assertRaisesRegex(ValueError,'font_layer_invalid'):
            font_prompt([layer,{'text':'逐鹿而生'}])

    def test_prompt_budget_checks_each_real_first_and_retry_layer(self):
        with patch('image_generation.protected_cover.font_prompt',return_value='short')as compile:
            spec,_=normalize_protected(self.spec(),png(self.source()))
        self.assertEqual([(call.args[0]['text'],call.args[1])for call in compile.call_args_list],
            [('北极驯鹿人',False),('北极驯鹿人',True),('逐鹿而生',False),('逐鹿而生',True)])
        def oversized_retry(layer,retry):
            return '字'*6000 if layer['text']=='逐鹿而生'and retry else 'short'
        with patch('image_generation.protected_cover.font_prompt',side_effect=oversized_retry):
            with self.assertRaisesRegex(ValueError,'font_prompt_too_large'):
                normalize_protected(spec,png(self.source()))

    def test_transparent_and_non_rgb_sources_are_not_silently_color_converted(self):
        with self.assertRaisesRegex(ValueError,'opaque_photo'):
            source_image(png(Image.new('RGBA',(640,480),(1,2,3,0))))
        stream=io.BytesIO();Image.new('CMYK',(640,480)).save(stream,'JPEG')
        with self.assertRaisesRegex(ValueError,'rgb_photo_required'):source_image(stream.getvalue())

    def test_regions_and_unknown_fields_fail_before_any_model_call(self):
        raw=png(self.source())
        for change in ['outside','overlap','area','unknown']:
            spec=self.spec()
            if change=='outside':spec['eraseRegions'][0]['x']=630
            if change=='overlap':spec['textLayers'][1]['box']['y']=70
            if change=='area':spec['eraseRegions']=[{'x':0,'y':170,'width':640,'height':300}]
            if change=='unknown':spec['model']='unapproved'
            with self.subTest(change=change),self.assertRaises(ValueError):normalize_protected(spec,raw)

    def test_uniform_key_and_two_rows_preserve_real_native_glyph_colors(self):
        image=Image.new('RGB',(1024,768),(255,0,255));draw=ImageDraw.Draw(image)
        draw.rectangle((100,100,900,300),fill=(240,235,210));draw.rectangle((200,500,800,620),fill=(70,30,0))
        matte=keyed_letters(image);rows=split_letter_rows(matte,2)
        self.assertEqual(matte.getpixel((0,0))[3],0)
        self.assertEqual(rows[0].getpixel((10,10)),(240,235,210,255))
        self.assertEqual(len(rows),2)
        with self.assertRaisesRegex(ValueError,'key_mismatch'):keyed_letters(Image.new('RGB',(1024,768),'white'))

    def test_ocr_does_not_silently_fix_wrong_characters_or_roman_numerals(self):
        validate_ocr([{'text':'地球之极 VI · 第5集'}],{'lines':[{'text':'地球之极 VI • 第 5 集'}]})
        with self.assertRaisesRegex(ValueError,'mismatch'):
            validate_ocr([{'text':'地球之极 VI'}],{'lines':[{'text':'地球之极 V1'}]})
        with self.assertRaisesRegex(ValueError,'mismatch'):
            validate_ocr([{'text':'北极驯鹿人'}],{'lines':[{'text':'北极训鹿人'}]})
        with self.assertRaisesRegex(ValueError,'mismatch'):
            validate_ocr([{'text':'北极驯鹿人'}],{'lines':[{'text':'“北极驯鹿人”'}]})

    def test_no_upscale_is_allowed_for_small_model_glyph_asset(self):
        base=self.source();row=Image.new('RGBA',(20,10),(1,2,3,255))
        with self.assertRaisesRegex(ValueError,'resolution_too_low'):
            paste_letters(base,[row],[{'text':'字','box':{'x':0,'y':0,'width':100,'height':60},'align':'left'}])
        with self.assertRaisesRegex(ValueError,'resolution_too_low'):
            paste_letters(base,[Image.new('RGBA',(1000,100),(1,2,3,255))],
                [{'text':'字','box':{'x':0,'y':0,'width':1001,'height':101},'align':'left'}])

    def test_split_preserves_small_detached_strokes_and_rejects_clipping(self):
        image=Image.new('RGB',(1024,768),(255,0,255));draw=ImageDraw.Draw(image)
        draw.rectangle((100,110,900,310),fill=(75,35,0));draw.rectangle((250,510,770,630),fill=(240,230,210))
        draw.rectangle((200,80,203,82),fill=(75,35,0))
        matte=keyed_letters(image);rows=split_letter_rows(matte,2)
        self.assertEqual(np.count_nonzero(np.asarray(matte.getchannel('A'))),
            sum(np.count_nonzero(np.asarray(r.getchannel('A')))for r in rows))
        draw.rectangle((0,200,10,400),fill=(75,35,0))
        with self.assertRaisesRegex(ValueError,'clipped'):keyed_letters(image)

    def test_composition_keeps_every_pixel_outside_explicit_edits(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            raw=png(self.source());source.write_bytes(raw);specpath.write_text(json.dumps(self.spec()))
            runner=FixtureRunner()
            result=build_protected(specpath,source,output,runner,ocr=self.fixture_ocr)
            self.assertEqual(result['photoProtection']['outsideChangedPixels'],0)
            self.assertTrue(result['postProcessing']);self.assertEqual(len(runner.calls),3)
            before=np.asarray(self.source());after=np.asarray(Image.open(output))
            # Independent bounds, not the implementation's own mask helper.
            allowed=np.zeros((480,640),bool);allowed[410:450,510:610]=True
            allowed[30:110,40:360]=True;allowed[125:165,40:320]=True
            self.assertTrue(np.array_equal(before[~allowed],after[~allowed]))
            self.assertTrue(np.any(before[410:450,510:610]!=after[410:450,510:610]))
            verify_protected_result(source,output,self.spec(),result)
            tampered=Image.open(output).copy();tampered.putpixel((639,0),(255,255,255));tampered.save(output)
            result['outputSha256']=hashlib.sha256(output.read_bytes()).hexdigest();result['outputBytes']=output.stat().st_size
            with self.assertRaisesRegex(ValueError,'pixels_changed'):
                verify_protected_result(source,output,self.spec(),result)

    def test_forged_ocr_cannot_accept_a_final_photo_with_no_generated_letters(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            source.write_bytes(png(self.source()));spec=self.spec();spec['eraseRegions']=[];specpath.write_text(json.dumps(spec))
            result=build_protected(specpath,source,output,FixtureRunner(),ocr=self.fixture_ocr)
            source_image(source.read_bytes()).save(output)
            result['outputSha256']=hashlib.sha256(output.read_bytes()).hexdigest();result['outputBytes']=output.stat().st_size
            result['photoProtection']=protection_summary(self.source(),Image.open(output),
                normalize_protected(spec,source.read_bytes())[0])
            with self.assertRaises(ValueError):verify_protected_result(source,output,spec,result)

    def test_sealed_history_survives_prompt_and_renderer_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            source.write_bytes(png(self.source()));specpath.write_text(json.dumps(self.spec()))
            result=build_protected(specpath,source,output,FixtureRunner(),ocr=self.fixture_ocr)
            with patch('image_generation.protected_cover.font_prompt',return_value='new prompt'), \
                    patch('image_generation.protected_cover.keyed_letters',side_effect=RuntimeError('new renderer')):
                verify_protected_result(source,output,self.spec(),result,strict_live=False)
                with self.assertRaisesRegex(ValueError,'prompt_changed'):
                    verify_protected_result(source,output,self.spec(),result)
            region=Path(result['compositionRegions'][0]['path'])
            region.write_bytes(png(Image.new('RGB',(100,40),'red')))
            with self.assertRaisesRegex(ValueError,'composition_region_changed'):
                verify_protected_result(source,output,self.spec(),result,strict_live=False)

    def test_historical_readback_still_checks_native_assets_and_ocr_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            source.write_bytes(png(self.source()));specpath.write_text(json.dumps(self.spec()))
            result=build_protected(specpath,source,output,FixtureRunner(),ocr=self.fixture_ocr)
            preview=Path(result['textValidation']['layers'][0]['previewPath'])
            raw=preview.read_bytes();preview.write_bytes(raw+b'changed')
            with self.assertRaisesRegex(ValueError,'ocr_preview_changed'):
                verify_protected_result(source,output,self.spec(),result,strict_live=False)
            preview.write_bytes(raw)
            asset=Path(result['assets'][0]['path']);asset.write_bytes(asset.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError,'native_asset_changed'):
                verify_protected_result(source,output,self.spec(),result,strict_live=False)

    def test_each_final_text_roi_is_verified_independently_and_cache_is_bound(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            source.write_bytes(png(self.source()));specpath.write_text(json.dumps(self.spec()))
            def misplaced(path):
                if Path(path).name=='final-ocr-layer-0.png':return {'lines':[{'text':'北极'}]}
                return self.fixture_ocr(path)
            runner=FixtureRunner()
            with self.assertRaisesRegex(ValueError,'mismatch'):
                build_protected(specpath,source,output,runner,ocr=misplaced)
            self.assertFalse(output.exists());self.assertEqual(len(runner.calls),3)

    def test_parent_stage_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);job=root/'job';job.mkdir();elsewhere=root/'other';elsewhere.mkdir()
            (job/'stages').symlink_to(elsewhere,target_is_directory=True)
            source=job/'reference-0.png';specpath=job/'input.json';source.write_bytes(png(self.source()));specpath.write_text(json.dumps(self.spec()))
            with self.assertRaisesRegex(ValueError,'stage_path_invalid'):
                build_protected(specpath,source,job/'image.png',FixtureRunner(),ocr=self.fixture_ocr)
            self.assertEqual(list(elsewhere.iterdir()),[])

    def test_wrong_generated_text_gets_two_bounded_attempts_and_no_final_output(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            source.write_bytes(png(self.source()));specpath.write_text(json.dumps(self.spec()))
            runner=FixtureRunner()
            with self.assertRaisesRegex(ValueError,'mismatch'):
                build_protected(specpath,source,output,runner,ocr=lambda _: {'lines':[{'text':'错误'}]})
            self.assertEqual(len(runner.calls),3)
            self.assertEqual(runner.calls[0],'erase_1')
            self.assertTrue(all(name.startswith('text_layer_0_attempt_')for name in runner.calls[1:]))
            self.assertFalse(output.exists())
            self.assertEqual(json.loads(output.with_suffix('.intent.json').read_text())['currentState'],'FAILED')

    def test_wrong_later_layer_retries_at_native_size_without_regenerating_successful_layer(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            source.write_bytes(png(self.source()));specpath.write_text(json.dumps(self.spec()))
            def first_subtitle_wrong(path):
                if 'text_layer_1_attempt_1'in str(path):return {'lines':[{'text':'错误'}]}
                return self.fixture_ocr(path)
            runner=FixtureRunner()
            result=build_protected(specpath,source,output,runner,ocr=first_subtitle_wrong)
            self.assertEqual(runner.calls,['erase_1','text_layer_0_attempt_1',
                                          'text_layer_1_attempt_1','text_layer_1_attempt_2'])
            sizes=[]
            for name in runner.calls[1:]:
                with Image.open(root/'stages'/name/'reference.png')as image:sizes.append(image.size)
            self.assertEqual(sizes,[(1536,512),(1024,512),(1024,512)])
            self.assertEqual(result['textValidation']['assetAttempts'],3)
            self.assertEqual(result['photoProtection']['outsideChangedPixels'],0)

    def test_only_insufficient_native_resolution_enlarges_the_bounded_retry(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);source=root/'reference-0.png';specpath=root/'input.json';output=root/'image.png'
            source.write_bytes(png(Image.new('RGB',(1920,1080),'navy')))
            spec={'schema':'aiworker-protected-cover/v1','textLayers':[{
                'text':'北极驯鹿人','box':{'x':40,'y':30,'width':1600,'height':400}}]}
            specpath.write_text(json.dumps(spec));runner=FixtureRunner()
            result=build_protected(specpath,source,output,runner,ocr=self.fixture_ocr)
            self.assertEqual(runner.calls,['text_layer_0_attempt_1','text_layer_0_attempt_2'])
            self.assertEqual(json.loads((root/'stages'/runner.calls[0]/'validation.json').read_text())['errorCode'],
                             'protected_text_native_resolution_too_low')
            with Image.open(root/'stages'/runner.calls[1]/'reference.png')as image:
                self.assertEqual(image.size,(2048,768))
            self.assertEqual(result['textValidation']['assetAttempts'],2)
            self.assertEqual(result['photoProtection']['outsideChangedPixels'],0)


if __name__=='__main__':unittest.main()
