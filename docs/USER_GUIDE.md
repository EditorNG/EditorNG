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
| Pick up where you left off | Every vehicle is a **workspace**: it comes back as you left it (configuration and unsaved slot choices, part shown, code tabs, camera), at start and whenever you open it again. |
| Switch between your projects | **File → Open recent…** lists your workspaces (with the configuration they were on) and recent files. |
| Make a new mod | Start page → **New mod…** (or **File → New mod…**, Ctrl+Shift+N). See below. |
| Open a vehicle (mod or vanilla) | Start page → **Open… → Vehicle…**, the car icon in the Structure panel, or the palette (Ctrl+Shift+P → "Open vehicle"). Mods are listed first. |
| Reopen something recent | The start page lists recent vehicles and recent `.jbeam` files. |
| Open a mod folder anywhere | **Open… → Mod folder…** (File → Open mod / vehicle folder…) |
| Open a single `.jbeam` | **Open… → .jbeam file(s)…**: parts are shown side by side without slot resolution. |
| Open a `.pc` | **Open… → .pc configuration…** opens its vehicle with that configuration, from anywhere on disk. |
| Open by dropping | Drop a mod folder, `.jbeam` files or a `.pc` on the window. |

The BeamNG install and user folder are detected automatically; change them in **Settings → Files & game**.

**New mod.** One dialog for the two kinds of mods. Everything goes into
`mods/unpacked/<mod name>`, and the dialog lists the files before writing them. Nothing of the
game is changed.

- **New vehicle or prop**: name, brand, type (Car, Truck, Trailer, Prop) and a start:
  - **Box**: a 1 m cube with nodes, beams, collision triangles, a mesh and its material. It spawns right away.
  - **Empty**: the parts with nothing in them.

  The files are laid out and formatted like the game's own: `<id>.jbeam` with a main part and a
  core body slot, `info.json`, a `base` configuration (`base.pc`, `info_base.json`), and
  selector thumbnails (`default.jpg`, `base.jpg`) rendered from the 3D view.
- **Parts for a vehicle**: pick the vehicle and the slots (front bumper, hood…). For each slot,
  start from a **copy** of the part that is there now (it fits and works at once, with the game's
  meshes) or from an **empty** part. Part names come from the mod name and must be new, so
  nothing is replaced. **Also add a configuration** writes a `.pc` with your parts fitted, which
  then shows in the game's configuration list.

After **Create and open**, the vehicle opens with your part fitted (or your new vehicle in view)
and its file open. BeamNG only picks up a new mod folder when it starts: if it is running,
restart it.

**Beginner guide and tutorials.** The first time New mod opens, it offers a short walk-through
of the dialog and, after creating, of the editor. The tour ends with a choice: stop there, or
take the tutorial (about 10 minutes). The tutorial goes through your new mod itself: what each
file is for, then every JBeam section, opened and highlighted in your own file. Along the way
it asks you to do a few things (pick a node, move it, save, run Check) and ticks them off.
There is one tutorial for a new vehicle and one for a new part. Any step can be skipped.

**Help → Tutorial for the open mod** starts it any time, and **Help → Replay the beginner
guide** shows the first-time guide again. **Stop tips** turns guides and one-time hints off;
**Settings → Beginner tips** turns them back on.

