# KimodoStudio

**An AI-assisted video game character creation studio.** The goal is to help game developers turn character assets into animated, reusable characters through a local workflow for preparation, rigging, natural-language motion generation, visual animation graphs, and export.

The current implementation focuses on **existing humanoid FBX assets and AI-generated body motion**, not text-to-3D mesh generation. Artists retain control over rig fitting, motion instructions, and the final exported character.

Local Windows ARM64 desktop app for importing an unrigged humanoid FBX, fitting and skinning a body rig, generating Kimodo motion through ComfyUI, and exporting the **animated character mesh**.

## Screenshots

### Character lab and guided rig fitting

![Character lab showing an imported humanoid FBX, joint landmarks, and rig-fitting controls](docs/screenshots/character-lab.png)

Import a character, inspect its mesh, and adjust humanoid joint landmarks before building the skin and rig.

### Visual animation graphs

![Animation graph showing a crouch state branching into jump and lie-down actions](docs/screenshots/animation-graph.png)

Arrange reusable states and actions, connect transitions, and edit motion instructions and generation settings. These are screenshots of the existing desktop app; they do not demonstrate successful AI inference or establish generated-motion quality. The sample character asset is not included in this repository.

## Launch

Open `release\KimodoStudio-win32-arm64\KimodoStudio.exe`, or run `Start-KimodoStudio.ps1`.

Keep the portable folder together; its executable depends on the included runtime files. Native Blender and the Python backend scripts are deliberately unpacked rather than placed inside an Electron archive.

For development:

```powershell
npm install
npm run setup:blender
npm run dev
```

`npm run build` builds the app; `npm start` launches that build. `npm run package` creates the portable ARM64 application, including the isolated Blender runtime.

## Character workflow

1. **Import FBX.** A copy of the original is preserved. Geometry/materials are converted locally with Blender; embedded textures are kept. Working copies are normalized to two meters in height. The camera starts facing the character. T-pose orientation is estimated from shoulders and feet; review the facing direction when FBX axes differ.
2. **Fit & skin.** Full-body, upright T-poses are the expected input; a clear A-pose can also be fitted. Adjust orientation and joint positions in both front and side views. Click a landmark and drag its axis handles, or edit XYZ coordinates. Symmetric fitting is enabled by default. Save the fit, then **Build skin + rig**.
3. **Connect local ComfyUI.** Open Backend connections. Default backend folder is `%LOCALAPPDATA%\ComfyUI`, API `http://127.0.0.1:8189`. The app can start this backend using its existing venv; it does not replace PyTorch or Transformers. For a ComfyUI already running elsewhere, select its actual port and output directory.
4. **Describe motion** and generate. Periods separate motion segments; duration applies to each segment. Jobs display progress and persist across restarts. Cancel targets only the app's prompt, never the global ComfyUI queue.
5. **Preview and export.** Completed clips support play/pause, scrubbing, orbit, zoom, and wireframe. Download animated GLB, animated FBX, or editable Blender scene. BVH/NPZ are separately labeled **motion-only** data. Partial/failed jobs never expose completed-character downloads.

## Local Llama, not remote inference

Kimodo uses a trained **Llama 3 8B + LLM2Vec** text encoder with its MNTP and supervised adapters. Inference happens on this computer. Hugging Face supplies the initial model downloads; it is not an inference endpoint.

Studio starts ComfyUI with `TEXT_ENCODER_MODE=local` and `TEXT_ENCODER=llm2vec`. If you start ComfyUI separately, set those variables in its process as well. The app does not change an already running backend's configuration.

### First-time model access

Open the top-right **Backend connections** button (it may display **Setup needs attention**), then **Model access & local setup**. The guide is always available, and expands automatically when the Llama check is blocked.

1. Sign in at <https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct>. On **Model card**, find the license panel headed **You need to agree to share your Hugging Face information to access this model**. Click the wide **Expand to review and access** button beneath the license text. Review the terms/data-sharing notice, fill out the form, and submit only if you agree. Neither **Use this model** nor a paid inference provider is needed. Use this exact model, not the suggested Llama 3.1 upgrade.
2. Wait until the model page shows access is granted. Browser login and a pending request are not approval. The model owner handles approval.
3. Sign in locally with the same account using the existing ComfyUI environment. The in-app guide displays the exact PowerShell command for your **saved** backend folder; with the default path:

   ```powershell
   & "$env:LOCALAPPDATA\ComfyUI\venv\Scripts\hf.exe" auth login
   & "$env:LOCALAPPDATA\ComfyUI\venv\Scripts\hf.exe" auth whoami
   ```

   Choose browser sign-in if offered. If prompted for a token, create a **read** token at <https://huggingface.co/settings/tokens>; fine-grained tokens must permit reading the approved gated model. Enter it only in the CLI's secure prompt, not in command arguments, Studio, or chat. Studio does not collect credentials. Already signed in correctly? Skip login. To switch accounts, append `--force` to `auth login`. Do not reinstall/downgrade ComfyUI packages just to sign in.
