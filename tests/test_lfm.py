"""Small local bridge-contract tests; no weights, network or inference."""
import sys
import unittest
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from studio_kimodo_lfm.encoder import map_features, noncausal_conv


class Mapper:
    def __init__(self, result):
        self.result = result

    def transform(self, _features):
        return self.result


class LFMContractTests(unittest.TestCase):
    def test_outputs_one_finite_4096_vector_per_caption(self):
        features = np.ones((2, 1024), dtype=np.float32)
        tensor, lengths = map_features(Mapper(np.ones((2, 4096), dtype=np.float32)), features, "cpu")
        self.assertEqual(tuple(tensor.shape), (2, 1, 4096))
        self.assertEqual(lengths, [1, 1])
        self.assertEqual(tensor.dtype, torch.float32)

    def test_rejects_bad_dimensions_and_nonfinite_output(self):
        for result in (np.ones((1, 4096)), np.ones((2, 1024)), np.full((2, 4096), np.nan)):
            with self.subTest(shape=result.shape), self.assertRaisesRegex(ValueError, "invalid conditioning"):
                map_features(Mapper(result), np.ones((2, 1024)), "cpu")

    def test_rejects_packed_or_cached_sequences_instead_of_changing_the_recipe(self):
        for kwargs in ({"seq_idx": torch.ones(1)}, {"past_key_values": object()}):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, "not supported"):
                noncausal_conv(None, None, **kwargs)


if __name__ == "__main__":
    unittest.main()