**File → Close vehicle** goes back to the start page.

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
bottom        Checks · Game log · References · Weight · Output
status bar    errors / warnings · target part · selection · symmetry · parts
```

- **Structure** (tree icon): every file → its parts → their sections, with counts. Click a file or
  part to show only it in 3D; click a section (e.g. `beams 18`) to select everything it defines.
  The **Files | Slots** switch turns the panel into the slot tree (swap parts, pick the `.pc`).
- **Create** (hammer icon): placers for triggers, bulbs, occupants, wheels, rails, subdivide, and
  the Blender / OBJ import.
- **Viewport bar**: the breadcrumb `vehicle › file › part` changes what the view shows (Shift+H
  shows only the part of what is selected); pick filter (All / Nodes / Beams / Tris); views (Persp, Top,
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
- **H** hides the selected nodes, and selected meshes together with their nodes, beams and
  triangles. **Shift+H** shows only the part of what is selected (a node, a beam, a mesh; with
  nothing selected, the part you work on); press it again to go back. **Alt+H** shows all again.
  **Ctrl+Z** brings back what was hidden, like any edit.
- **Selectable** (Display popover): what a plain click or box select can pick — Nodes, Beams,
  Tris, Triggers, Flexbodies, Props. Flexbodies and props are off by default so they never get in
  the way; **Alt+click** always picks flexbodies, props and triggers. Meshes are picked only where
  you actually point at their surface.
- Bottom-left: what is in view and what is selected; with 2 nodes selected the distance (and Δx,
  Δy, Δz), with 3 the angle at the last clicked one. Top-right: what the beam colours mean.
- Triangles: back faces are tinted purple, so flipped collision triangles stand out.
- Clicking an element jumps to its line in code; the selected rows (and the beams of a selected
  node) are highlighted in the editor. Putting the cursor on a row highlights it in 3D — with
  several cursors or a multi-line selection, every row under them.

## 4. Editing

| Key | Action |
|---|---|
| **G** / **S** / **R** | Move / scale / rotate selected nodes **or triggers**. Then **X/Y/Z** to lock an axis, type a value (`G Z 0.05`, `S X -1` mirrors), hold **Ctrl** to snap onto the node under the cursor — or, with no node there, the nearest **flexbody vertex** (fitting a jbeam to a body) — only along the locked axis if one is set; hold **Alt** for grid / 5° / 0.1 increments, hold **Shift** for precision (the mouse moves things 10× less, like Blender). **Enter/click** confirms, **Esc/right-click** cancels. |
| **G G** | Slide selected slidenodes along their rail (Blender's edge slide). |
| **Shift+R** | Snap slidenodes onto their rail. |
| **Shift+X** | X symmetry: edits also apply to the mirror twins (by `l`/`r` name or mirrored position) — moving, **adding nodes, beams and triangles** (the twin triangle gets the mirrored winding), **deleting**, **renaming** (`b5l` → `x5l` renames `b5r` → `x5r`), merging, flipping, batch edits and beam conversion (side tokens in values like `door_L` swap), and **triggers** (adding one adds its mirror; moving / rotating / resizing one updates its twin). New twin rows go into the other-side part (`door_FL` → `door_FR`) when it is loaded and editable, else the same part. Moves of twins in another part ask first. Nodes without an `l`/`r` suffix get no twin. |
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

**Where new rows go**: click a line in the code editor (an orange ▸ marks it in the gutter) and
new rows from the tools — add node, beam chain, triangles, placers, imports into an existing part —
go right below it when that line is inside the section they write to, e.g. under `//widthwise`.
Several additions in a row follow each other there. Anywhere else they are appended at the end of
the section. Selecting things in 3D moves the editor cursor but not this mark.

**Saving**: Ctrl+S saves the file, Ctrl+Shift+S everything; a backup of the previous version is
kept. Right-click a file or tab → **Compare with backup…** or **Compare with original…** (the game
or mod file your copy overrides) opens a side-by-side diff.

## 5. Testing in the game

**Reload in game** (title bar, **F5**) saves everything and respawns the vehicle in the running
BeamNG, in place, with the configuration open in EditorNG: the parts and variables you picked,
even if you never saved them to a `.pc` (the paint stays). It needs a
tiny helper mod, `editorng_bridge`, which EditorNG installs into your `mods/unpacked` folder the
first time you click (it shows exactly which two files it writes). It only listens on this
computer. Restart the game (or press Ctrl+L in game) after installing. To remove it, delete
`mods/unpacked/editorng_bridge`.

The **Game log** tab follows `beamng.log`: errors and warnings that mention your vehicle, with a
click jumping to the part or file a message names.

## 6. The code editor

**Tabs.** A file you open by looking around (the explorer, a click in 3D, a search) takes the
*preview* tab (in italics), which the next one replaces, so tabs don't pile up. It stays once you
edit it, double-click its tab or pick **Keep open**. The mouse wheel scrolls the tab strip.

- syntax colouring, folding, sticky headers, a **breadcrumb** (`part › section › row`), minimap;
- **hover** a node name for its position and beams, a beam row for length and stiffness, any row
  for the **modifiers in effect** and where each was set;
- **completion** for node names, sections (with headers), option keys, parts, meshes, groups,
  `$variables`, actions;
- **multiple cursors** like VS Code: **Ctrl+click** adds one, **Ctrl+Alt+↑/↓** adds one on the line
  above/below, **Shift+Alt+drag** selects a column; the rows under every cursor or selection light up
  in 3D;
- **F12** or **Alt+click** go to definition, **Shift+F12** find references (also in the References tab),
  **F2** rename; right-click → **Select in 3D**, **Mirror to the other side**;
- **Shift+Alt+F** aligns table columns;
- underlines for what the game's loader would complain about, and for **property typos**
  (`beamSprng`) using the game's own list of valid names, with a one-click fix.

