"""Guided, local three-chain hands. No geometry generation or learned fitting."""
import math
from copy import deepcopy

from mathutils import Quaternion, Vector

CHAINS = (("Thumb", "thumb", 2, (65, 65)), ("Index", "index", 3, (70, 90, 55)), ("Fingers", "fingers", 3, (70, 90, 55)))


def hand_definitions(setup, conversion):
    hands = setup.get("hands")
    if hands is None:
        return {}
    if not isinstance(hands, dict) or set(hands) != {"left", "right"}:
        raise ValueError("Hand rig settings require left and right hands.")
    result = {}
    for side in ("left", "right"):
        config = hands[side]
        if config == {"detail": "wrist"}:
            continue
        if not isinstance(config, dict) or set(config) != {"detail", "thumbRadius", "indexRadius", "fingersRadius"} or config["detail"] != "basic":
            raise ValueError("Unsupported hand rig detail.")
        if any(type(config[key]) not in (int, float) or not math.isfinite(config[key]) or not 0.003 <= config[key] <= 0.08
               for key in ("thumbRadius", "indexRadius", "fingersRadius")):
            raise ValueError("Hand influence radii must be between 3mm and 8cm.")
        prefix = side.capitalize()
        names = [prefix + "Hand", prefix + "HandEnd", prefix + "PalmNormal"]
        names += [f"{prefix}{chain}{i + 1}" for chain, _, count, _ in CHAINS for i in range(count + 1)]
        points = {}
        for name in names:
            value = setup["landmarks"].get(name)
            if not isinstance(value, list) or len(value) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 4 for v in value):
                raise ValueError(f"Missing or invalid {name}. Fit the hand template before rigging.")
            points[name] = conversion @ Vector(value)
        normal = points[prefix + "PalmNormal"] - points[prefix + "Hand"]
        forward = points[prefix + "HandEnd"] - points[prefix + "Hand"]
        if normal.length < 0.005 or forward.length < 0.015 or abs(normal.normalized().dot(forward.normalized())) > 0.9:
            raise ValueError(f"{prefix}PalmNormal must point out of the back of the hand, not along its fingers.")
        for chain, _, count, _ in CHAINS:
            for i in range(count):
                direction = points[f"{prefix}{chain}{i + 2}"] - points[f"{prefix}{chain}{i + 1}"]
                if direction.length < 0.003 or abs(direction.normalized().dot(normal.normalized())) > 0.95:
                    raise ValueError(f"{prefix}{chain}{i + 1}: separate hand points by 3mm and keep the palm normal across the finger, not along it.")
        result[side] = {"prefix": prefix, "config": config, "points": points, "normal": normal.normalized()}
    return result


def build_hand_bones(data, hands):
    for hand in hands.values():
        prefix, points = hand["prefix"], hand["points"]
        wrist = data.edit_bones[prefix + "Hand"]
        wrist.tail = (points[prefix + "Index1"] + points[prefix + "Fingers1"]) * 0.5
        if wrist.length < 0.003:
            raise ValueError(f"{prefix} finger bases must be beyond the wrist.")
        wrist.align_roll(hand["normal"])
        for chain, _, count, _ in CHAINS:
            for i in range(count):
                name = f"{prefix}{chain}{i + 1}"
                bone = data.edit_bones.new(name)
                bone.head, bone.tail = points[name], points[f"{prefix}{chain}{i + 2}"]
                bone.parent = data.edit_bones[prefix + "Hand" if i == 0 else f"{prefix}{chain}{i}"]
                bone.use_connect = i > 0
                bone.align_roll(hand["normal"])
                # Solve the body first. Finger regions must not steal body or neighbouring digit weights.
                bone.use_deform = False


def segment_distance(point, head, tail):
    direction = tail - head
    fraction = max(0.0, min(1.0, (point - head).dot(direction) / direction.length_squared))
    return (point - head - direction * fraction).length, fraction


