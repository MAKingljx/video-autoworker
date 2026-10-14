import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    'runtime_entry', Path(__file__).with_name('prepare-openclaw-runtime-entry.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeEntryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='runtime entry ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.node = self.root / 'node runner'
        self.node.write_text('#!/usr/bin/env python3\nimport json,sys\n'
                             'print("OpenClaw 2026.10.3" if sys.argv[2:] == ["--version"] '
                             'else json.dumps(sys.argv[2:]))\n')
        self.node.chmod(0o700)
        (self.root / 'package.json').write_text(json.dumps(
            {'name': 'openclaw', 'version': '2026.10.3'}))
        (self.root / 'openclaw.mjs').write_text('// fixture\n')

    def prepare(self):
        return module.prepare(self.node, self.root, '2026.10.3')

    def test_preserves_literal_arguments_and_paths_with_spaces(self):
        result = self.prepare()
        values = ['words with spaces', '$HOME', 'semi;colon', '--flag']
        output = subprocess.check_output([result['entry'], *values], text=True)
        self.assertEqual(json.loads(output), values)
        self.assertEqual(result['currentState'], 'PREPARED_NOT_ACTIVE')

    def test_repeat_preserves_the_same_entry(self):
        result = self.prepare()
        before = Path(result['entry']).stat().st_ino
        self.assertEqual(self.prepare(), result)
        self.assertEqual(Path(result['entry']).stat().st_ino, before)

    def test_existing_foreign_content_is_not_overwritten(self):
        target = self.root / '.aiworker-cli-entry.sh'
        target.write_text('existing content')
        with self.assertRaisesRegex(ValueError, 'runtime_entry_conflict'):
            self.prepare()
        self.assertEqual(target.read_text(), 'existing content')

    def test_symbolic_node_is_rejected(self):
        alias = self.root / 'node alias'
        alias.symlink_to(self.node)
        with self.assertRaisesRegex(ValueError, 'runtime_file_identity_invalid'):
            module.prepare(alias, self.root, '2026.10.3')

    def test_wrong_upstream_identity_creates_no_entry(self):
        (self.root / 'package.json').write_text(json.dumps(
            {'name': 'other-package', 'version': '2026.10.3'}))
        with self.assertRaisesRegex(ValueError, 'runtime_package_identity_invalid'):
            self.prepare()
        self.assertFalse((self.root / '.aiworker-cli-entry.sh').exists())


if __name__ == '__main__':
    unittest.main()