## 7. Importing from Blender

Model nodes/beams/triangles as **vertices / edges / faces** in vehicle coordinates (+X left, −Y
front, +Z up). **Tools → Import from Blender / OBJ…**: the live link add-on (N panel → EditorNG →
Send), a `.blend` file, or an OBJ (Up: Z, Forward: Y). New nodes are named automatically;
re-importing keeps existing names and skips existing beams/triangles.

**Live link add-on**: *Tools → Install Blender live-link add-on* installs and enables it. If Blender
is open while installing, restart it once: the add-on enables itself at the next start.

**Where it goes**:
- **New part** (default): pick the part name, slot type, display name, authors and value. Put it
  in a **new file** (a basic part with `information` and `slotType`, saved next to your vehicle
  when you save) or in an existing editable `.jbeam`. **Plug into** adds a `slots2` row in a
  parent part (the main part by default) so the new part shows up in the vehicle straight away.
- **Add to an existing part**: the nodes, beams and triangles go into a part you choose.
- Sending the same Blender object again defaults to the part it went into last time.

## 8. Create & place (hammer icon)

- **Triggers**, **Lights**, **Occupant**, **Rails & slidenodes**, **Subdivide** — select nodes
  first and press **From selection**; the ⌖ button next to a node field lets you click the node in
  3D. Shift+A (or right-click → Add) opens them pre-filled at the cursor.
- **Triggers**: pick the format (`triggers2`, or the old `triggers` with a label and an event
  running Lua). Actions come from a menu of every common and generic action of the game, or
  **Custom action…** for one of your interaction file; `actionsEnabled` is filled in when needed.
- **Lights**: pick what the light is (low beam, tail / brake, plate…); the bulb, electrics value,
  direction, slot name and description follow from it and from the side (taken from the position).
  **Both sides** adds the mirrored bulb too. The electrics menu lists the vehicle's own values and
  **Breaks with** its deform groups.
- **Lights in the 3D view** can be clicked (Display → Selectable → Lights) and moved with **G** or
  the move gizmo. A modular bulb's `$posX/$posY/$posZ` are rewritten in the slot that places it
  (your file, never the common bulb file); a plain light prop gets its `baseTranslation`.

## Updates

When a new version is out, EditorNG shows what it brings when it starts. **Update and restart**
downloads it, checks it, replaces the program files and restarts; your settings and files are
not touched. If anything goes wrong while replacing the files, the previous version is put back.
**Later** keeps a reminder in the status bar; **Skip this version** stops the reminders until the
next one. Help → **Check for updates** checks at any time, and Settings → Files & game turns the
check at startup off. A copy in a protected folder (like Program Files) cannot update itself: move
the EditorNG folder somewhere like Documents.

## Files changed by another program

With unsaved edits, a file changed on disk (VS Code, Blender…) is **merged** like git does: changes
on different lines are combined at once (one undo step; your edits stay unsaved), and where both
changed the same lines a dialog lets you keep yours, take the disk version, or keep both.
Settings → Files & game → *On external change* has the older behaviours.

## Code editor

- Deleting whole node rows asks whether to delete the beams and triangles that use them too (one
  undo step), like Delete in the 3D view.
- The explorer lists every file of the vehicle. Lua, JSON, `.pc` and Markdown open as text with
  highlighting; images (PNG, JPG, DDS) open in a viewer tab; other files open in their default app.
- The search box in the title bar (Ctrl+P) finds files; type `>` for commands, `@` nodes, `#`
  parts, `:` a line, `%` text in all files.

## 9. Checks and the bottom panel

- **Check** (title bar) runs every enabled check, opens the Checks tab and shows the count of
  errors and warnings.
- **Checks** lists the **problems** first: what went wrong while reading and assembling the
  vehicle (syntax, missing parts or nodes, a slot listed twice…). They are always up to date.
  "Loading notes" also shows the minor ones.
- Then the structural checks: duplicate / zero-length beams, orphan and under-connected nodes,
  coincident nodes (couplers and latches are left out), duplicate / degenerate triangles,
  left/right asymmetry, side suffix on the wrong side, flexbody groups without nodes (it says
  when those nodes are commented out), extreme weights, rails & slidenodes, elements in the
  other side's part, **leaking modifiers** (a `{"beamSpring": …}` not reset at the end of a part
  changes the next parts' rows; only leaks that touch your own files are listed), **property
  typos**, and **dependencies on other folders**: the parts, meshes and textures your parts take
  from the game's `vehicles/common` or another vehicle (what a game update can break).
