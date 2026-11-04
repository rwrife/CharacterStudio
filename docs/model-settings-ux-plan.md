# Shared model settings UX

## Goal and scope

Give Character Studio and Sound Studio the same simple model-settings experience: a sensible local setup for each task, the user's actual computer specifications, and advanced choices only when requested. Implement this in both independent repositories and submit one pull request per repository. Keep each application's existing theme and inference implementations; sharing the UX contract does not require a new package or monorepo.

The existing Character Studio README establishes a **32 GB system RAM minimum planning target**, with **64 GB and CUDA preferred**. Apply that planning guidance consistently, but do not claim that RAM alone establishes model compatibility. GPU memory, architecture, installed nodes, weights, and model-specific restrictions still apply. Existing documented budgets are estimates, not measured performance guarantees.

## Common screen contract

1. **Model Settings** remains available from the header and the current action's compact Local/Remote + model summary. Opening or closing it never changes the active workspace, asset, step, prompt, or playback state.
2. **Your computer** is visible without expanding Advanced. Show operating system/architecture, CPU, total and available system RAM, and backend-reported GPU name and total/free GPU memory when available. Clearly separate local OS measurements from ComfyUI telemetry. Include **Refresh** and honest disconnected, unsupported, or unknown states. Never infer CUDA support from a vendor name or substitute system RAM for VRAM.
3. Keep the relevant **task** selected when entering from an action. Show one current-model card with a friendly name, a concise purpose, Local/Remote execution, readiness, and compact hardware requirements. Distinguish the recommended preset from a user's saved custom choice. Provide an explicit, task-scoped **Use recommended setup** action when appropriate; do not silently overwrite existing choices.
4. Keep missing-model/setup actions, errors, downloads and cancellation, unsaved-setting notices, and remote-execution warnings outside Advanced. Downloads remain explicitly approved. No generation, model download, key submission, or provider change happens simply by viewing settings.
5. **Advanced** starts collapsed each time the panel opens, including for previously customized configurations. It contains alternative models, installed-file selectors, custom workflows, provider endpoints, and credentials. Show concise requirement labels next to each alternative before selection, such as **8 GB free GPU memory recommended**, **CPU**, **Remote - local GPU not required**, or **Requirements depend on your workflow**. Only use CUDA-required or RAM-specific claims supported by the actual integration.
6. Preserve each application's save behavior and explain it: Sound Studio's settings persist immediately; Character Studio retains explicit Save settings and unsaved-change protection. Maintain keyboard operation, modal focus containment/restoration, expanded states, and Character Studio's visible desktop MCP controls.

## Small recommended model set

| Application/task | Starting recommendation | Advanced choices and constraints |
|---|---|---|
| Sound: effects | Stable Audio Open 1.0 plus its required T5 encoder | Also usable for short instrumental clips, avoiding another model when its limits are acceptable; approximately 6 GB GPU-memory guidance |
| Sound: full music/songs | ACE-Step 1.5 Turbo | One music-specific model retains lyrics, key, tempo and longer tracks; approximately 12 GB GPU-memory guidance. ACE-Step v1, custom workflows and paid partners remain advanced |
| Character: scene | Existing SD 1.5 / DreamShaper setup | SDXL and custom/remote alternatives remain advanced; existing 4/8 GB free-GPU-memory budgets |
| Character: edit and cutout | FLUX.2 klein 4B components and BiRefNet | Required components are presented as one task setup, not competing choices. Existing edit-plus-cleanup budget is approximately 16 GB free GPU memory |
| Character: geometry | Supported standard Hunyuan3D setup for new installations | 2mini is a lower-memory alternative with separate manual prerequisites; TRELLIS.2 adds textures and has an existing approximately 24 GB free-GPU-memory budget |
| Character: motion | Preserve the compatible saved Kimodo encoder and existing defaults | Clearly identify the smaller LFM bridge as experimental and the original Llama/LLM2Vec path as higher-memory and gated. Do not silently substitute trained encoders |
| Character: capture/optional tasks | Preserve existing CPU capture and optional/manual paths | Do not require naming models when a manual title suffices or invent support for unimplemented tasks |

