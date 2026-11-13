# EditorNG — user guide

EditorNG is a JBeam editor for BeamNG.drive vehicle modders: a 3D view of the nodes, beams,
triangles, wheels and flexbodies, next to a code editor that knows JBeam. Everything you do in
3D is written back into your `.jbeam` text with minimal edits — your comments, ordering and
formatting stay as they are.

Run `EditorNG.exe`. No install, no admin rights. Settings, layout and caches are stored in
`%APPDATA%\EditorNG`.

**Right-click is the main tool.** Whatever is under the cursor (a node, beam, triangle, trigger,
mesh, a file or part in the tree, a code tab, a problem row, an inspector value) has a menu with
everything you can do with it, and each entry shows its shortcut.

---

## 1. Opening things

| Want to… | Do |
|---|---|
| Pick up where you left off | The last vehicle reopens at start, with the same part/file view, open code tabs and camera. |
| Open a vehicle (mod or vanilla) | Start page → **Open vehicle…**, the car icon in the Structure panel, or the palette (Ctrl+Shift+P → "Open vehicle"). Mods are listed first. |
| Reopen something recent | The start page lists recent vehicles and recent `.jbeam` files. |
| Open a mod folder anywhere | **File → Open mod / vehicle folder…** |
| Open a single `.jbeam` | **File → Open .jbeam file(s)…** — parts are shown side by side without slot resolution. |
| Start from scratch | **File → New vehicle…** creates `mods/unpacked/<mod>/vehicles/<id>/` with a spawnable box. |

The BeamNG install and user folder are detected automatically; change them in **Settings → Files & game**.

**How the vehicle is assembled.** EditorNG uses the game's rules: slots/slots2, the selected `.pc`
configuration (or default parts), variables and `$=` expressions, `$components`, `nodeOffset` /
`nodeMove` / `nodeRotate`, modifier rows (including how they carry over between parts), file
override priority (user folder → unpacked mods → zipped mods → game).

**Read-only files.** Files from the game or zipped mods are read-only. Right-click one →
**Make editable copy…** puts a copy in an unpacked mod, where it overrides the original.

## 2. The window

```
title bar     menus · vehicle › config · [Check] [Reload in game]
left          Structure / Create sidebar
centre        viewport bar (scope › file › part · pick · views · display) + 3D view + inspector
right         code editor with a "part › section › row" breadcrumb
bottom        Problems · Checks · Game log · References · Weight · Tuning · Output
status bar    problems · target part · selection · symmetry · parts
```

- **Structure** (tree icon): every file → its parts → their sections, with counts. Click a file or
  part to show only it in 3D; click a section (e.g. `beams 18`) to select everything it defines.
  The **Files | Slots** switch turns the panel into the slot tree (swap parts, pick the `.pc`).
- **Create** (hammer icon): placers for triggers, bulbs, occupants, wheels, rails, subdivide, and
  the Blender / OBJ import.
- **Viewport bar**: the breadcrumb `vehicle › file › part` changes what the view shows (Shift+I
  isolates the part of the selection); pick filter (All / Nodes / Beams / Tris); views (Persp, Top,
  Front, Side; numpad keys work too); flexbodies and x-ray toggles; the **eye** opens Display
  (every layer, sizes, opacity, labels, beam colours); symmetry; inspector on/off.
- **Inspector**: a column on the right of the view (it floats over the view when the window is
  narrow). With nothing selected it summarises what is in view.
- **Target part** (status bar): where new nodes, beams, triangles… are written. It follows the
  part you last clicked or where your code cursor is; click it to pick one explicitly.

## 3. The 3D view

- Blender mouse layout: **middle-drag** orbits, **Shift+middle-drag** pans, **wheel** zooms,
  **left-click / left-drag** selects (box), **right-click** opens the menu. **Alt+middle-drag**
  snaps to the nearest orthographic view (front, back, sides, top, bottom) and keeps stepping
  through them as you drag, like Blender.
- **Shift** adds to the selection, **Ctrl+drag** removes, **Ctrl+click** selects the shortest beam
  path from the last clicked node, **L** linked, **Ctrl+Numpad +/−** grow / shrink,
  **Ctrl+I** invert. Beams: right-click → Select similar (type, deformGroup, breakGroup).
