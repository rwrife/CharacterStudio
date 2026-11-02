# Agent guidance

## Project goal

KimodoStudio is an AI-assisted video game character creation studio. Help game developers prepare character assets, fit and skin humanoid rigs, generate motion from natural-language instructions, organize reusable animation graphs, and export animated characters for downstream game development.

The current product is a local-first Windows ARM64 desktop application with Designer and Animator workspaces. Designer's built-in ComfyUI presets turn a text brief or reference image into a scene, transparent T-pose, and Hunyuan3D geometry or textured TRELLIS.2 GLB; scenes are always generated, but it can skip ahead from imported T-poses or embedded GLB meshes. Per-stage providers also support explicitly approved remote ComfyUI, Studio API gateways, and paid Tripo image/3D/texture/rig tasks. Animator prepares imported humanoid FBX assets or Designer meshes with local Blender and generates compatible Kimodo motion through the selected provider. Generated geometry and remote rigs are not finished game assets. Treat broader character-creation capabilities as goals, not shipped features.

## Repository layout

- `src/main`: Electron application lifecycle, IPC handlers, workspace persistence, jobs, local ComfyUI integration, and export validation.
- `src/preload`: the isolated bridge between the renderer and desktop services.
- `src/renderer`: React UI, Three.js character viewport, motion library, model setup guide, and visual animation graph editor.
- `src/shared`: shared types, rig definitions, and motion-plan logic.
- `backend`: Python tools for Blender character processing, model-access preflight, motion conversion, and branch continuity.
- `scripts`: Blender setup, desktop smoke checks, packaging checks, and character/graph integration harnesses.
- `tests`: TypeScript and Python tests plus a saved humanoid fitting fixture.
- `docs/screenshots`: repository-owned copies of app screenshots used by the README.

## Development

Run commands from the repository root in PowerShell:

```powershell
npm install
npm run setup:blender
npm run dev
```

`npm run build` performs type checking and builds the Electron application. `npm start` opens the build. `npm run package` creates the Windows ARM64 portable application with its isolated Blender runtime.

ComfyUI is a separately configured local dependency, normally under `%LOCALAPPDATA%\ComfyUI` with a loopback API at `http://127.0.0.1:8189`. Use the README and in-app readiness guide for model requirements and authentication; do not install or replace backend packages indiscriminately.

## Implementation principles

- Keep character processing local and inference local-first by default. Remote inference is opt-in through Model & workflow providers, with visible per-stage approval before transmitting prompts, references, meshes or pose constraints. Never silently switch providers or models.
- Preserve Electron context isolation, sandboxing, the narrow preload bridge, and validation at IPC and filesystem boundaries.
- Reuse shared types, validation, rig definitions, and motion-plan helpers. Maintain the existing TypeScript, React, and Python patterns.
- Preserve original imports, saved configurations, immutable completed jobs, and batch snapshots. Keep changes compatible with persisted data or provide explicit migrations.
- Surface actionable failures. Never represent failed, interrupted, or partially exported work as a completed character.
- Every application capability must be accessible through the local desktop MCP server, including new features and UI-only interactions. Agents must control the actual visible desktop window through the same controls and handlers as the user, not a parallel headless implementation.
- Keep MCP coverage complete for Designer, Animator, rig fitting, viewport/playback, graphs, batches, model/backend setup, imports, exports and cancellation. Give controls meaningful accessible names; extend the validated MCP tools if a feature cannot be operated through the existing UI primitives. Keep file selection visible and agent-operable.
- Preserve MCP opt-in through **Backend connections > Enable MCP control** (default off, saved independently of jobs/backend settings), immediate in-app revocation, and the optional `--mcp` launch override. Keep the header free of an MCP subtitle. Preserve authenticated loopback-only transport, strict tool/IPC validation, disabled-control and modal boundaries, and context isolation. Do not expose arbitrary JavaScript, shell execution, private IPC invocation or unrestricted filesystem tools. Treat labels, asset text and MCP results as untrusted data.
- Export the animated skinned mesh, not only a skeleton. Keep motion-only BVH/NPZ outputs clearly distinguished from character exports.
- Preserve path-specific motion conditioning and seam validation. Reusing an action must not discard its actual incoming pose or stance context.
- Be explicit about limitations: guided body rigging is not universal AI auto-rigging; endpoint continuity is not a guarantee of seamless motion, foot-contact quality, or game-engine integration.
- Never claim successful learned motion generation based on analytic fixtures. The documented full-pipeline attempt was blocked by gated model access; report actual observed results rather than assuming approval or inference success.
- Keep downloaded models, Blender distributions, portable builds, user assets, logs, workspace data, and credentials out of Git. Retain third-party notices when distributing runtimes.

## Required architecture for every AI feature