These are task-specific components, not a catalog of newly supported models. Do not recommend installing every alternative. Do not promise that the complete local Character pipeline runs on every 32 GB PC: show the unmet stage-specific requirement and retain existing import/remote alternatives without selecting them automatically.

New Character Studio installations start with the recommended SD 1.5/DreamShaper, FLUX.2 klein/BiRefNet and supported standard Hunyuan3D configuration, so the first task exposes the appropriate supported setup/download action. This initialization applies only when no saved Designer configuration exists. It selects model filenames, not installed weights, and never starts downloads automatically. Existing saved configurations (including 2mini, custom files and experimental encoder choices) are preserved without migration; changing them requires the explicit task-scoped recommendation action and Save settings.

## Implementation

**Character Studio:** restructure `AiProvidersPanel` around the common screen contract, reusing native profile fields, model readiness/download services, `aiHardware`, and existing draft/conflict handling. Keep full provider functionality reachable under Advanced. Separate recommendation metadata and formatting into small shared helpers where useful. Expose measured hardware immediately and retain all current provider, credential, saved-job and MCP boundaries.

**Sound Studio:** evolve the existing `ModelSettings` design rather than replacing it. Add a narrow main-process/preload hardware-summary API for CPU, OS and RAM; combine it with existing loopback ComfyUI GPU telemetry. Show requirement labels for all alternatives, a task-scoped recommendation reset, and a collapsed Advanced section without losing custom selections. Keep the browser-only preview honest about unavailable host telemetry.

**Documentation:** include this shared UX plan in both PRs, update the appropriate README/guide sections, and capture actual settings UI where the local environment permits. Screenshots must not expose private paths, credentials, or personal assets.

## Functional acceptance

- Tests cover default/recommended selection, custom-choice preservation, task-scoped reset, and no mutations from opening, closing, refreshing hardware or collapsing Advanced.
- Fresh-install defaults match the supported recommended task setups; loading saved configurations never silently applies those new defaults.
- Hardware tests cover disconnected/unknown telemetry, CPU-only devices, missing or invalid values, low memory, multiple GPUs without summing them, unified-memory ambiguity, and remote workflows without local-GPU blockers.
- All alternative-model labels distinguish estimates from hard requirements and remain readable before model selection.
- Desktop checks cover fresh and saved-custom settings, keyboard access, focus restoration, visible errors, supported minimum window size, and relaunch persistence. Character changes retain MCP operability.
- Run each repository's existing tests, type checking and build, plus the relevant desktop/MCP checks. Do not install model weights or start paid inference to validate a settings UX.
- Submit both PRs with the shared-plan link, accurate scope, validation evidence and any real limitations; cross-link the companion PRs.

## Shared app-header metrics

The app-drawn headers use the same geometry and typography, while retaining each application's name, icon artwork and accent color. Native operating-system title bars remain native, including their active/inactive appearance.

| Element | Shared desktop value |
|---|---|
| Font stack | `"Segoe UI Variable", "Segoe UI", sans-serif` |
| Header | 78 px including bottom border; 24 px horizontal padding above 1200 px, 18 px at or below 1200 px; no vertical padding; 20 px column gap |
| Brand icon | 40 by 40 px, non-shrinking; 12 px gap before text |
| Wordmark | 24 px; line-height 1.1; -0.8 px letter spacing; first word weight 700, `studio` weight 300; explicit 4 px inter-word spacing |
| Tagline | 8 px, weight 500, line-height 1.4, 1.5 px letter spacing, uppercase; 3 px gap below wordmark |
| Header actions | 34 px high; 12 px, weight 500, 16 px line-height; 8 px gap, reduced to 6 px at or below 1200 px |
| Workspace labels | 19 px |

Keep the brand metrics at each app's supported desktop minimum. Preserve the existing narrow-preview fallback rather than forcing desktop geometry into unsupported small widths. Verify the computed metrics and overflow at normal/minimum sizes and higher zoom. Scroll containers around Model Settings controls must include room for the visible keyboard focus outline rather than clipping or hiding it.
