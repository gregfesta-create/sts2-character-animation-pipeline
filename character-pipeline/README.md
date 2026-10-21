# Artwork to animated STS2 characters

This project builds reusable 2D character rigs, animations and modular parts from artwork, with a Slay the Spire 2 integration. An operating AI helps interpret the character request and inspect its mechanics; generated runtime presentation uses deterministic rules.

Controlled MAIN/beta graphics and audio integration checks have passed. The owner deferred clean-host installation testing to another computer after completion; it remains unverified and is not a blocker for the technical handoff. Broader original artistic acceptance remains separate. GitHub publication requires the reviewed source-only release boundary.

Pipeline source is available under the [MIT License](LICENSE). Character artwork, game assets and separately installed dependencies are not included in that grant.

## Use it with your AI

The intended entry point is to give your coding AI the repository link and a request such as:

> Use this pipeline to animate this installed mod: [mod link].

Start with `AGENT-OPERATIONS.md`. Resolve the installed mod from its link, inspect cards and powers, find available original artwork, and handle the technical configuration yourself. Do not ask the user for paths that can be discovered. Show the exact original artwork and wait for approval before processing it; request only genuinely missing inputs.

The AI should handle the structured specification and commands. You do not need a separate prompt website or a runtime AI service. It must explain missing dependencies and unsupported features rather than claim they worked.

**AI agents:** start with [AGENT-OPERATIONS.md](AGENT-OPERATIONS.md). Follow the exact original-art approval checkpoint. Never interpret a request to build, silence, or an old approval as approval of revised artwork. Do not invent game bindings, buff behavior, or installation paths.

## Tools and setup

Current native development targets Windows. It uses Node.js 24, a configured Python artwork environment and Godot/MegaDot. STS2 integration requires a separately installed game, matching .NET tools and BaseLib. RitsuLib is not required. Optional ComfyUI generation needs a compatible local service and models; supplied-art workflows do not require creative generation.

Stable and public-beta are separate compatibility targets. Use the actual game assembly and matching dependencies for each target, with separate build jobs and integration outputs. Approved artwork can be reused unchanged. A successful build or combat test for one target does not establish compatibility with the other; both require verification before release.

The AI should inspect installed tools and create a machine-specific configuration from [tools.example.json](config/tools.example.json), replacing its placeholder paths and creating the dedicated output directory. It must use your own source/output locations and game versions. The example's limits bound working files, not the final mod size. Game files, model weights, private artwork and another developer's local configuration do not belong in the published distribution.

Run all examples from the repository root:

```text
node character-pipeline/cli.js --help
node character-pipeline/cli.js discover --config YOUR_TOOLS.json --json
```

Discovery reports interpreter availability separately from `graphics` capability. Supplied-art processing needs Python with `pathlib.Path.is_junction` (Python 3.12 or later), Pillow and NumPy. A fixed, read-only probe reports their actual versions, checks a one-pixel RGBA PNG round trip in memory and a small NumPy operation, and gives diagnostics when a requirement fails. No images or files are created, and no models, GPU, ComfyUI, PyAV or rembg are required by this probe. It does not install packages or certify a complete production build, visual quality or game acceptance. An unavailable graphics worker does not change an independently observed ComfyUI workflow result.

## Workflow

An operating AI can author a reusable modular-part starter from an existing chassis contract:

```text
node character-pipeline/cli.js component create --chassis CHASSIS.json --socket SOCKET_ID --template mechanical --description "Articulated module" --id moduleDefinition --out OUTPUT_ROOT/components/module.json --config YOUR_TOOLS.json
```

Use `--type TYPE` when a socket accepts multiple component types. The chassis must already declare a matching assembly descriptor: the command derives the child mount, pixel dimensions, style, layer, inheritance and event capabilities from that descriptor. Missing contracts produce `COMPONENT_CONTRACT_REQUIRED`; the AI must author the contract rather than guess geometry. The command creates a fresh editable specification and returns its compatible `descriptor`, `socketContract`, `sourceChassisHash` and `remainingAuthoring` in JSON. It does not install the part or change the chassis.

The starter has no artwork, parts or animation choreography and reports `readyToBuild:false` and `gameAcceptance:false`. The AI continues the returned authoring work, supplies explicit source artwork paths and matching event choreography, and installs the returned descriptor/reference in the chassis before using normal build/resume. Existing relative chassis artwork references are not copied. The output must be a fresh owned `.json` path under `outputRoot`, using letters, digits, underscores and hyphens in its directories and filename, without Windows device names. A path shadowed by an earlier configured source root is rejected. Keep artwork in `sourceRoots`; creating component JSON does not widen artwork access. Original-art approval still occurs before processing, without another human checkpoint just for creating a starter.

1. Describe the character and provide artwork or choose a supported artwork provider.
2. The AI authors the specification, inspects relevant mechanic sources and records effect decisions.
3. Build produces an original-art review. Inspect the exact originals and approve or request revisions.
4. Resume prepares the artwork and compiles its rig, animations, components and supported effects.
5. Inspect previews, address defects and validate the result before export and game acceptance.