- **Flexbody shading** (viewport bar, or **Z** to cycle):
  - **Wire**: see-through meshes (opacity slider in Display) with a wireframe overlay.
  - **Solid**: opaque grey-white, easy on the eyes while building the node cage.
  - **Shaded**: the game's own materials from every `*.materials.json` (vehicle and common
    folders): PBR colour / normal / roughness / metallic / AO / opacity maps, read straight from the
    game's DDS or your PNGs, the vehicle paint (from the `.pc`'s `paints` when it has one, else a
    neutral metallic), lit by a built-in studio. Settings → 3D view → *Shaded: environment*
    lets you use your own HDRI (equirectangular `.hdr` or `.exr`; its brightness is normalised,
    and *environment brightness* / the Display popover's "Light" slider adjust it).
- **H** hides the selected nodes, **Shift+H** everything else, **Alt+H** shows all again.
- **Alt+click** picks flexbodies, props and triggers instead of nodes/beams.
- Bottom-left: what is in view and what is selected; with 2 nodes selected the distance (and Δx,
  Δy, Δz), with 3 the angle at the last clicked one. Top-right: what the beam colours mean.
- Triangles: back faces are tinted red, so flipped collision triangles stand out.
- Clicking an element jumps to its line in code; the selected rows (and the beams of a selected
  node) are highlighted in the editor. Putting the cursor on a row highlights it in 3D.

## 4. Editing

| Key | Action |
|---|---|
| **G** / **S** / **R** | Move / scale / rotate selected nodes **or triggers**. Then **X/Y/Z** to lock an axis, type a value (`G Z 0.05`, `S X -1` mirrors), hold **Ctrl** to snap onto the node under the cursor — or, with no node there, the nearest **flexbody vertex** (fitting a jbeam to a body) — only along the locked axis if one is set; hold **Alt** for grid / 5° / 0.1 increments. **Enter/click** confirms, **Esc/right-click** cancels. |
| **G G** | Slide selected slidenodes along their rail (Blender's edge slide). |
| **Shift+R** | Snap slidenodes onto their rail. |
| **Shift+X** | X symmetry: moves also apply to mirror twins (by `l`/`r` name or mirrored position). Twins in another part (`fender_R` → `fender_L`) ask first. |
| **E** | Extrude: new nodes on top of the selected ones, beams back to them and between them, then move. |
| **M** | Merge the selected nodes into the last clicked one (references rewritten, collapsed beams/triangles removed). |
| **N** | Add-node tool. **B** beam chain. **T** triangle strip. **Shift+N** quick naming (`f1l`, `f1r`…). |
| **F** | 2 nodes → beam, 3 → triangle, more → chain. |
| **Ctrl+F** | Flip the selected triangles. |
| **F2** / double-click | Rename a node everywhere it is used. |
| **Ctrl+M** | Mirror the selection to the other side. |
| **Shift+D** | Duplicate (with the beams between them), then move. |
| **X** / Delete | Delete. If a node is still used by other parts you get the list first. |
| **Ctrl+Z / Ctrl+Y** | Undo / redo across files; multi-step tools (extrude, bridge…) undo in one step. |

More on right-click:
- **Several nodes**: connect, rail from selection, extrude, **bridge two chains** (rungs, cross
  bracing and optionally triangles facing outward), merge, **align X/Y/Z** (to the last clicked
  node or the average), **distribute evenly**.
- **Beams**: **convert to** normal / bounded / support / pressured / anisotropic / l-beam (adds the
  fields the type needs), **copy / paste properties**.
- **Triggers**: move/rotate/resize, duplicate, **mirror to the other side** (box reflected
  correctly), **align to world** (the box turns to the nearest world axes, no rotation left, its
  centre stays), convert to global position. Align to world is also a button in the inspector.

**Gizmo**: the three buttons under the tools on the left switch on a move / rotate / scale gizmo
for nodes or triggers.

**Inspector**: exact positions (arrow keys nudge 1 mm, Shift 1 cm; nodes in parts with
`nodeOffset`/`nodeMove`/`nodeRotate` show final positions and write back the raw value). Every
row value shows **where it comes from** — the row, inline options, or a modifier row (click to
jump; orange when it leaks in from another part). With several nodes or beams selected it becomes
a **batch editor**: equal values are shown, different ones say "mixed"; type a value to write it
into every row, or choose **modifier** to wrap a contiguous block in `{"key": value}` … reset rows.

**Saving**: Ctrl+S saves the file, Ctrl+Shift+S everything; a backup of the previous version is
kept. Right-click a file or tab → **Compare with backup…** or **Compare with original…** (the game
or mod file your copy overrides) opens a side-by-side diff.

## 5. Testing in the game

**Reload in game** (title bar, **F5**) saves everything and makes the running BeamNG reload the
vehicle — or spawn it with the current configuration if another vehicle is loaded. It needs a
tiny helper mod, `editorng_bridge`, which EditorNG installs into your `mods/unpacked` folder the
first time you click (it shows exactly which two files it writes). It only listens on this
computer. Restart the game (or press Ctrl+L in game) after installing. To remove it, delete
`mods/unpacked/editorng_bridge`.

The **Game log** tab follows `beamng.log`: errors and warnings that mention your vehicle, with a
click jumping to the part or file a message names.

## 6. The code editor

- syntax colouring, folding, sticky headers, a **breadcrumb** (`part › section › row`), minimap;
- **hover** a node name for its position and beams, a beam row for length and stiffness, any row
  for the **modifiers in effect** and where each was set;
- **completion** for node names, sections (with headers), option keys, parts, meshes, groups,
  `$variables`, actions;
- **F12** go to definition, **Shift+F12** find references (also in the References tab),
  **F2** rename; right-click → **Select in 3D**, **Mirror to the other side**;
- **Shift+Alt+F** aligns table columns;
- underlines for what the game's loader would complain about, and for **property typos**
  (`beamSprng`) using the game's own list of valid names, with a one-click fix.

## 7. Importing from Blender

Model nodes/beams/triangles as **vertices / edges / faces** in vehicle coordinates (+X left, −Y
front, +Z up). **Tools → Import from Blender / OBJ…**: live link add-on (N panel → EditorNG →
Send), a `.blend` file, or an OBJ (Up: Z, Forward: Y). New nodes are named automatically;
re-importing keeps existing names and skips existing beams/triangles.

## 8. Create & place (hammer icon)

- **Trigger (triggers2)**, **Light bulb**, **Occupant seat (0.40)**, **Pressure wheels**,
  **Subdivide**, **Rails & slidenodes** — select nodes first and press **From selection**; the ⌖
  button next to a node field lets you click the node in 3D. Shift+A (or right-click → Add) opens
  them pre-filled at the cursor.

## 9. Checks and the bottom panel

- **Check** (title bar) runs every enabled check and shows the count.
- **Checks**: duplicate / zero-length beams, orphan and under-connected nodes, coincident nodes,
  duplicate / degenerate triangles, left/right asymmetry, side suffix on the wrong side, flexbody
  groups without nodes, extreme weights, rails & slidenodes, **leaking modifiers** (a
  `{"beamSpring": …}` not reset at the end of a part changes the next parts' rows — only leaks
  that touch your own files are listed), **property typos**. Right-click a finding to fix it or to
  stop running that check.
- **References**: every use of a node (rows of any part, slot variables like `$nodeRef`).
- **Weight**, **Tuning** (variables as live sliders; save as `.pc`), **Output**.

## 10. Releasing

**Tools → Pack mod…** checks a mod folder against the game's modding rules
(`NOTE_FOR_MODDERS.md`) and zips it:
zip name characters, no version in the name, files that override game files, part names that
clash with vanilla parts, leftover notes/logs/backups/sources, texture naming
(`*.color.png`, `*.normal.png`, `*.data.png`), and an `info.json` and preview for new vehicles.

## 11. Suspension analysis (wave icon)

The suspension is solved from the beams, so it works for any design: camber, toe, caster, KPI,
scrub radius, trail, roll centre, heave sweeps (camber gain, bump steer, RC migration), steering
and Ackermann, motion ratios and wheel rates, anti-dive / anti-squat, with live tuning variables.

## 12. Settings

**Settings** (gear icon, Ctrl+,): theme and accent, UI scale, 3D colours and sizes, labels,
camera, code editor, number precision, backups, naming, folders, Blender, check thresholds,
suspension model and a full **keymap** editor (F1 lists every shortcut).

## 13. Good to know

- Nothing is written to disk until you save; closing asks before discarding.
- Positions written by tools use 3 decimals by default (Settings → Editing).
- Bulb, trigger, occupant and wheel tools follow 0.40-era conventions; check placements in game.
