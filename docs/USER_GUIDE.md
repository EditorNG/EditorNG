# EditorNG — user guide

EditorNG is a JBeam editor for BeamNG.drive vehicle modders: a 3D view of the nodes, beams,
triangles, wheels and flexbodies, next to a code editor that knows JBeam. Everything you do in
3D is written back into your `.jbeam` text with minimal edits — your comments, ordering and
formatting stay as they are.

Run `EditorNG.exe`. No install, no admin rights. Settings, layout and caches are stored in
`%APPDATA%\EditorNG`.

---

## 1. Opening things

| Want to… | Do |
|---|---|
| Edit a mod you already have | **Vehicles** (car icon, left). Mods in `mods/unpacked` and the user folder are listed first. Click one. |
| Look at a vanilla vehicle | Same list, **BeamNG vehicles** group (read-only, straight from the game zips). |
| Open a mod folder anywhere | **File → Open mod / vehicle folder…** (a folder containing `vehicles/<name>`, or the vehicle folder itself). |
| Open a single `.jbeam` | **File → Open .jbeam file(s)…** — parts are shown side by side without slot resolution. |
| Start from scratch | **File → New vehicle…** creates `mods/unpacked/<mod>/vehicles/<id>/` with a spawnable box. |

The BeamNG install and user folder are detected automatically (from `BeamNG.drive.ini`); change
them in **Settings → Files & game**. The last vehicle reopens at the next start.

**How the vehicle is assembled.** EditorNG uses the same rules as the game: slots/slots2, the
selected `.pc` configuration (or default parts), variables and `$=` expressions, `$components`,
`nodeOffset` / `nodeMove` / `nodeRotate`, modifier rows, file override priority (user folder →
unpacked mods → zipped mods → game). What you see is what the game builds.

**Read-only files.** Files from the game or from zipped mods are read-only. Right-click one in
**Files → Make editable copy…** to copy it into an unpacked mod, where it overrides the original.

## 2. Working part by part

The sidebar opens on **Files**: every `.jbeam` file of the vehicle, each one expandable to the
parts it defines (switch to **All** to see textures, configs and Lua too).

- Click a **file** → the 3D view shows only that file's parts.
- Click a **part** → the view shows only that part, its code is revealed, and it becomes the
  target for new elements. Nodes of other parts that it attaches to stay visible, greyed out, so
  you can still connect beams to them.
- The bar at the bottom of the view switches between **Part**, **File** and **Vehicle** (the whole
  assembled vehicle). In File view, switching code tabs switches the 3D view too.
- Parts that the current configuration doesn't use are greyed out in the list; clicking one installs
  it in a compatible slot for viewing (not saved, nothing is written).

**Auto-mirror.** When the part you're on has a side in its name (`_R`, `_L`, `_FR`, `_RL`…) and the
other side does not exist yet, a green **Mirror to …** button appears in the status bar. It creates
the other part right after this one in the same file: node names l↔r with X mirrored, links to other
parts' nodes mirrored, triangle winding flipped, slot types / slots / groups / deform and break
groups / trigger ids / display name swapped, flexbody meshes switched when a mirrored mesh exists,
global positions and bulb positions mirrored. It lists everything it could not decide (kept meshes,
links without a mirror node, triggers and props to check) before you confirm. Tested against
vanilla: mirroring BeamNG's right-hand parts reproduces their left-hand parts' nodes and triangles.

## 3. The 3D view

- Blender mouse layout: **middle-drag** orbits, **Shift+middle-drag** pans, **wheel** zooms,
  **left-click / left-drag** selects (box select), **right-click** opens the context menu.
  (Settings → Camera & mouse has an alternative right-mouse-orbit layout.)
- **Select** click; **Shift** adds, **Ctrl** toggles; **drag** on empty space for a box select.
- **Shift+A** (or right-click → **Add…**) opens the Add menu: node here, beam / triangle from the
  selection, trigger here, light bulb here, occupant seat, pressure wheel here, subdivide, import
  from Blender. Placers open pre-filled with the point under the cursor and the selected (or
  nearest) nodes.
- **Alt+click** picks flexbodies, props and triggers instead of nodes/beams.
- Pick filter (top bar): All / Nodes (1) / Beams (2) / Tris (3).
- Views: Numpad 1 / 3 / 7 (Ctrl for the opposite side), Numpad 5 ortho, **F** frame selection,
  **Home** frame all. **Shift+I** shows only the part of the selected element.
