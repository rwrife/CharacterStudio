"""Create a procedural native hand rig for the visible desktop regression."""
import json
import shutil
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import character
from test_hand_rig_blender import BlenderHandTests

output = Path(sys.argv[sys.argv.index("--") + 1])
output.mkdir(parents=True, exist_ok=True)
fixture = BlenderHandTests()
try:
    fixture.setUp()
    fixture.rig()
    for name in ("rigged.blend", "rigged.glb"):
        shutil.copyfile(fixture.root / "rig" / name, output / name)
    shutil.copyfile(fixture.source, output / "character.blend")
    (output / "setup.json").write_text(json.dumps(fixture.setup))
    bpy.ops.wm.open_mainfile(filepath=str(fixture.source))
    character.export_glb(output / "preview.glb", False)
finally:
    fixture.doCleanups()
