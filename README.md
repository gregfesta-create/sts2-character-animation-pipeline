# Artwork to animated STS2 characters

An AI-operated pipeline for turning character artwork into movable 2D rigs, animations and modular presentation assets for Slay the Spire 2. Your coding AI operates the tools; the resulting game presentation does not require a running AI model.

## Give this repository to your AI

Give your coding AI this repository link and the installed mod's link, then ask:

> Use this pipeline to animate this installed mod: [mod link].

The AI should read `character-pipeline/AGENT-OPERATIONS.md`, locate the installed mod from its link, inspect its cards and powers, find available artwork and handle the technical inputs. You should not need to supply folder paths or a longer prompt when those inputs are discoverable. It must show you the original artwork and wait for approval before preparing layers, rigging or animating it; it asks only for genuinely missing inputs.

The AI should handle specifications and commands. You do not need a separate prompt website. Windows is the current native target; setup uses Node.js 24, Python with Pillow/NumPy, matching Godot/MegaDot and, for game packaging, installed STS2, .NET tools and BaseLib. These dependencies and the game are installed separately. RitsuLib is optional.

Start with the [pipeline guide](character-pipeline/README.md), [AI operating instructions](character-pipeline/AGENT-OPERATIONS.md) and [configuration example](character-pipeline/config/tools.example.json). Run commands from this repository root.

## Release status

Controlled graphics/audio gameplay, source-only operation and fresh SDK-cache packaging have passed technical checks. The owner deferred testing on another clean computer until after completion; that check remains unverified and does not block this technical handoff. Publication requires review of the final source inventory. See the [technical acceptance summary](character-pipeline/release/ACCEPTANCE.md) and [release requirements](character-pipeline/RELEASE.md). Controlled combat proofs do not establish every card or game version. Synthetic numeric fixtures do not establish artistic quality. No further demonstration artwork is being created for the current technical scope.

Pipeline code is [MIT licensed](character-pipeline/LICENSE). Character artwork, game assets, model weights and separately installed dependencies are not included in that license grant or source distribution.