def skin_hands(rig, objects, hands):
    reports = {}
    for side, hand in hands.items():
        prefix, points = hand["prefix"], hand["points"]
        chains = []
        for chain, control, count, _ in CHAINS:
            names = [f"{prefix}{chain}{i + 1}" for i in range(count)]
            segments = [(points[name], points[f"{prefix}{chain}{i + 2}"]) for i, name in enumerate(names)]
            chains.append((chain, names, segments, hand["config"][control + "Radius"]))
            for name in names:
                rig.data.bones[name].use_deform = True
        counts = {chain: 0 for chain, _, _, _ in chains}
        for obj in objects:
            body = {g.index: g for g in obj.vertex_groups if g.name in (prefix + "Hand", prefix + "ForeArm")}
            targets = {name: obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
                       for _, names, _, _ in chains for name in names}
            for vertex in obj.data.vertices:
                source = [(body[g.group], g.weight) for g in vertex.groups if g.group in body]
                amount = sum(weight for _, weight in source)
                if amount < 0.5:
                    continue
                point = obj.matrix_world @ vertex.co
                candidates = []
                for chain, names, segments, radius in chains:
                    closest = min(((*segment_distance(point, head, tail), i) for i, (head, tail) in enumerate(segments)),
                                  key=lambda item: item[0])
                    distance, fraction, index = closest
                    if distance <= radius:
                        candidates.append((distance / radius, chain, names, fraction, index))
                if not candidates:
                    continue
                _, chain, names, fraction, index = min(candidates, key=lambda item: item[0])
                head, tail = next(segments[index] for label, _, segments, _ in chains if label == chain)
                # Before the knuckle the palm keeps its original weights.
                along = (point - head).dot(tail - head) / (tail - head).length_squared
                blend = min(1.0, max(0.0, along * 2)) if index == 0 else 1.0
                if blend <= 1e-6:
                    continue
                influence = {names[index]: 1.0}
                neighbour = index - 1 if fraction < 0.5 else index + 1
                if 0 <= neighbour < len(names):
                    weight = abs(fraction - 0.5)
                    influence = {names[index]: 1 - weight, names[neighbour]: weight}
                for group, weight in source:
                    group.add([vertex.index], weight * (1 - blend), "REPLACE")
                for name, weight in influence.items():
                    targets[name].add([vertex.index], amount * blend * weight, "REPLACE")
                counts[chain] += 1
        for chain, count in counts.items():
            if count < 3:
                raise ValueError(f"{prefix} {chain} has fewer than three influenced vertices. Fit its points inside the digit and adjust its influence radius, or choose Wrist only. Missing/fused digits cannot be reconstructed.")
        reports[side] = counts
    return reports


def validate_fingers(fingers):
    if not isinstance(fingers, dict) or set(fingers) != {"left", "right"}:
        raise ValueError("Finger poses require left and right controls.")
    for side in ("left", "right"):
        values = fingers[side]
        if not isinstance(values, dict) or set(values) != {"thumb", "index", "fingers", "opposition"} or any(
                type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in values.values()):
            raise ValueError("Finger curl and opposition must be finite values between zero and one.")
    return fingers


def sample_hand_pose(pose, time):
    if pose is None or pose.get("version") == 1:
        return pose
    validate_fingers(pose.get("fingers"))
    keys = pose.get("keyframes")
    if keys is None:
        return pose
    if not isinstance(keys, list) or not 2 <= len(keys) <= 16:
        raise ValueError("Hand animation requires 2 to 16 ordered keys.")
    previous = -1
    for key in keys:
        if not isinstance(key, dict) or set(key) != {"time", "fingers"} or type(key["time"]) not in (int, float) or not math.isfinite(key["time"]) or not previous < key["time"] <= 1:
            raise ValueError("Hand key times must be finite, ordered and unique.")
        previous = key["time"]
        validate_fingers(key["fingers"])
    if keys[0]["time"] != 0 or keys[-1]["time"] != 1:
        raise ValueError("Hand keys must include times zero and one.")
    index = next(i for i, key in enumerate(keys) if key["time"] >= time)
    fingers = deepcopy(keys[0]["fingers"])
    if index:
        first, last = keys[index - 1], keys[index]
        fraction = (time - first["time"]) / (last["time"] - first["time"])
        for side in ("left", "right"):
            for name in fingers[side]:
                fingers[side][name] = first["fingers"][side][name] + (last["fingers"][side][name] - first["fingers"][side][name]) * fraction
    return {"version": 2, "detail": "basic", "left": pose["left"], "right": pose["right"], "fingers": fingers}


def validate_timeline(timeline, frames):
    if not isinstance(timeline, list) or not 1 <= len(timeline) <= 64:
        raise ValueError("Hand timeline must contain 1 to 64 spans.")
    end = 0
    for span in timeline:
        if not isinstance(span, dict) or set(span) != {"start", "end", "pose"} or type(span["start"]) is not int or type(span["end"]) is not int or span["start"] != end or not span["start"] < span["end"] < frames:
            raise ValueError("Hand timeline spans must exactly cover the animation without gaps.")
        end = span["end"]
    if end != frames - 1:
        raise ValueError("Hand timeline frame count differs from the animation.")
    return timeline


def finger_corrections(pose, rig):
    if pose is None or pose.get("version") == 1:
        return {}
    fingers = validate_fingers(pose.get("fingers"))
    result = {}
    for side in ("left", "right"):
        values = fingers[side]
        for chain, control, count, degrees in CHAINS:
            for i in range(count):
                name = f"{side.capitalize()}{chain}{i + 1}"
                if name not in rig.pose.bones:
                    if any(values.values()):
                        raise ValueError(f"{name} is missing. Build the Basic three-chain hand rig before posing fingers.")
                    continue
                rotation = Quaternion((1, 0, 0), -values[control] * math.radians(degrees[i]))
                if chain == "Thumb" and i == 0:
                    rotation = Quaternion((0, 0, 1), (1 if side == "left" else -1) * values["opposition"] * math.radians(60)) @ rotation
                result[name] = rotation
    return result
