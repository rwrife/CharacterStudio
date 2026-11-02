"""Contract tests for the optional remote ComfyUI bridge; no model inference."""
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class ProviderNodesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.seen = []
        seen = self.seen

        class Sampler:
            def sample(self, model, conditioning, **kwargs):
                path = kwargs["constraints_json"]
                seen.append((kwargs, json.loads(Path(path).read_text()) if path else None))
                return ("fixture-motion",)

        self.modules = patch.dict(sys.modules, {
            "folder_paths": types.SimpleNamespace(get_output_directory=lambda: str(self.root)),
            "nodes": types.SimpleNamespace(NODE_CLASS_MAPPINGS={"Kimodo_Sampler": Sampler}),
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)
        source = Path(__file__).resolve().parents[1] / "backend" / "studio_provider_nodes" / "__init__.py"
        spec = importlib.util.spec_from_file_location("provider_test_nodes", source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_inline_constraints_are_materialized_and_removed_after_sampling(self):
        constraints = [{"frame_indices": [0, 59], "pose": "actual parent endpoint"}]
        result = self.module.Studio_Kimodo_Sampler().sample("model", "condition", 2, 42, 1, 80, json.dumps(constraints))
        self.assertEqual(result, ("fixture-motion",))
        kwargs, actual = self.seen[0]
        self.assertEqual(actual, constraints)
        self.assertEqual(kwargs["seed"], 42)
        self.assertFalse(Path(kwargs["constraints_json"]).exists())

    def test_absent_constraints_do_not_create_a_file_and_paths_are_rejected(self):
        self.module.Studio_Kimodo_Sampler().sample("model", "condition", 2, 42, 1, 80, "{}")
        self.assertEqual(self.seen[0][0]["constraints_json"], "")
        with self.assertRaises(ValueError):
            self.module.Studio_Kimodo_Sampler().sample("model", "condition", 2, 42, 1, 80, '"/private/constraints.json"')

    def test_output_descriptors_are_scoped_to_generated_motion(self):
        file = self.root / "studio_fixture_1.npz"
        file.write_bytes(b"fixture")
        result = self.module.Studio_MotionFile().describe(str(file))
        self.assertEqual(result["ui"]["files"], [{"filename": file.name, "subfolder": "", "type": "output"}])
        with self.assertRaises(ValueError):
            self.module.Studio_MotionFile().describe(__file__)
        unexpected = self.root / "private.npz"
        unexpected.write_bytes(b"not-a-job")
        with self.assertRaises(ValueError):
            self.module.Studio_MotionFile().describe(str(unexpected))


if __name__ == "__main__":
    unittest.main()
