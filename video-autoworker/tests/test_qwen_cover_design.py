"""Regression checks for the reusable design-input adapter, without model calls."""
import importlib.util
import json
from pathlib import Path
import unittest

PRODUCT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qwen_cover_design', PRODUCT / 'scripts/aiworker-qwen-cover.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CoverDesignTest(unittest.TestCase):
    def setUp(self):
        self.profiles = json.loads((PRODUCT / 'ops/image-generation/qwen-image-edit-2511/cover-design-profiles.json').read_text())
        self.design = {'schema': 'aiworker-qwen-cover-design/v1', 'profile': 'ice-documentary',
                       'text': {'kicker': '纪实现场', 'title': '生命暂停键',
                                'subtitle': '未来能醒来吗？', 'caption': '走进低温保存研究'}}

    def test_exact_new_text_and_material_are_preserved(self):
        prompt = module.cover_design_prompt(self.design, self.profiles)
        for value in self.design['text'].values():
            self.assertEqual(prompt.count(json.dumps(value, ensure_ascii=False)), 1)
        for word in ('冰裂纹', '下垂冰柱', '霜晶', '中性柔光'):
            self.assertIn(word, prompt)
        self.assertNotIn('冷冻人', prompt)

    def test_control_text_rejected_before_generation(self):
        self.design['text']['title'] = '生命\n暂停键'
        with self.assertRaisesRegex(ValueError, 'qwen_cover_text_invalid:title'):
            module.cover_design_prompt(self.design, self.profiles)

    def test_unknown_profile_and_unknown_field_rejected(self):
        self.design['profile'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'qwen_cover_profile_unknown'):
            module.cover_design_prompt(self.design, self.profiles)
        self.design['profile'] = 'ice-documentary'
        self.design['model'] = 'unapproved-model'
        with self.assertRaisesRegex(ValueError, 'qwen_cover_design_invalid'):
            module.cover_design_prompt(self.design, self.profiles)

    def test_duplicate_text_and_missing_text_rejected(self):
        self.design['text']['caption'] = self.design['text']['title']
        with self.assertRaisesRegex(ValueError, 'qwen_cover_text_duplicate'):
            module.cover_design_prompt(self.design, self.profiles)
        del self.design['text']['caption']
        with self.assertRaisesRegex(ValueError, 'qwen_cover_text_fields_invalid'):
            module.cover_design_prompt(self.design, self.profiles)

    def test_invalid_profile_container_has_stable_error(self):
        self.design['profile'] = []
        with self.assertRaisesRegex(ValueError, 'qwen_cover_profile_unknown'):
            module.cover_design_prompt(self.design, self.profiles)
        self.design['profile'] = 'ice-documentary'
        self.profiles['profiles'] = []
        with self.assertRaisesRegex(ValueError, 'qwen_cover_profile_unknown'):
            module.cover_design_prompt(self.design, self.profiles)


if __name__ == '__main__':
    unittest.main()