- Click a finding to select it in 3D and in the code; for duplicates, click again to jump to the
  next copy. Long lists are folded per part.
- Right-click a finding to fix it (remove the extra copies, remove a repeated slot row, move rows
  to the other side's part, snap onto a rail), to **ignore** it when it is intended (kept per
  vehicle; "Show ignored" brings them back), or to stop running that check.
- **References**: every use of a node (rows of any part, slot variables like `$nodeRef`).
- **Weight**, **Output**. Tuning variables are on the suspension page.

## 10. Releasing

**Tools → Pack mod…** checks a mod against the game's modding rules (`NOTE_FOR_MODDERS.md`)
and zips it. Pick the mod; the findings come in four groups:

- **Must fix**: zip name characters, files that replace game files, part names that clash with
  the game's parts of the same vehicle or of `vehicles/common`, material names that clash with
  the game's, JBeam syntax errors, textures a material names that exist nowhere.
- **Before release**: version in the name, `info.json` and preview for new vehicles,
  configurations without their `info_*.json` or thumbnail, leftover files (notes, logs, sources,
  backups: left out of the zip).
- **Smaller download**: the game converts `*.color.png`, `*.normal.png` and `*.data.png` to DDS.
  A PNG that has its DDS next to it is left out of the zip; when the game already converted it
  (the DDS is in the user folder's `temp/`), **Use the DDS** copies it next to the PNG. Textures
  that are not converted, or very large, are pointed out.
- **Tidy up**: material textures nothing in the mod uses.

Anything can be kept in or left out of the zip with its **leave out** switch; the footer shows
the size of what gets packed.

## 11. Powertrain (gauge icon)

The powertrain takes the place of the 3D view, with the code editor next to it: every edit selects
the line it changed. The curves are for the configuration named in the bar.

- **Torque & power** are computed like the game: the base `torque` table, times `torqueModMult`,
  plus `torqueModIntake` and `torqueModExhaust`, the drop-off past `maxRPM`, the rev limiter,
  turbocharger, supercharger and nitrous boost, minus friction. The dashed line is the engine
  without boost, the thin one the base table. The points are the **base torque table** of the
  engine part: dragging one changes that engine in every configuration that uses it, and the
  tooltip says which.
- **Layers**: what shapes the curve, part by part (torque table, multiplier, intake, exhaust,
  turbo pressure and efficiency, supercharger boost, nitrous), with the number of configurations
  that use each part. Pick one to edit it. When other configurations use the part, choose first:
  **Edit for all** (their curves are drawn faintly and follow the change), or **Copy for this
  configuration only**: the part is copied under a new name, the `.pc` switches to the copy, and
  you edit the copy (one Ctrl+Z undoes it). **Scale** multiplies the layer (previewed on every
  curve before you apply it); **Peak of …** finds the scale that gives the configuration a peak
  torque or power.
- **Configurations**: every configuration's peak power and torque (live while you edit) and the
  `Power` / `Torque` its `info_*.json` gives the vehicle selector. **Update info files** writes
  them as the game does (hp rounded down, Nm rounded up to 5). Click a row to show that
  configuration.
- **Engine / Turbocharger / Supercharger / Nitrous**: every value of the section with the part it
  comes from and how many configurations use that part. Values that other parts change with
  `$+key`, `$*key`, `$<key` or `$>key` (ECU, internals, intake parts…) show the result and each
  part's change under it; editing the result writes the base value that gives it. A `$` field is
  a tuning variable: it changes the configuration. Locked values are expressions or game files.
- **Gearbox**: each ratio with the top speed it gives (at the limiter, with the final drive and the
  wheel radius), a chart of every gear, buttons to add or remove a gear, and the final drive.

## 12. Suspension analysis (wave icon)

The suspension is solved from the beams, so it works for any design: camber, toe, caster, KPI,
scrub radius, trail, roll centre, heave sweeps (camber gain, bump steer, RC migration), steering
and Ackermann, motion ratios and wheel rates, anti-dive / anti-squat, with live tuning variables.

## 13. Settings

**Settings** (gear icon, Ctrl+,): theme and accent, UI scale, 3D colours and sizes, labels,
camera, code editor, number precision, backups, naming, folders, Blender, check thresholds,
suspension model and a full **keymap** editor (F1 lists every shortcut).

## 14. Good to know

- Nothing is written to disk until you save; closing asks before discarding.
- Positions written by tools use 3 decimals by default (Settings → Editing).
- Bulb, trigger, occupant and wheel tools follow 0.40-era conventions; check placements in game.
