# Agent guidance

## Project goal

KimodoStudio is an AI-assisted video game character creation studio. Help game developers prepare character assets, fit and skin humanoid rigs, generate motion from natural-language instructions, organize reusable animation graphs, and export animated characters for downstream game development.

The current product is a local Windows ARM64 desktop application built around imported humanoid FBX assets, Blender, and Kimodo motion generation through ComfyUI. It does not currently generate character meshes from text. Treat broader character-creation capabilities as goals, not shipped features.

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

- Keep character processing and inference local. Do not add character uploads, remote inference, or credential collection without an explicit product requirement.
- Preserve Electron context isolation, sandboxing, the narrow preload bridge, and validation at IPC and filesystem boundaries.
- Reuse shared types, validation, rig definitions, and motion-plan helpers. Maintain the existing TypeScript, React, and Python patterns.
- Preserve original imports, saved configurations, immutable completed jobs, and batch snapshots. Keep changes compatible with persisted data or provide explicit migrations.
- Surface actionable failures. Never represent failed, interrupted, or partially exported work as a completed character.
- Export the animated skinned mesh, not only a skeleton. Keep motion-only BVH/NPZ outputs clearly distinguished from character exports.
- Preserve path-specific motion conditioning and seam validation. Reusing an action must not discard its actual incoming pose or stance context.
- Be explicit about limitations: guided body rigging is not universal AI auto-rigging; endpoint continuity is not a guarantee of seamless motion, foot-contact quality, or game-engine integration.
- Never claim successful learned motion generation based on analytic fixtures. The documented full-pipeline attempt was blocked by gated model access; report actual observed results rather than assuming approval or inference success.
- Keep downloaded models, Blender distributions, portable builds, user assets, logs, workspace data, and credentials out of Git. Retain third-party notices when distributing runtimes.

## Validation

For TypeScript or application behavior changes, start with the affected tests and type checking:

```powershell
npm test
npm run typecheck
```

Use `npm run test:desktop` for FBX import and rig-control changes when the required local tools and sample asset are available. The other focused smoke and integration commands are documented in the README.

Native integration checks require the isolated Blender runtime and, for some checks, the existing ComfyUI Python environment. Character integration scripts expect a user-supplied `artifacts\Bruiser_base.fbx`; that asset is not versioned. Do not download substitute third-party assets or gated weights just to make a check pass.

Update the README when changing setup, supported workflows, exports, or limitations. Keep screenshots representative of the actual UI, omit private paths and credentials, and label test-only motion honestly.