- Bottom-right sliders: **node size, beam width, flexbody opacity, triangle opacity**. They are
  remembered between sessions, like every display toggle.
- Triangles: front faces use the triangle colour, back faces are tinted red, so flipped collision
  triangles stand out. Turn on normals in Settings → 3D view.
- Clicking any element jumps to its line in the code editor; putting the cursor on a row (or on a
  node name inside a row) highlights it in 3D. Putting the cursor on a section name highlights the
  whole section.

## 4. Editing

All tools write into the **target part** shown in the status bar ("target: …"). It follows the
part you last clicked in 3D or the part your code cursor is in; pin it with the ◎ button in
**Parts**.

| Key | Action |
|---|---|
| **G** / **S** / **R** | Move / scale / rotate selected nodes (Blender style). Then **X/Y/Z** to lock an axis, type a value (e.g. `G Z 0.05`, `S X -1` mirrors), **Ctrl** snaps, **Enter/click** confirms, **Esc/right-click** cancels. |
| **N** | Add-node tool: click to place on the view plane; a name box appears with the next free name. With "name mirror twin" on, the other side is created too. |
| **B** | Beam chain: click nodes one after another. Shift+click starts a new chain. |
| **T** | Triangle tool: click 3 nodes; it keeps going as a strip with consistent winding. |
| **F** | 2 selected nodes → beam, 3 → triangle, more → beam chain (in selection order). |
| **Ctrl+F** | Flip the selected triangles (swap id2/id3). |
| **E** | Quick naming: set a prefix and start number, then click nodes — they are renamed `f1l`, `f1r`… by side, and the mirror twin gets the same number. Alt+click to type a name. |
| **F2** / double-click | Rename a node. **Tab** commits and moves to the next selected node. Every reference in every editable file is updated (beams, triangles, props, triggers, wheels, slot variables like `$nodeRef`…). |
| **Ctrl+M** | Mirror the selection to the other side (creates or moves the `l`/`r` twins, mirrors beams and triangles with correct winding). |
| **Shift+D** | Duplicate selected nodes (and the beams between them), then move. |
| **X** / Delete | Delete the selection (nodes also remove their beams and triangles — Settings). |
| **Ctrl+Z / Ctrl+Y** | Undo / redo. Works across files; in the code editor it is the editor's own undo. |

The **inspector** (top-right card) shows the selection and lets you type exact positions (arrow
keys nudge 1 mm, Shift 1 cm). For nodes inside a part with `nodeOffset`/`nodeMove`/`nodeRotate`
the inspector shows final positions and writes back the raw value that produces them.

**Saving**: Ctrl+S saves the current file, Ctrl+Shift+S everything. A backup of the previous
version is kept (Settings → Editing). Files changed by another program are reloaded automatically
unless you have unsaved edits there.

## 5. The code editor

A full code editor (the one inside VS Code) with JBeam support:

- syntax colouring, bracket pairs, folding, sticky part/section headers, minimap, multi-cursor;
- **hover** a node name to see its position, part and beam count; hover a beam row for its length
  and stiffness; hover a `$variable` for its value; hover section and option keys for a description;
- **completion** for node names (inside link columns), section names (with ready-made headers),
  option keys, part names in slots and `.pc` files, mesh names, groups, `$variables`, actions;
- **F12** go to a node/part/variable definition, **Shift+F12** find all references,
  **F2** rename a node everywhere;
- **beam lengths** shown at the end of every beam row;
- **Shift+Alt+F** aligns the columns of every table (or just the selection);
- errors and warnings from the game's loading rules are underlined (missing nodes that the game
  would silently discard, duplicate definitions, failed expressions, wrong slot types,
  missing commas — with a quick fix).

## 6. Importing from Blender

Model the node/beam layout in Blender with **vertices (nodes), edges (beams) and faces (collision
triangles)**, in vehicle coordinates (BeamNG: +X = left, −Y = front, +Z = up — the same as Blender's
axes for a car facing −Y).

Three ways in (all open the same import dialog — **Tools → Import from Blender / OBJ…**):

1. **Live link** (best): *Tools → Install Blender live-link add-on*. In Blender press **N →
   EditorNG → Send to EditorNG**, or turn on **Auto-send** and every change is pushed.
2. **.blend file**: EditorNG runs Blender in the background to read it.
3. **OBJ**: export with "Up: Z, Forward: Y" (or set "OBJ files are Y up" in Settings).