Current CLI commands include creation, modification, build, review, approval, resume, status, mechanics inspection, effect validation and native pack export. Use `--help` for exact arguments. Export revalidates the approved job, selects verified runtime resources, and returns the owned pack path and size receipt:

```text
node character-pipeline/cli.js export JOB_DIRECTORY --namespace mods/YOUR_MOD --config YOUR_TOOLS.json
```

An exported pack does not certify game integration. Unsupported resource formats and unresolved effect diagnostics remain explicit. The final game delivery and acceptance workflow is still being connected.

For an existing BaseLib character, export can also produce the C# presentation sources:

```text
node character-pipeline/cli.js export JOB_DIRECTORY --namespace mods/YOUR_MOD --integration integration.json --config YOUR_TOOLS.json
```

The request file requires `namespace`, `className` and `bounds`, and optionally accepts `origin` (no other keys), for example:

```json
{"namespace":"MyMod.Presentation","className":"CharacterPresentation","bounds":{"x":156,"y":100,"width":200,"height":200},"origin":{"x":256,"y":300}}
```

Bounds describe the authored canvas coordinates. The optional origin is the authored point placed at the game creature’s ground origin, usually the feet; the operating AI chooses it from the art and rig. The factory translates both the rig root and bounds together without changing the authored skeleton. Omitted origin defaults to `(0,0)` for existing requests. Origin requires exactly finite numeric `x` and `y` within ±1,000,000, rounded to engine float precision.

For STS2 graphics, set `export.target: "sts2"` and `export.playback: "tree"` in the specification before building. The source kit also accepts an existing generic Godot checkpoint with tree playback. The returned integration paths always include a generated factory and `PipelineVisuals.cs`. The pipeline automatically adds `AttackPresentationBinding.cs` when the captured root animations use projectile cues or the verified runtime closure includes the root effect controller (including active effects without projectiles), and `AssemblyStateBinding.cs`, `CreatureAssemblyBinding.cs` and `CreatureAssemblyHooks.cs` when the root has modular components. Include all returned sources in your mod project and use the factory from the existing character's `CreateCustomVisuals` override. Every source is separately measured, fingerprinted and checked on cache reuse, outside the PCK. Fixed adapter filenames are reserved regardless of which features are active. The factory verifies packed resources before creating the visuals. The operating AI inspects the character's actual card and power code to connect these contracts to genuine game state; no test character, card, damage rule or default buff is copied into the kit. Card-specific hooks, authoritative snapshots and actual game acceptance still require that gameplay integration. The receipt reports `requiresGameplayIntegration:true` and `gameAcceptance:false`; these sources do not create a playable character or a mod DLL.

The renderer does not apply damage, spend buff charges or replace the game's buff interface. Attack-scoped visual effects retain the verified pre-consumption facts for that attack. Unknown mechanics remain unresolved until their actual source and game hooks are established.

Source-backed tint and overlay rules can use the normal CLI after the referenced original artwork has been approved:

```text
node character-pipeline/cli.js validate-effects PLAN.json --inventory INVENTORY.json --effect-presentation presentation.json --job JOB_DIRECTORY --config YOUR_TOOLS.json
node character-pipeline/cli.js resume JOB_DIRECTORY --effects PLAN.json --inventory INVENTORY.json --effect-presentation presentation.json --config YOUR_TOOLS.json
```

The operating AI authors `presentation.json` from the inspected mechanic plan and existing artwork review. For example, replace uppercase placeholders with actual installed paths, the current review ID and the approved original hash:

```json
{
  "version": 1,
  "runtime": {"gameAssembly": "D:/YOUR_GAME/data_sts2_windows_x86_64/sts2.dll", "baseLibAssembly": "D:/YOUR_MODS/BaseLib.dll"},
  "resources": [{"id": "approvedArt", "job": "APPROVED_JOB_RELATIVE_TO_OUTPUT_ROOT", "reviewId": "CURRENT_REVIEW_ID", "sourceHash": "APPROVED_ORIGINAL_SHA256"}],
  "bindings": [{"id": "buffState", "mechanicKey": "EXACT_INVENTORIED_MECHANIC_KEY"}],
  "effects": [{"id": "activeTint", "capability": "tint", "resourceId": "approvedArt", "presentation": {"color": [0, 1, 0, 1]}}],
  "targets": {"EXISTING_SOCKET_ID": {"partId": "EXISTING_PART_ID"}}
}
```

The plan uses adapter contract `"1"` and matching binding/effect IDs. Runtime DLL paths must be within configured `sourceRoots`; mechanic code is rechecked within `mechanics.sourceRoots`. Referenced artwork jobs must be beneath `outputRoot` with an exact current original approval and matching style. `status` exposes the review ID and original hashes. Tint color is an authored presentation choice; the approval verifies source bytes and style, not visual quality. Overlay entries use `presentation: {"offset": [0, 0], "scale": [1, 1]}` and the same approved-resource reference; unsupported media reject explicitly during compilation.

