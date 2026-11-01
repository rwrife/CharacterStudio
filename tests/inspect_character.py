import json
import sys
from pathlib import Path
import bpy

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))
import character

source = Path(sys.argv[sys.argv.index("--") + 1])
output = root / "artifacts" / "bruiser-import"
character.import_character({"input": str(source), "output": str(output)})
objects = character.meshes()
verts = [o.matrix_world @ v.co for o in objects for v in o.data.vertices]
print("MESH_OBJECTS:", [(o.name, len(o.data.vertices)) for o in objects])
for z in [0.1, 0.2, 0.5, 0.8, 1.0, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9]:
    band = [v for v in verts if abs(v.z - z) < 0.025]
    if band:
        print(f"SLICE {z:.2f}: x [{min(v.x for v in band):.3f}, {max(v.x for v in band):.3f}], y [{min(v.y for v in band):.3f}, {max(v.y for v in band):.3f}] ({len(band)} vertices)")

# Orthographic silhouettes let us inspect dense FBX geometry without a GPU render.
for plane, axes in [("front", (0, 2)), ("side", (1, 2))]:
    circles = "".join(f'<circle cx="{250 + v[axes[0]] * 210:.1f}" cy="{465 - v[axes[1]] * 210:.1f}" r=".7"/>' for v in verts[::max(1, len(verts) // 50000)])
    (output / f"{plane}.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#151919"/><g fill="#b0d9cb">{circles}</g></svg>', encoding="utf-8")