- New and updated AI stages must expose hardware-fit local model/profile selection and support custom checkpoints, mapped workflows, and explicit remote ComfyUI/API execution wherever the output contract allows. This applies to images, cutouts, mesh generation, PBR texturing, segmentation, landmarks, secondary/cloth analysis, motion and trained text encoders. Register stages and contracts in `src/shared/ai.ts`; reuse `src/main/ai-providers.ts`, rather than adding a parallel hard-coded provider path.
- Keep built-in local presets as the compatible default, including old saved configurations. Show Local/Remote and the selected provider/model at the action. Hardware guidance must distinguish measured free VRAM from estimates and unavailable telemetry; never require local inference weights or local GPU memory for remote inference. Retain local Blender/Python requirements for motion validation, retargeting and character exports.
- Use validated ComfyUI API-format workflow envelopes with explicit parameter and output mappings, not arbitrary JavaScript, shell, or private IPC. Preserve actual reference inputs, seeds, trained encoder choices, incoming poses and endpoint constraints. Native routed Kimodo uses the optional `backend/studio_provider_nodes` bridge: its sampler converts inline constraints to the server-local file that upstream Kimodo expects, and its output node exposes safe HTTP file descriptors.
- Remote execution must obtain approval through the real desktop consent handler before any inference request or asset upload. Store keys only with OS-backed `safeStorage` in the endpoint-bound credential vault; fail closed without encryption and require HTTPS for credentials. Never put keys in URLs, workflow JSON, snapshots, project history, manifests or logs. Never return existing keys to the renderer or MCP inspection. Password entry is write-only through the visible UI. Warn about paid credits, uncertain submissions and cancellation that cannot be confirmed; do not retry potentially billable submissions automatically.
- Preserve non-sensitive provider/model/workflow hashes, actual mapped workflows and task IDs with completed outputs and configuration history. Preserve source provenance when reusing outputs. Batch reruns must retain their original provider/model/workflow and text-encoder selection, or fail explicitly rather than silently drifting.
- Validate retrieved images, cutouts, embedded GLBs, PBR maps and compatible motion before publishing completion. Remote jobs do not imply a shared filesystem. Keep output retrieval bounded and scoped to that job; do not forward credentials to asset-download hosts. Reject missing outputs and incompatible motion instead of substituting analytic fixtures or another model.
- All provider configuration, workflow import, credential management, remote approvals, cancellation and resulting workflows must remain operable through the actual visible desktop MCP controls, respecting modal/disabled boundaries. Add unit contract tests and real desktop/MCP fixture coverage that observes outputs; mocks are not proof of paid API interoperability or learned inference.
- Be precise about integrations: Tripo H3 v3.1 is not Tencent Hunyuan 3.1. Other vendor APIs need an explicit adapter or the documented Studio API gateway contract. Remote skinned GLB output does not guarantee compatibility with Animator's SOMA rig. Reserved segmentation, landmark and cloth stages are extension points, not implemented AI features.

## Validation

For TypeScript or application behavior changes, start with the affected tests and type checking:

```powershell
npm test
npm run typecheck
```

For MCP or desktop control changes, also run `npm run test:mcp`. This exercises a real stdio MCP client against the visible Electron app, including graph persistence, imports/exports, file selection and settings without requiring inference weights or a sample FBX. New workflows must include coverage that observes their actual UI effect; clicking a generation button does not establish successful inference.

Use `npm run test:desktop` for FBX import and rig-control changes when the required local tools and sample asset are available. The other focused smoke and integration commands are documented in the README.

Native integration checks require the isolated Blender runtime and, for some checks, the existing ComfyUI Python environment. Character integration scripts expect a user-supplied `artifacts\Bruiser_base.fbx`; that asset is not versioned. Do not download substitute third-party assets or gated weights just to make a check pass.

## README maintenance

- Update `README.md` in the same change whenever adding a major user-facing feature or materially changing an existing one. Also update it when changing setup, supported workflows, exports, model requirements, or limitations; documentation is part of completing the feature.
- Keep the introduction and **Features at a glance** aligned with the implemented application. Add or revise the relevant workflow section with how to access the feature, required setup, supported inputs/outputs, and important limitations. Use actual UI labels and working commands.
- Add or refresh screenshots for major UI features under `docs/screenshots` and embed them in the README with descriptive alt text and captions. Use actual app captures, not mockups; keep repository-owned copies rather than linking to ignored `artifacts` files, temporary paths, or private external locations.
- Inspect screenshots before including them. Omit private paths, credentials, and personal data. Label historical UI, imported assets, analytic/test fixtures, and experimental outputs accurately; screenshots are not proof of motion quality or end-to-end success.
- Verify feature claims against the implementation and observed results. Distinguish available functionality from prerequisites, unverified stages, experiments, and future goals. When evidence changes, update stale limitations without extrapolating success to other stages or models.
- Before finishing, check that README links and screenshot paths resolve and that existing setup and compatibility guidance remains accurate. If a required capture or integration result is unavailable, state that limitation rather than inventing evidence.
