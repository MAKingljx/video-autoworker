"""Geometric bitmap fixtures exercise selection; no software fonts or models."""
import hashlib
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image,ImageDraw

from image_generation.font_selection import select_lettering_line


class FontSelectionTest(unittest.TestCase):
    def fixture(self,texts=('北极驯鹿人','北极驯鹿人')):
        image=Image.new('RGBA',(640,300),(7,9,11,0));draw=ImageDraw.Draw(image)
        lines=[]
        for index,text in enumerate(texts):
            y=40+120*index
            for i in range(5):draw.rectangle((100+i*30,y,119+i*30,y+24),fill=(35+index,70,90,255))
            lines.append({'text':text,'confidence':1,'box':[80,y-10,200,45]})
        return image,{'width':640,'height':300,'lines':lines}

    def test_two_exact_rows_choose_first_whole_line_deterministically(self):
        image,observed=self.fixture();before=image.tobytes()
        row,proof=select_lettering_line(image,observed,'北极驯鹿人')
        self.assertEqual(proof['selectedLineIndex'],0)
        self.assertEqual(proof['componentCount'],10);self.assertEqual(proof['selectedComponentCount'],5)
        self.assertEqual(len(proof['discardedLines']),1)
        self.assertEqual(proof['discardedLines'][0]['observedText'],'北极驯鹿人')
        self.assertEqual(image.tobytes(),before)
        self.assertEqual(proof['selectedRgbaSha256'],hashlib.sha256(row.tobytes()).hexdigest())
        second,again=select_lettering_line(image,observed,'北极驯鹿人')
        self.assertEqual(again,proof);self.assertEqual(second.tobytes(),row.tobytes())

    def test_exactly_original_rgba_components_and_soft_alpha_are_preserved(self):
        image,observed=self.fixture();image.putpixel((100,40),(13,27,39,51))
        row,proof=select_lettering_line(image,observed,'北极驯鹿人')
        self.assertEqual(row.getpixel((0,0)),(13,27,39,51))
        box=proof['selectedRect'];source=np.asarray(image)
        crop=source[box['y']:box['y']+box['height'],box['x']:box['x']+box['width']]
        selected=np.asarray(row);active=selected[:,:,3]>0
        self.assertTrue(np.array_equal(selected[active],crop[active]))
        self.assertEqual(int(active.sum()),proof['selectedLine']['pixels'])
        self.assertEqual(sum(c['pixels']for c in proof['components']),int((source[:,:,3]>0).sum()))

    def test_quoted_row_is_not_repaired_or_selected_as_unquoted_text(self):
        image,observed=self.fixture(('“北极驯鹿人”','北极驯鹿人'))
        draw=ImageDraw.Draw(image)
        for x in (85,255):draw.rectangle((x,40,x+4,45),fill=(12,33,55,255))
        row,proof=select_lettering_line(image,observed,'北极驯鹿人')
        self.assertEqual(proof['selectedLineIndex'],1)
        self.assertEqual(proof['discardedLines'][0]['observedText'],'“北极驯鹿人”')
        self.assertEqual(proof['discardedLines'][0]['componentIds'],list(range(7)))
        with self.assertRaisesRegex(ValueError,'selection_missing'):
            select_lettering_line(image.crop((0,0,640,120)),
                {'width':640,'height':120,'lines':observed['lines'][:1]},'北极驯鹿人')

    def test_same_row_ocr_word_blocks_and_separate_quotes_are_kept_in_reading_order(self):
        image,observed=self.fixture(('北极驯鹿人',))
        observed['lines']=[{'text':'北极','confidence':1,'box':[90,30,65,45]},
                           {'text':'驯鹿人','confidence':1,'box':[155,30,110,45]}]
        _,proof=select_lettering_line(image,observed,'北极驯鹿人')
        self.assertEqual(proof['selectedLine']['ocrBlockIndices'],[0,1])
        self.assertEqual(proof['selectedLine']['observedText'],'北极驯鹿人')
        ImageDraw.Draw(image).rectangle((80,40,84,45),fill=(12,33,55,255))
        observed['lines'].insert(0,{'text':'“','confidence':1,'box':[75,30,15,25]})
        with self.assertRaisesRegex(ValueError,'selection_missing'):
            select_lettering_line(image,observed,'北极驯鹿人')

    def test_connected_component_crossing_rows_is_never_split(self):
        image,observed=self.fixture(('错误文字','北极驯鹿人'))
        ImageDraw.Draw(image).line((110,60,110,165),fill=(60,80,100,255),width=1)
        with self.assertRaisesRegex(ValueError,'component_crosses_lines'):
            select_lettering_line(image,observed,'北极驯鹿人')
        # Matching the other line cannot alter segmentation or hide the bridge.
        with self.assertRaisesRegex(ValueError,'component_crosses_lines'):
            select_lettering_line(image,observed,'错误文字')

    def test_detached_stroke_just_outside_ocr_box_stays_with_its_complete_line(self):
        image,observed=self.fixture(('北极驯鹿人',))
        observed['lines'][0]['box']=[80,40,200,30]
        ImageDraw.Draw(image).rectangle((110,37,112,38),fill=(50,60,70,90))
        row,proof=select_lettering_line(image,observed,'北极驯鹿人')
        self.assertEqual(proof['selectedComponentCount'],6)
        self.assertEqual(proof['selectedRect']['y'],37)
        self.assertEqual(row.getpixel((10,0)),(50,60,70,90))

    def test_tiny_bridge_into_another_rows_exclusive_area_is_not_ignored(self):
        image=Image.new('RGBA',(640,300));draw=ImageDraw.Draw(image)
        draw.rectangle((100,40,119,64),fill=(1,2,3,255))
        draw.line((110,65,110,80),fill=(1,2,3,255),width=1)
        draw.rectangle((130,80,149,104),fill=(1,2,3,255))
        observed={'lines':[{'text':'标题','confidence':1,'box':[80,30,80,45]},
                           {'text':'其他','confidence':1,'box':[80,70,80,45]}]}
        with self.assertRaisesRegex(ValueError,'component_crosses_lines'):
            select_lettering_line(image,observed,'标题')

    def test_unobserved_ink_is_not_silently_discarded(self):
        image,observed=self.fixture()
        ImageDraw.Draw(image).rectangle((540,260,550,280),fill=(11,33,55,255))
        with self.assertRaisesRegex(ValueError,'component_unassigned'):
            select_lettering_line(image,observed,'北极驯鹿人')

    def test_missing_or_wrong_character_and_roman_numeral_are_not_corrected(self):
        for text in ('北极驯鹿','北极训鹿人','地球之极V1'):
            image,observed=self.fixture((text,))
            with self.subTest(text=text),self.assertRaisesRegex(ValueError,'selection_missing'):
                select_lettering_line(image,observed,'地球之极VI'if text.endswith('V1')else'北极驯鹿人')

    def test_edge_clipping_low_resolution_and_uncertain_ocr_are_rejected(self):
        image,observed=self.fixture(('北极驯鹿人',));image.putpixel((0,40),(40,60,80,1))
        with self.assertRaisesRegex(ValueError,'asset_clipped'):select_lettering_line(image,observed,'北极驯鹿人')
        image,observed=self.fixture(('北极驯鹿人',));observed['lines'][0]['confidence']=.7
        with self.assertRaisesRegex(ValueError,'ocr_uncertain'):select_lettering_line(image,observed,'北极驯鹿人')
        image=Image.new('RGBA',(640,300));ImageDraw.Draw(image).rectangle((100,40,230,45),fill=(1,2,3,255))
        with self.assertRaisesRegex(ValueError,'resolution_too_low'):select_lettering_line(image,observed|{'lines':[{'text':'北极驯鹿人','confidence':1,'box':[80,30,200,45]}]},'北极驯鹿人')

    def test_ocr_block_component_run_and_pixel_budgets_fail_closed(self):
        image,observed=self.fixture()
        with self.assertRaisesRegex(ValueError,'selection_budget'):
            select_lettering_line(image,{**observed,'lines':observed['lines']*9},'北极驯鹿人')
        with patch('image_generation.font_selection.MAX_RUNS',5),self.assertRaisesRegex(ValueError,'selection_budget'):
            select_lettering_line(image,observed,'北极驯鹿人')
        with patch('image_generation.font_selection.MAX_PIXELS',100),self.assertRaisesRegex(ValueError,'asset_invalid'):
            select_lettering_line(image,observed,'北极驯鹿人')
        noise=Image.new('RGBA',(256,256));data=np.asarray(noise).copy();data[2:254:2,2:254:2]=[1,2,3,255]
        with self.assertRaisesRegex(ValueError,'selection_budget'):
            select_lettering_line(Image.fromarray(data,'RGBA'),{'lines':[{'text':'字','confidence':1,'box':[1,1,254,254]}]},'字')

    def test_invalid_or_conflicting_ocr_geometry_is_rejected(self):
        image,observed=self.fixture()
        for change in ({'box':[-1,1,10,10]},{'box':[1.,1,10,10]},
                       {'confidence':float('nan')},{'text':''}):
            malformed={**observed,'lines':[{**observed['lines'][0],**change}]}
            with self.subTest(change=change),self.assertRaisesRegex(ValueError,'ocr_invalid'):
                select_lettering_line(image,malformed,'北极驯鹿人')
        with self.assertRaisesRegex(ValueError,'dimensions_invalid'):
            select_lettering_line(image,{**observed,'width':100},'北极驯鹿人')


if __name__=='__main__':unittest.main()
