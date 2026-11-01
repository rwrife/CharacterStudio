import copy
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from skin_weights import repair_weights, segment_distance


class SkinWeightTests(unittest.TestCase):
    def test_complete_skin_is_unchanged(self):
        weights = [{"Hips": 0.7, "Spine1": 0.3}]
        original = copy.deepcopy(weights)
        self.assertEqual(repair_weights([(0, 0, 0)], [], weights), ({}, 0, 0))
        self.assertEqual(weights, original)

    def test_repair_uses_surface_distance_and_preserves_donors(self):
        points = [(0, 0, 0), (1, 0, 0), (2, 0, 0), (2.1, 0, 0)]
        weights = [{"LeftArm": 0.75, "LeftForeArm": 0.25}, {}, {}, {"Hips": 1}]
        original = copy.deepcopy(weights)
        updates, connected, fallback = repair_weights(points, [(0, 1), (1, 2)], weights)
        self.assertEqual((connected, fallback), (2, 0))
        self.assertEqual(updates, {1: weights[0], 2: weights[0]})
        self.assertEqual(weights, original)
        self.assertIsNot(updates[1], weights[0])

    def test_disconnected_pieces_require_explicit_fallback(self):
        points = [(0, 0, 0), (0.01, 0, 0), (0.02, 0, 0)]
        weights = [{"Hips": 1}, {}, {}]
        self.assertEqual(repair_weights(points, [(1, 2)], weights), ({}, 0, 0))
        bones = [("Hips", (0, 0, 0), (0, 0, 1)), ("Head", (0, 0, 2), (0, 0, 3))]
        updates, connected, fallback = repair_weights(points, [(1, 2)], weights, bones)
        self.assertEqual((connected, fallback), (0, 2))
        self.assertNotIn(0, updates)
        for influence in updates.values():
            self.assertAlmostEqual(sum(influence.values()), 1)
            self.assertGreater(influence["Hips"], influence["Head"])

    def test_all_unweighted_can_use_fitted_bones(self):
        bones = [("LeftArm", (-1, 0, 0), (0, 0, 0)), ("RightArm", (0, 0, 0), (1, 0, 0))]
        updates, connected, fallback = repair_weights([(-0.5, 0, 0), (0.5, 0, 0)], [], [{}, {}], bones)
        self.assertEqual((connected, fallback), (0, 2))
        self.assertGreater(updates[0]["LeftArm"], 0.999)
        self.assertGreater(updates[1]["RightArm"], 0.999)
        self.assertTrue(all(math.isfinite(w) for influence in updates.values() for w in influence.values()))

    def test_nearest_segment_not_nearest_bone_head(self):
        self.assertAlmostEqual(segment_distance((9, 1, 0), (0, 0, 0), (10, 0, 0)), 1)
        self.assertAlmostEqual(segment_distance((11, 0, 0), (0, 0, 0), (10, 0, 0)), 1)
        with self.assertRaisesRegex(ValueError, "zero-length"):
            segment_distance((0, 0, 0), (1, 0, 0), (1, 0, 0))

    def test_zero_length_edges_and_ties_are_deterministic(self):
        points = [(0, 0, 0)] * 4
        edges = [(0, 1), (1, 2), (2, 3)]
        weights = [{"LeftArm": 1}, {}, {}, {"RightArm": 1}]
        forward = repair_weights(points, edges, weights)
        self.assertEqual(forward, repair_weights(points, list(reversed(edges)), weights))
        self.assertEqual(forward[0], {1: {"LeftArm": 1}, 2: {"LeftArm": 1}})

    def test_reported_vertex_count_and_hole_size(self):
        count, hole = 33214, 1467
        points = [(i / count, 0, 0) for i in range(count)]
        weights = [{"Hips": 1} for _ in range(count - hole)] + [{} for _ in range(hole)]
        updates, connected, fallback = repair_weights(points, [(i, i + 1) for i in range(count - 1)], weights)
        self.assertEqual((len(updates), connected, fallback), (hole, hole, 0))
        self.assertEqual(set(updates), set(range(count - hole, count)))

    def test_invalid_data_is_not_repaired_into_success(self):
        for weight in [math.nan, math.inf, -1, 0]:
            with self.assertRaisesRegex(ValueError, "finite and positive"):
                repair_weights([(0, 0, 0)], [], [{"Hips": weight}])
        with self.assertRaisesRegex(ValueError, "non-finite"):
            repair_weights([(math.nan, 0, 0)], [], [{}])
        with self.assertRaisesRegex(ValueError, "count"):
            repair_weights([(0, 0, 0)], [], [])


if __name__ == "__main__":
    unittest.main()