Ordinary resume and export retain the JSON declaration and reconstruct verified capabilities without user-supplied functions. JSON cannot declare itself implemented or approved. This adds no human approval checkpoint. The AI must still connect observation IDs to actual gameplay through the returned adapters; a validated or compiled effect does not establish that the mod's power/card hooks are installed. Game acceptance remains false until separately verified.

## Size and ownership

To author selected reusable animation families on an existing rig:

```powershell
node character-pipeline/cli.js author-clips SPEC.json --request CLIPS.json --out AUTHORED.json --config tools.json
```

`CLIPS.json` is `{ "version": 1, "sourceSpecHash": "SHA256_OF_PARSED_SPEC", "clips": ["idle", {"family": "attack", "id": "strike", "duration": 1.2, "amplitude": 0.8, "easing": "inOut", "blendIn": 0.15}] }`. Select 1–64 requests explicitly. Matching clip IDs are replaced; unrelated clips remain. The source and request remain unchanged, and the fresh output receives exactly one new revision. The existing output parent must be inside `outputRoot`. This authors numeric animation data; it does not build, approve artwork or verify visual quality.

For an existing built job, derive a patch containing **only** `{ "animations": AUTHORED.animations }` from the output, then run `modify SPEC.json --patch PATCH.json --job JOB_DIRECTORY --config tools.json` against the unchanged previous `SPEC.json`. Do not pass the complete authored specification as a patch or replace the previous specification before that command checks the job identity.

Runtime packaging selects reachable resources and measures physical bytes. Textures use lossless self-contained storage; supported audio may use validated compressed formats. Size reports distinguish runtime files from the pack container and do not count metadata sharing as real storage savings. Keep original artwork and development evidence outside the runtime package.

See [RELEASE.md](RELEASE.md) for the sanitized publication boundary and portable test setup, and the included [technical acceptance summary](release/ACCEPTANCE.md) for verified capabilities and remaining limits. Detailed development verification and private evidence stay outside the source distribution. Editor/native harness checks do not substitute for actual STS2 acceptance.


To apply a specification patch and rebuild its existing job:

```powershell
node character-pipeline/cli.js modify SPEC.json --patch PATCH.json --job JOB_DIRECTORY --config tools.json
```

The command checks that the job still contains the complete previous specification, then preserves `SPEC.json.revision-N.json` with exclusive creation and writes the revised specification. It retains approved source snapshots and job settings, including effects and disabled rendering. Animation edits reuse unchanged originals; changes affecting generated originals return to artwork approval before preparation. Component definition or assembly changes require the current source definitions and artwork to be available. Omit `--job` to save a patch without rebuilding.

A stale job or an existing revision backup fails without replacing the specification. A failure after revision persistence returns structured `error.recovery` with the saved paths and revision. Inspect job status: resume only if its committed specification matches that saved revision; otherwise build the saved specification into the job. Keep the backup while recovering.

### Build an owned STS2 mod package

After exporting with an explicit presentation integration request, use:

```text
node character-pipeline/cli.js package JOB_DIRECTORY --request MOD_REQUEST.json --config tools.json
```

This produces a `runtime` folder containing only your mod's matching `.dll`, `.json` and `.pck`. Build records and source kits stay outside that folder. The caller supplies the C# initializer and gameplay integration; packaging does not invent character registration or combat hooks. BaseLib is a required installed dependency. RitsuLib is optional and is not added by this command.

Configure `runtimeRoots` separately from artwork `sourceRoots`, and set `modPackaging.sdkCacheRoot` plus `modPackaging.dotnetSdkVersion`. The initial supported profile is `sts2-godot451-net9`, using an already cached Godot.NET.Sdk4.5.1, net9.0 reference assets and the configured .NET SDK. Packaging uses no online NuGet feeds and installs no SDKs. Include your C# source directory and installed runtime reference directories in `runtimeRoots`; keep artwork roots unchanged.

The request has `version:1`, `profile:"sts2-godot451-net9"`, `mod` metadata (`id`, `name`, `author`, `description`, `version`, `affectsGameplay`, optional `minGameVersion`), `sources:[{name:"Entry.cs",path:"ABSOLUTE_SOURCE_PATH",initializer:true}]`, fixed `references` paths for `sts2`, `0Harmony`, `BaseLib` and `Steamworks.NET`, and `baseLibManifest`. Supply exactly one initializer source. Paths are absolute and must remain within configured runtime roots. No user `.csproj`, custom MSBuild properties, packages, analyzers or shell arguments are accepted. Only your own assembly is distributed; installed reference assemblies remain build inputs.

The first invocation captures inputs. Ordinary reuse reads verified owned captures, so it can return an existing valid package when original sources or build tools are unavailable. Use `--refresh` to capture changed sources, references, request or build configuration. Refresh and rebuild failures preserve prior completed package files. A new build requires the configured SDK and tool identity to match its captured profile. Packaging reports exact distribution bytes and hashes; it does not certify retail startup, gameplay, sound playback or artistic quality, and it does not install into the game's Mods folder.
