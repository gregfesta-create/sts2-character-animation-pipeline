# Public release boundary

Publication is pending full acceptance. This document records the release boundary; it does not certify a completed release.

Publish a fresh, sanitized source repository, not the MetaSwarm workspace or its Git history. The development tree contains unrelated projects, tracked machine-specific configuration and local evidence. Adding ignore rules does not remove already tracked files or historical copies.

Preserve this layout so the existing coverage tool can find its policy:

```text
.coverage-thresholds.json
README.md                 (copy release/README.md here)
character-pipeline/
  README.md
  AGENT-OPERATIONS.md
  RELEASE.md
  LICENSE
  .gitignore
  cli.js
  adapters/ backends/ godot/ lib/ library/ providers/ schema/ test/ tools/ workers/
  config/tools.example.json
```

Copy only reviewed source files from these directories. Reject junctions and symbolic links; exclude nested `.godot`, `bin`, `obj`, `node_modules`, Python caches and compiled outputs. Review the resulting file list and bytes before initializing a new repository. Do not copy the current `.git` directory. An artifact inventory must record relative paths, byte sizes and SHA256 hashes of the final selected files.

The source-staging command implements this boundary without creating a repository or publishing:

```powershell
node character-pipeline/tools/stage-source.js --out C:/YOUR_RELEASES/FRESH_CANDIDATE
```

The destination must be an absolute, nonexistent directory outside the source repository, with an existing parent. Existing destinations, traversal and linked paths are refused. The command uses a fixed source allowlist, excludes private/generated files, and writes a sorted `source-inventory.json` containing relative paths, byte sizes and SHA256 hashes. The inventory does not hash itself. A failed copy retains only its explicitly identified partial candidate for inspection; it never deletes an existing destination or source. Review the inventory before using it. The public root README, MIT license and coverage policy are included, and the release README is also retained at its original path so a candidate can stage itself again.

Use `character-pipeline/release/README.md` as the public repository's root README, so the repository link exposes the AI entry prompt immediately. The containing workspace's root README belongs to MetaSwarm and is not this product's entry page.

Exclude `config/local.tools.json`, all other local configuration, `evidence`, `jobs`, `exports`, `.devtools`, `.leases`, generated captures and temporary release staging. Never distribute installed game or BaseLib assemblies, native engine binaries, model weights or private artwork. Keep artistic approval and public redistribution permission separate. The Arcanist/Sylphie demonstration inputs remain local unless their redistribution is separately authorized. The development `verification.json` points at local evidence and plans and is excluded. The candidate instead includes the reviewed, self-contained [technical acceptance summary](release/ACCEPTANCE.md), whose limits must remain accurate for its exact source checkpoint.

## Portable verification

Use a short checkout and job path on Windows, such as `C:/src/sts2-pipeline` and `C:/work/character-job`. Deeply nested staging directories can exceed Windows path limits when compiler/test staging adds nested components. Keep runtime outputs outside the source candidate. Set `PYTHONDONTWRITEBYTECODE=1` in the operation's child environment when verifying a byte-for-byte immutable source tree; otherwise Python may add `workers/__pycache__` files.

The operating AI should first locate compatible existing dependencies, then guide installation only for missing items:

1. [Node.js 24](https://nodejs.org/en/download) and [Python 3.12 or later](https://www.python.org/downloads/windows/), with [Pillow](https://pillow.readthedocs.io/en/stable/installation/basic-installation.html) and [NumPy](https://numpy.org/install/) in the selected Python environment.
2. The separately installed game and matching [BaseLib release](https://github.com/Alchyr/BaseLib-StS2/releases). Keep MAIN and beta references isolated.
3. A matching .NET engine. This pipeline's registered packaging profile pins Godot/MegaDot 4.5.1 and net9.0; do not silently substitute a different version. Follow the [BaseLib author's engine setup guide](https://github.com/Alchyr/ModTemplate-StS2/wiki/Setup) and verify the actual engine with discovery. The [MegaDot site](https://megadot.megacrit.com/) may expose different downloads by platform. Use a verified Windows .NET build, preserving its GodotSharp directory. Automated launches must use the executable's installation directory as cwd and hidden windows.
4. An x64 [.NET SDK supporting net9.0](https://dotnet.microsoft.com/en-us/download/dotnet/9.0), with the exact installed SDK version recorded in `modPackaging.dotnetSdkVersion`. A runtime alone cannot compile. For the standalone adapter project, explicitly pass `GameReferenceDir` and `BaseLibReference`; its development defaults are not portable configuration.
5. A populated package cache for the pinned [Godot.NET.Sdk](https://www.nuget.org/packages/Godot.NET.Sdk/4.5.1), [GodotSharp](https://www.nuget.org/packages/GodotSharp/4.5.1) and [Godot.SourceGenerators](https://www.nuget.org/packages/Godot.SourceGenerators/4.5.1) packages, all version 4.5.1.

Optional audio conversion uses PyAV and NumPy in that same Python environment. Supplied compatible audio can use the existing validated delivery path; a separate audio editor is not required by the pipeline.

To acquire the packaging cache, use an isolated scratch project with `<Project Sdk="Godot.NET.Sdk/4.5.1"><PropertyGroup><TargetFramework>net9.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>`. Set `NUGET_PACKAGES` only in that child process to the chosen fresh cache, and run the documented [`dotnet restore`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-restore) with `--packages` selecting that same cache and an explicit trusted NuGet feed/configuration. This is an online acquisition step before offline packaging, not an installation performed by `sdkCacheRoot`. Preserve the restored package directories, nupkg/nuspec and `.nupkg.metadata` files; copying extracted DLLs alone is insufficient. Validate discovery and actual package capture before reporting setup complete. This acquisition recipe is not, by itself, evidence of an independently provisioned clean host.

The recipe was executed with a fresh separate cache on the development host, followed by successful normal offline packaging using that cache. This validates acquisition/cache compatibility for the recorded tool versions, while independent clean-host installation remains unverified.

All commands below run from the new repository root. They must succeed with no private developer configuration present.

```powershell
node character-pipeline/cli.js --help
$env:PIPELINE_TEST_PYTHON = 'C:/YOUR_PYTHON/python.exe'
$env:PIPELINE_TEST_NYC = 'C:/YOUR_DEVELOPMENT_TOOLS/node_modules/nyc/bin/nyc.js'
$env:PYTHONDONTWRITEBYTECODE = '1'
node --test --test-concurrency=1 --experimental-test-coverage --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80
node character-pipeline/tools/coverage.js --nyc $env:PIPELINE_TEST_NYC --out C:/YOUR_EVIDENCE/statement-coverage
```

Real artwork-worker tests require Python with Pillow and NumPy. `PIPELINE_TEST_PYTHON` selects one executable, including paths with spaces; it is not a command line. Without it they use `python` from PATH. The real statement-instrumentation test uses `PIPELINE_TEST_NYC`, or defaults to `character-pipeline/.devtools/node_modules/nyc/bin/nyc.js`; the validated development version is nyc 18.0.0. Install that development tool separately, or point to an existing verified installation. Its dependencies are not runtime dependencies. Missing dependencies fail normally. Native fixture runners are separate opt-in developer checks and may require a newly authored local tool configuration; they are not clean-machine installation evidence.

Create a private configuration from `config/tools.example.json`, populate actual source/output/runtime roots, then run:

```powershell
node character-pipeline/cli.js discover --config YOUR_TOOLS.json --json
```

Verify a supplied-art build through original approval, resume, previews, export and packaging using the documented operations. Packaging needs an already populated compatible offline Godot.NET.Sdk/net9 cache and installed SDK; merely configuring `sdkCacheRoot` does not populate it. Record how the release's supported dependency versions were obtained and verified on the clean host. Run the independent Istanbul gate with the approved development instrumenter and confirm its source and threshold hashes. Do not bundle the instrumenter's development installation as runtime content.

## Remaining release decisions and acceptance

- The owner selected MIT for the pipeline source; include LICENSE. Record provenance and notices for any third-party source and for separately licensed tools. This does not relicense the containing MetaSwarm workspace, character artwork or game assets.
- Complete the technical source/data reuse, game integration, audio and portability acceptance. The current user scope excludes creating or polishing demonstration artwork. Synthetic technical proofs must never be described as artistic-quality approval or universal input support.
- The owner deferred clean-host installation testing to another computer after completion on 2026-10-21. Record it as unverified; it is not a blocker for this technical handoff or source publication.
- Remove stale or machine-specific instructions, scan all selected content, and independently review the complete candidate.
- Capture project learnings before creating the final PR. Publish only after the finished-release condition is satisfied.

Current controlled combat/lifecycle and frozen-core reuse results are recorded in the public acceptance summary. They do not establish universal retail gameplay, artistic quality or clean-host installation. No new artwork is required to continue the current technical release work.