4. Refresh the app's readiness checks, start local ComfyUI if needed, and generate. The first run downloads many GB of encoder weights/adapters; allow enough disk space and download time. Inference remains local.

**If approved but blocked:** verify the exact model, CLI account, and gated-model token permissions. `HF_TOKEN` in the launching environment overrides a saved login; check its configuration without exposing its value. Restart an already-running ComfyUI after changing authentication. Readiness distinguishes absent credentials, rejected login, denied download permissions, and network/service failures.

**Current delivery limitation:** the last full-pipeline attempt was blocked by the model-download access check. No real text-generated clip has been claimed. Refresh readiness to check your current authorization.

### Alternatives

An already-authorized installation in the Hugging Face cache used by ComfyUI can reuse its weights without a new access request. It also needs the tokenizer, configuration, and both LLM2Vec adapters. The app does not currently offer an arbitrary local-model-folder selector, and cached base weights alone are not a guarantee of a complete offline installation.

vLLM is **not a drop-in replacement**: a generic chat/embedding model does not reproduce the checkpoint's trained LLM2Vec conditioning, and an inference server does not eliminate the need for authorized weights. [Official vLLM requires Linux rather than native Windows](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/). Studio instead reuses the working native ARM64 PyTorch/CUDA environment.

There is no supported ungated encoder replacement for this checkpoint. Avoiding Llama entirely means integrating and validating a different motion engine, not changing a model name. While access is pending, FBX import, rig fitting/skinning, and saving configurations remain available. See [Kimodo's official installation requirements](https://research.nvidia.com/labs/sil/projects/kimodo/docs/getting_started/installation.html) and the [LLM2Vec adapter's base-model declaration](https://huggingface.co/McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp/blob/main/adapter_config.json).

## Visual animation graphs

Open **Motion library & batches**, then choose **Fighting graph template**. It contains a fighting idle state, a low crouch state, and **one shared Right hook action** with both `idle -> punch` and `idle -> crouch -> punch` connections. Select Punch and use **Incoming context** to inspect the two paths and their inherited stances.

Drag nodes to arrange the graph; drag an output dot to an input dot to connect nodes. Select a node to edit its instructions, duration, seed and state/action type. Select a connection to edit its transition duration. Mark the entry nodes with **Start graph here**. Positions and connections are saved with the configuration.

- **State nodes** describe a sustained posture, such as a fighting idle or crouch. They are generated in that posture and aligned to the preceding character's horizontal position and heading, without flattening the destination's root height.
- **Action nodes** are reusable instructions, such as "Throw a right hook punch." Each incoming path receives its own generated variant, conditioned on the actual previous endpoint and guided by the inherited stance. A standing punch is not reused as a crouched punch. Explicit instructions can change stance; the optional **Outgoing stance** clarifies the resulting posture for later nodes. The actual incoming pose takes precedence over textual posture guidance. There is no separate reasoning model inferring semantic postconditions; review model compliance and set an outgoing override when a change should propagate.
- **Connections** create separately generated transitions constrained at both endpoints. Zero seconds requires a direct pose match instead. Node clips, incoming transitions and complete paths have independent GLB/FBX/Blender exports and previews. Each part uses the same path-relative root origin.
- **State loops** use a second generation pass constrained to return to the initial pose. Endpoint root and body rotations are checked, but this does not guarantee velocity continuity, foot-contact quality or a visually seamless loop. Turning off the checkbox produces an ordinary non-looping state clip.
- **Pose continuity** is checked at every join: maximum 2cm root error and 5 degrees body-joint rotation error. Incorrect frame counts, mismatched endpoints or failed exports block the result instead of silently publishing disconnected motion. Duplicate boundary frames are removed from assembled paths. A transition into an action already starting at the previous endpoint may be a short hold.
- **Cycles** are finite: each path includes its first revisited node once, then stops. This exports a cycle traversal, not an endlessly growing queue or an in-engine state machine. Limits are 32 nodes, 64 connections, 64 path-specific variants per character and 60 seconds per path including transitions. Unreachable nodes must be connected or marked as starts.

Graph instructions are treated as one clip per node; punctuation does not create extra segments. Older configurations migrate without changing their prompts, seeds or period-separated segment durations, using direct-pose connections. Selecting a node type explicitly opts a legacy node into the new single-clip behavior.

## Repeatability and collections

Open **Motion library & batches**, or **Save this configuration** beside the current prompt.

- **Configurations** save exact instructions, duration, seed, denoising steps, in-place mode, a humanoid landmark fit, and a named motion graph. Save as copy for a variation, or import/export versioned JSON. Apply a prompt/settings preset to another FBX; optionally reuse its rig landmarks while preserving the new FBX's detected orientation.
- **Branches** can also start directly from a completed take in Character lab. Studio exports the actual parent's endpoint as a Kimodo `FullBodyConstraintSet` at child frame zero, including root location/height and joint rotations, and validates the join.
- **Collections** accept multiple FBX imports. Select up to 32 characters. Jobs run sequentially to avoid competing GPU allocations. Existing rigs are preserved. The optional saved-fit setting rigs unrigged characters; this assumes similar humanoid proportions and still requires visual review.
- **Identical motion** generates once per **path context**, including its transitions, and reuses the exact source motion across target characters, retargeting it to each rig. It never substitutes a different incoming path. **Variation** instead applies a deterministic seed offset (1, 100, or 1000) per character. The seed is `node seed + character index * offset`, modulo 2^32; transitions use the next seed. Seed variation changes the sampled performance, not a calibrated motion-intensity value.
- **Batch snapshots** preserve their configuration, target order, and effective seeds even if you edit the original preset. *Run same batch again* uses that immutable snapshot. New generations with the same seed are intended to be repeatable, but bitwise reproducibility across different model/software/hardware versions is not promised.
- **Save outputs** writes completed character files into a new batch folder, one character/motion directory each, with configuration and per-job manifests. Failed/blocked items are identified in the batch manifest and do not gain fake output files. Cancellation retains completed results; restart marks interrupted work blocked until explicitly rerun.

The branch constraint serialization, conversion to the real SOMA30 model skeleton, seam validation, and branch assembly are exercised without downloads. The graph integration harness uses clearly labeled analytic standing/crouching poses, loops and transitions on real Bruiser meshes. This verifies context isolation and real skinned exports, **not learned motion quality** while Llama weights remain gated.

## Backend and limitations

- Official **Blender 4.5.15 LTS ARM64** portable distribution, checksum-verified by `scripts\setup-blender.ps1`. Isolated under `.tools`; no CUDA auto-rigging packages are installed into ComfyUI.
- A real 22-bone humanoid body rig, Blender bone-heat skinning, maximum four normalized influences per vertex, and required body-bone/vertex-coverage checks. This is **guided rig fitting**, not an unvalidated universal AI auto-rigger. Fingers/faces, cloth, quadrupeds, and arbitrary poses are outside this version.
- SOMA-77 global rotations are converted from Y-up into Blender coordinates, corrected for the fitted target rest pose, and baked onto the skinned character. Root trajectory is scaled to the character; optional in-place mode removes horizontal root displacement. Fine finger motion is not transferred to the body-only rig.
- FBX export uses Blender, **not** the unavailable ARM64 Autodesk Python SDK.
- Foot contact cleanup is not installed. Foot sliding, extreme joint bends, or imperfect automatic weights can require manual cleanup. Playback looping is not a promise of a seamless looping animation.
- Skinning errors are actionable failures, not silent proximity-weight fallbacks. Repair intersecting/non-manifold meshes and refit joints if Blender cannot assign complete weights.
- The app's ComfyUI endpoint is restricted to loopback. No character upload service exists. Downloaded model files remain local. ComfyUI/custom nodes are trusted local software; separately started services remain responsible for their own configuration.

## Data and reproducibility

Workspace data lives in `%APPDATA%\KimodoStudio`: `studio.json`, original FBX copies, packed working scenes, rigs, job logs, and completed outputs. Use **Open workspace files** in the app. Rig edits invalidate the old rig until rebuilt; old completed animation jobs remain immutable. On restart, interrupted jobs are marked failed rather than complete. `comfy-server.log` contains logs from the app-owned backend.

The actual supplied `Bruiser_base.fbx` has 198,581 vertices and no existing rig. The body backend is tested against this file, including native skinning, real vertex deformation, and GLB/FBX reimport. The fitted sample setup is in `tests\fixtures\bruiser-setup.json`.

**Analytic motion fixtures are tests, not generated clips.** `artifacts\bruiser-analytic-test` contains a clearly labeled analytic wave used to verify retargeting without gated weights. It is never inserted as a successful ComfyUI job. Full text-generated character validation remains pending model-download access.

```powershell
npm test
npm run typecheck
npm run test:desktop
node --import tsx scripts\validate-character.ts
node scripts\animation-smoke.mjs
node scripts\library-smoke.mjs
node scripts\graph-smoke.mjs
node scripts\graph-smoke.mjs --packaged
node scripts\packaged-smoke.mjs
node scripts\model-setup-smoke.mjs
& "$env:LOCALAPPDATA\ComfyUI\venv\Scripts\python.exe" tests\test_preflight.py
node --import tsx scripts\batch-integration.ts
node --import tsx scripts\graph-integration.ts
& "$env:LOCALAPPDATA\ComfyUI\venv\Scripts\python.exe" tests\test_branch.py "$env:LOCALAPPDATA\ComfyUI\custom_nodes\ComfyUI-Kimodo\kimodo"
node --import tsx scripts\check-local-backends.ts
```

The FBX integration scripts expect the user-supplied copy at `artifacts\Bruiser_base.fbx`; no character asset is fetched from third parties. Blender's redistribution/license files remain bundled with its runtime.
