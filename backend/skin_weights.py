"""Deterministic missing-weight repair without changing geometry or fitted joints."""
import heapq
import math


def segment_distance(point, head, tail):
    direction = [b - a for a, b in zip(head, tail)]
    length_squared = sum(v * v for v in direction)
    if length_squared <= 0:
        raise ValueError("Cannot skin to a zero-length bone. Refit the landmarks.")
    t = max(0, min(1, sum((p - h) * d for p, h, d in zip(point, head, direction)) / length_squared))
    return math.dist(point, [h + t * d for h, d in zip(head, direction)])


def repair_weights(points, edges, weights, bones=()):
    """Return only missing-vertex assignments; bones enable explicit proximity fallback."""
    if len(points) != len(weights):
        raise ValueError("Skin weight count does not match mesh vertices.")
    for point in points:
        if len(point) != 3 or not all(math.isfinite(v) for v in point):
            raise ValueError("Mesh contains non-finite coordinates. Repair the geometry before rigging.")
    for influence in weights:
        if any(not math.isfinite(w) or w <= 0 for w in influence.values()):
            raise ValueError("Skin weights must be finite and positive.")
    missing = {i for i, influence in enumerate(weights) if not influence}
    if not missing:
        return {}, 0, 0
    neighbors = [[] for _ in points]
    for a, b in edges:
        distance = math.dist(points[a], points[b])
        neighbors[a].append((b, distance))
        neighbors[b].append((a, distance))
    # Follow mesh edges, not spatial neighbors, so nearby separate limbs cannot donate weights.
    distances, donors, queue = {}, {}, []
    for vertex in sorted(missing):
        for neighbor, distance in neighbors[vertex]:
            if weights[neighbor] and (distance, neighbor) < (distances.get(vertex, math.inf), donors.get(vertex, math.inf)):
                distances[vertex], donors[vertex] = distance, neighbor
                heapq.heappush(queue, (distance, neighbor, vertex))
    while queue:
        distance, donor, vertex = heapq.heappop(queue)
        if (distance, donor) != (distances[vertex], donors[vertex]):
            continue
        for neighbor, length in neighbors[vertex]:
            candidate = (distance + length, donor)
            if neighbor in missing and candidate < (distances.get(neighbor, math.inf), donors.get(neighbor, math.inf)):
                distances[neighbor], donors[neighbor] = candidate
                heapq.heappush(queue, (*candidate, neighbor))
    updates = {vertex: dict(weights[donor]) for vertex, donor in donors.items()}
    connected = len(updates)
    if bones:
        for vertex in sorted(missing - updates.keys()):
            nearest = sorted((segment_distance(points[vertex], head, tail), name) for name, head, tail in bones)[:2]
            # Ratio scaling avoids huge inverse-distance weights at a bone endpoint.
            scale = max(nearest[0][0], 1e-6)
            influence = {name: (scale / max(distance, 1e-6)) ** 2 for distance, name in nearest}
            total = sum(influence.values())
            updates[vertex] = {name: weight / total for name, weight in influence.items()}
    return updates, connected, len(updates) - connected
