"""Frozen accepted regions survive implementation changes without repainting."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
import test_protected_cover as fixtures
from image_generation.protected_cover import verify_protected_result
from image_generation.protected_worker import build_protected


class ProtectedWorkerFreezeTest(unittest.TestCase):
    def fixture(self,root):
        case=fixtures.ProtectedCoverTest()
        source=root/'reference-0.png';source.write_bytes(fixtures.png(case.source()))
        spec=case.spec();specfile=root/'input.json';specfile.write_text(json.dumps(spec))
        return source,specfile,root/'image.png',spec,case.fixture_ocr

    def build(self,source,specfile,output,ocr):
        return build_protected(specfile,source,output,fixtures.FixtureRunner(),ocr=ocr)

    def test_final_rgb_regions_bind_order_geometry_and_pixel_hashes(self):
        with tempfile.TemporaryDirectory()as temp:
            source,specfile,output,spec,ocr=self.fixture(Path(temp))
            receipt=self.build(source,specfile,output,ocr)
            expected=([('erasure',i,r)for i,r in enumerate(spec['eraseRegions'])]
                      +[('text',i,r['box'])for i,r in enumerate(spec['textLayers'])])
            self.assertEqual(len(receipt['compositionRegions']),len(expected))
            with Image.open(output)as final:
                for number,(record,(role,index,box))in enumerate(zip(receipt['compositionRegions'],expected)):
                    path=Path(record['path'])
                    self.assertEqual(path,output.parent/'stages'/'composition_regions'/('region-'+str(number)+'.png'))
                    self.assertEqual((record['role'],record['index'],record['box']),(role,index,box))
                    self.assertEqual(path.stat().st_mode&0o777,0o600)
                    self.assertEqual(record['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
                    crop=final.crop((box['x'],box['y'],box['x']+box['width'],box['y']+box['height']))
                    with Image.open(path)as frozen:
                        self.assertEqual((frozen.format,frozen.mode,frozen.size),('PNG','RGB',crop.size))
                        self.assertEqual(frozen.tobytes(),crop.tobytes())
                        self.assertEqual(record['pixelSha256'],hashlib.sha256(crop.tobytes()).hexdigest())
            with (patch('image_generation.protected_cover.font_prompt',side_effect=AssertionError('no new compiler')),
                  patch('image_generation.protected_cover.keyed_letters',side_effect=AssertionError('no new matting'))):
                verify_protected_result(source,output,spec,receipt,strict_live=False)

    def test_wrong_cached_pixels_fail_without_publishing_output(self):
        with tempfile.TemporaryDirectory()as temp:
            root=Path(temp);source,specfile,output,spec,ocr=self.fixture(root)
            folder=root/'stages'/'composition_regions';folder.mkdir(parents=True)
            path=folder/'region-0.png';Image.new('RGB',(100,40),'red').save(path)
            original=path.read_bytes()
            with self.assertRaisesRegex(ValueError,'composition_region_cache_changed'):
                self.build(source,specfile,output,ocr)
            self.assertEqual(path.read_bytes(),original)
            self.assertFalse(output.exists());self.assertFalse(output.with_suffix('.receipt.json').exists())

    def test_equal_cached_region_is_reused_without_rewriting(self):
        with tempfile.TemporaryDirectory()as temp:
            source,specfile,output,spec,ocr=self.fixture(Path(temp))
            first=self.build(source,specfile,output,ocr)
            frozen=Path(first['compositionRegions'][0]['path']);stat=frozen.stat();raw=frozen.read_bytes()
            # Re-enter an unpublished checkpoint with the original stage bytes.
            output.unlink();output.with_suffix('.receipt.json').unlink()
            second=self.build(source,specfile,output,ocr)
            self.assertEqual(frozen.stat().st_ino,stat.st_ino)
            self.assertEqual(frozen.stat().st_mtime_ns,stat.st_mtime_ns)
            self.assertEqual(frozen.read_bytes(),raw)
            self.assertEqual(second['compositionRegions'],first['compositionRegions'])

    def test_symlink_region_and_folder_never_touch_external_target(self):
        for kind in ('region','folder'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory()as temp:
                root=Path(temp);source,specfile,output,spec,ocr=self.fixture(root)
                external=root/'external';external.mkdir();target=external/'region-0.png'
                Image.new('RGB',(100,40),'red').save(target);original=target.read_bytes()
                stages=root/'stages';stages.mkdir();folder=stages/'composition_regions'
                if kind=='folder':folder.symlink_to(external,target_is_directory=True)
                else:
                    folder.mkdir();(folder/'region-0.png').symlink_to(target)
                with self.assertRaisesRegex(ValueError,'composition_region_cache_invalid|stage_path_invalid'):
                    self.build(source,specfile,output,ocr)
                self.assertEqual(target.read_bytes(),original)
                self.assertFalse(output.exists())


if __name__=='__main__':unittest.main()