The dialog names new nodes automatically (prefix + number + `l`/`r` by side; mirror twins share
the number; centre-line nodes get no suffix; or use the vertex group name as prefix). **Re-importing
is safe**: vertices at an existing node's position keep that node's name, and beams/triangles that
already exist are skipped — so you can keep modelling in Blender and re-send.

## 7. Create & place (hammer icon)

- **Trigger (triggers2)** — box or sphere, three reference nodes, position in vehicle coordinates
  (`baseTranslationGlobal`), colour or highlight mesh, action wiring (`common:` actions, generic door/hood/trunk
  actions, or your own). Adds `triggerEventLinks2` and `actionsEnabled` rows as needed.
- **Light bulb** — modular `slots2` bulb (`headlightBulb_halogen_55W`, `incandescent_red_21W`…),
  electrics value, node frame, deform group, position and direction presets (forward, rearward,
  down, side markers, corners, plate lights). Bulbs show in 3D as markers with an arrow.
- **Occupant seat (0.40)** — `seat_occupant` slot with the six attach nodes, recline and camera
  pitch, plus the rigidifier node and its beams. Offers to enable `occupantSystem` in the main part.
- **Pressure wheels** — axle node pair + `pressureWheels` row (vanilla node order and `wheelDir`),
  mirrored pair optional. Tyre values are placeholders: copy real ones from a vanilla tyre.
- **Subdivide** — evenly spaced nodes between two selected nodes (and mirrored).

Select elements first and press **From selection** to fill node fields and positions; the ⌖ button
next to a node field lets you click the node in 3D.

**Props & triggers editor**: Alt+click a prop or trigger; the inspector edits its translation,
rotation and size with live feedback in 3D.

## 8. Checks, weight and tuning (bottom panel)

- **Problems** — everything the loader found, click to jump.
- **Checks** — duplicate beams (with one-click removal), zero/short beams, nodes without beams,
  under-connected nodes, coincident nodes, duplicate/degenerate triangles, left/right asymmetry,
  side suffix on the wrong side, flexbody groups without nodes, extreme node weights. Click a
  finding to select it in 3D and in code.
- **Weight** — total node mass, centre of gravity, front/rear and left/right split, mass per part.
- **Tuning** — every tuning variable as a slider; the 3D view updates live. Save the result as a
  `.pc` with *File → Save part configuration*.

The **Parts** panel shows the slot tree: swap parts in any slot, switch `.pc` configurations,
isolate a part in 3D, set the target part.

## 9. Suspension analysis (wave icon)

The suspension is solved from the beams themselves, so it works for any design (double wishbone,
strut, multi-link, solid axle, leaf spring, trailing arm, home-made or procedural):

- nodes of suspension-like parts move, the body is fixed; stiff beams are rigid links, springs,
  dampers and bump stops are ignored, steering hydros are driven by the steering input;
- **static**: camber, toe, caster, KPI, scrub radius, mechanical trail (from `steerAxisUp/Down` when
  the wheel defines them, else from the hub motion), front-view instant centres, roll centre;
- **heave sweep**: camber gain, bump steer, roll centre migration, track change;
- **steering**: wheel angles over the full steering range, inner wheel vs ideal Ackermann,
  Ackermann percentage;
- **springs**: motion ratio and wheel rate for every spring/damper/stop acting on each wheel;
- anti-dive / anti-squat from the side-view instant centres;
- a front-view diagram with instant-centre lines and the roll centre;
- tuning variables (camber/toe/caster adjust, springs, ride height…) update everything live.

If the solver reports a large residual or a part moves that should not (or the other way round),
open **Moving parts → edit** and tick/untick parts, or change the rigid-beam threshold.

## 10. Settings

Everything is in **Settings** (gear icon, Ctrl+,): theme (dark/light/system) and accent colour, UI
scale, every 3D colour, node/beam sizes, label behaviour, camera controls, code editor font and
features, number precision, backups, l/r suffixes and naming defaults, game/user/mod folders,
Blender path and import defaults, check thresholds, suspension model, and a full **keymap** editor.
Settings can be exported/imported as a JSON file.

## 11. Good to know

- Nothing is written to disk until you save. The title bar shows how many files are unsaved, and
  closing the app asks before discarding.
- Positions written by tools use 3 decimals by default (Settings → Editing).
- When a new section is needed (e.g. a part without `triangles`), it is added at the end of the part
  with the standard header.
- Bulb, trigger, occupant and wheel tools follow the 0.40-era conventions; positions/rotations are
  meant as a starting point — check them in game (Ctrl+R reloads the vehicle in BeamNG).
