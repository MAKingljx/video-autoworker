import importlib.util
from pathlib import Path
import unittest


SOURCE = Path(__file__).with_name("run-openclaw-profile-agent.py")
SPEC = importlib.util.spec_from_file_location("run_openclaw_profile_agent", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class GatewayTokenFormatTest(unittest.TestCase):
    def test_accepts_supported_gateway_token_lengths(self):
        self.assertTrue(MODULE.is_gateway_token("a" * 48))
        self.assertTrue(MODULE.is_gateway_token("b" * 64))

    def test_rejects_other_token_shapes(self):
        for value in ("", "c" * 47, "d" * 49, "E" * 48, "x" * 64):
            self.assertFalse(MODULE.is_gateway_token(value))


if __name__ == "__main__":
    unittest.main()
