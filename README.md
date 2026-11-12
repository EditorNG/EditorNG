# EditorNG

A JBeam editor for BeamNG.drive: 3D node/beam/triangle editing next to a JBeam-aware code
editor, Blender import, placement tools for 0.40-era systems, structural checks and a generic
suspension kinematics analyser.

- **End users**: download the release zip, extract, run `EditorNG.exe`. See [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
- **Developers**: see below.

## Development

Requirements: Node.js 22+ (developed on Node 26), Windows.

```sh
npm install            # in npm 11+: npm install-scripts approve electron esbuild
npm run dev            # Vite dev server + Electron with hot reload
npm run build          # out/main, out/preload, out/renderer
npm start              # run the built app
npm test               # vitest: parser, assembly, editing, suspension (uses your BeamNG install)
npm run typecheck
npm run package        # release/EditorNG-win32-x64 + zip
```

The launch scripts clear `ELECTRON_RUN_AS_NODE`, which VS Code terminals set and which would make Electron behave like plain Node.

`node scripts/shot.mjs <name> [--file script.js] [--exe path] [--post blender.json]` launches the
app with an isolated profile, runs a script against `window.__app` and saves `shots/<name>.png`.
It's used for visual checks.

## Layout

| Path | What |
|---|---|
| `src/core/sjson.ts` | Tolerant SJSON parser with source offsets (comments, missing/extra commas). |
| `src/core/jbeam/` | Port of the game's loader: slots/slots2, `.pc` configs, variables and `$=` expressions, components, table modifiers, node transforms (`assemble.ts`, `expr.ts`, `nodeTransform.ts`); surgical text edits (`edit.ts`); row generators for triggers2/bulbs/occupants/wheels (`generators.ts`); reference docs (`docs.ts`). |
| `src/core/analysis/` | Structural checks and mass report (`debug.ts`), suspension kinematics solver (`suspension.ts`). |
| `src/core/import/mesh.ts` | Blender/OBJ mesh → nodes, beams, triangles with naming, mirroring and re-import matching. |
| `src/core/dae.ts` | Fast COLLADA reader (runs in a worker). |
| `src/main/` | Electron main process: BeamNG virtual file system over game zips / mods / user folder (`vfs.ts`), file IO with backups, watching, Blender bridge and live-link HTTP server. |
| `src/renderer/` | React UI: workspace (documents = Monaco models, global undo), three.js viewport, Monaco JBeam language, panels, pages. |
| `blender/` | Headless extraction script and the live-link add-on. |

Design rules: the JBeam text is the source of truth (every tool emits minimal text edits);
assembly follows the game's rules so the view matches what spawns; anything read-only (game
zips) stays read-only until copied into a mod.

Note for Git Bash on Windows: run vitest from a path with an uppercase drive letter
(`cd /C/Users/...`); a lowercase `c:` path makes vitest fail with "Cannot read properties of
undefined (reading 'config')".
