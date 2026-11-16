/**
 * The tutorials that follow the first mod: what each file is for and every JBeam section, shown
 * on the user's own mod (its files open, its sections highlighted), with small things to do.
 */
import { ws, useWs } from '../project/workspace';
import { useUi, openTab } from '../state/ui';
import { useSel } from '../state/selection';
import { useChecks } from '../state/checks';
import { revealRange } from '../editor/CodeEditor';
import { objGet, type ANode } from '@core/sjson';
import { startGuide, type GuideStep } from './Guide';

const EDITOR = '.editor-wrap';
const VIEW = '.viewport-wrap';
const FILES = '.sidebar';

/** opens a file of the vehicle by its path (vehicles/…), if it is there */
function show(vpath: string) {
  const d = ws.doc(vpath);
  if (d) openTab(d.key);
}

/** opens a part's file and selects one of its sections (or the part's name) in the code */
function section(part: string, key?: string) {
  const def = ws.partDef(part);
  if (!def) return;
  const d = ws.doc(def.file);
  if (!d) return;
  openTab(d.key);
  if (!key) {
    revealRange(d.key, def.key.s, def.key.e);
    return;
  }
  const k = def.sectionKeys.get(key);
  const v: ANode | undefined = def.sections.get(key) ?? objGet(def.node, key);
  if (k && v) revealRange(d.key, k.s, v.e);
}

function filesView() {
  useUi.setState({ sidebar: true, activity: 'structure', structMode: 'files' });
}

/** tasks: the user does it, the step ticks */
function selectNodeTask(): GuideStep['task'] {
  return { text: 'Click a node in the 3D view', done: () => useSel.getState().sel.nodes.size > 0 };
}

function moveTask(file: () => string | undefined): { enter: () => void; task: GuideStep['task'] } {
  let before = '';
  return {
    enter: () => {
      before = ws.doc(file() ?? '')?.text ?? '';
    },
    task: { text: 'Press G, move the mouse, click to drop it', done: () => !!before && (ws.doc(file() ?? '')?.text ?? before) !== before },
  };
}

function saveTask(): GuideStep['task'] {
  return { text: 'Save everything: Ctrl+Shift+S', done: () => useWs.getState().dirtyCount === 0 };
}

function checkTask(): GuideStep['task'] {
  return { text: 'Press Check (top right)', done: () => !!useChecks.getState().results && useChecks.getState().forVehicle === ws.vehicle };
}

const NEXT_STEPS = `- Right-click in the code → Add… inserts any section, ready to fill.
- Create & place (the hammer on the left) adds lights, seats, triggers, flexbodies and more without typing them.
- Tools → Import from Blender / OBJ turns a mesh into nodes and beams.
- Check often; the user guide covers everything else.
- Help → Tutorial for the open mod shows this again.`;

// ---------------------------------------------------------------------------------------------
// a new vehicle
// ---------------------------------------------------------------------------------------------

export function startVehicleTutorial(id: string) {
  const dir = `vehicles/${id}`;
  const body = `${id}_body`;
  const mainFile = () => ws.partDef(body)?.file ?? ws.partDef(id)?.file;
  const move = moveTask(mainFile);
  const steps: GuideStep[] = [
    {
      chapter: 'Your files', target: FILES, wide: true, enter: filesView, title: 'What each file does',
      text: `Everything for \`${id}\` is in \`${dir}/\`:

- \`${id}.jbeam\`: the physics. Nodes, beams, triangles, and which mesh goes where.
- \`info.json\`: the card in the vehicle selector.
- \`base.pc\` and \`info_base.json\`: a configuration and its card.
- \`${id}.dae\`: the 3D mesh you see.
- \`main.materials.json\`: how that mesh looks (colour, shine).
- \`default.jpg\`, \`base.jpg\`: the selector thumbnails.`,
    },
    {
      chapter: 'Your files', target: EDITOR, wide: true, enter: () => show(`${dir}/info.json`), title: 'info.json',
      text: `The vehicle's card in the selector: \`Name\`, \`Brand\`, \`Author\` and \`Type\` (Car, Truck, Trailer or Prop decides where it is listed).

\`default_pc\` names the configuration that spawns when you pick the vehicle itself.`,
    },
    {
      chapter: 'Your files', target: EDITOR, wide: true, enter: () => show(`${dir}/base.pc`), title: 'Configurations (.pc)',
      text: `A configuration says which part goes in each slot (\`parts\`) and sets tuning values (\`vars\`).

Each \`.pc\` is one entry in the selector; its \`info_<name>.json\` holds that entry's name and value. Make more with File → Save part configuration as .pc.`,
    },
    {
      chapter: 'The JBeam file', target: EDITOR, wide: true, enter: () => section(id), title: 'Parts',
      text: `A .jbeam file holds parts. Each part is a named block: \`"${id}": { … }\`.

This one has \`"slotType" : "main"\`: the game starts building the vehicle here. Every other part plugs into a slot.`,
    },
    {
      chapter: 'The JBeam file', target: EDITOR, wide: true, enter: () => section(id, 'slots2'), title: 'Slots',
      text: `\`slots2\` lists the places where other parts go. The first row names the columns:

- \`name\`: the slot's id; \`allowTypes\`: the slotTypes that fit.
- \`default\`: the part used when a configuration says nothing.
- \`description\`: the name in the parts menu.

\`{"coreSlot":true}\` means it can't be left empty. Your body part fits here because its slotType is \`${body}\`.`,
    },
    {
      chapter: 'The JBeam file', target: EDITOR, wide: true, enter: () => section(body, 'information'), title: 'information',
      text: `The part's \`name\` in the parts menu, its \`authors\` and \`value\` (price, used in career).`,
    },
    {
      chapter: 'The JBeam file', target: EDITOR, wide: true, enter: () => section(body, 'refNodes'), title: 'refNodes and camera',
      text: `\`refNodes\` gives the vehicle its frame: a \`ref\` node (the centre), and nodes towards its \`back\`, \`left\` and \`up\`. Speed, the camera and many systems read it.

\`cameraExternal\` sets the orbit camera: distance, offset and field of view.`,
    },
    {
      chapter: 'Nodes', target: EDITOR, wide: true, enter: () => section(body, 'nodes'), title: 'nodes',
      text: `Nodes are the points that carry the mass. The first row names the columns: \`id\`, then the position in metres.

Rows like \`{"nodeWeight":12.5}\` are modifiers: they apply to every row below them, until changed.

Axes: +X is the vehicle's left, -Y its front, Z up. Names ending in \`l\`/\`r\` are mirror twins, so symmetry works on them.`,
    },
    { chapter: 'Nodes', target: VIEW, title: 'Pick one', text: 'Nodes are the dots in the 3D view. The code jumps to the node you click.', task: selectNodeTask() },
    {
      chapter: 'Nodes', target: VIEW, title: 'Move it', enter: move.enter, task: move.task,
      text: 'G moves the selection (X, Y or Z locks an axis, Ctrl snaps to a node). Watch the numbers change in the code. Ctrl+Z undoes it.',
    },
    {
      chapter: 'Beams', target: EDITOR, wide: true, enter: () => section(body, 'beams'), title: 'beams',
      text: `Beams join two nodes, like springs. The modifiers above them set:

- \`beamSpring\`: stiffness (N/m), \`beamDamp\`: damping.
- \`beamDeform\`: the force that bends it for good.
- \`beamStrength\`: the force that breaks it (\`FLT_MAX\`: never).

A shape only holds if its faces are triangulated, hence the diagonals.`,
    },
    {
      chapter: 'Triangles', target: EDITOR, wide: true, enter: () => section(body, 'triangles'), title: 'triangles',
      text: `Triangles are the surface that touches other vehicles, and that the air pushes on (\`dragCoef\`).

They have one side: the order of the three nodes decides which way it faces. The 3D view colours the back faces.`,
    },
    {
      chapter: 'The mesh', target: EDITOR, wide: true, enter: () => section(body, 'flexbodies'), title: 'flexbodies',
      text: `A flexbody puts a mesh on the nodes: \`"${id}_box"\` is the object's name in \`${id}.dae\`, and \`["${body}"]\` the node group it follows. Each vertex sticks to the nearest nodes of that group and bends with them.

The mesh's material is described in \`main.materials.json\`. Material names are shared by every vehicle in the game, so keep them unique.`,
    },
    { chapter: 'Try it', target: '[aria-label="Save all"]', title: 'Save', text: 'Nothing is written to disk until you save. Unsaved files show a dot on their tab.', task: saveTask() },
    {
      chapter: 'Try it', target: '[data-guide="reload"]', title: 'In the game', wide: true,
      text: `Reload in game (F5) saves and respawns the vehicle in BeamNG, and starts the game if needed.

BeamNG only sees a new mod folder when it starts: if it was running when you made this mod, restart it once. After that, F5 is enough.`,
    },
    { chapter: 'Try it', target: '[data-guide="check"]', title: 'Check', text: 'Check finds loose nodes, duplicate beams, typos and more. Run it before you share the mod.', task: checkTask() },
    { chapter: 'Next', wide: true, title: 'Where to go from here', text: NEXT_STEPS },
  ];
  startGuide('tutorial.vehicle', steps);
}

// ---------------------------------------------------------------------------------------------
// new parts for a vehicle
// ---------------------------------------------------------------------------------------------

export function startPartTutorial(model: string, part: string, mod: string, withConfig: boolean) {
  const def = () => ws.partDef(part);
  const file = () => def()?.file;
  const hasSlots = !!(def()?.sections.has('slots2') || def()?.sections.has('slots'));
  const move = moveTask(file);
  const steps: GuideStep[] = [
    {
      chapter: 'Your files', target: FILES, wide: true, enter: filesView, title: 'Where your part lives',
      text: `Your part is in \`vehicles/${model}/${mod}/${part}.jbeam\`, inside your mod folder.

It has a path and a name of its own, so it replaces nothing: the game's parts stay as they are, and yours becomes one more choice. The game's files show a lock: open them to read, not to edit.${withConfig ? `

\`${mod}.pc\` and \`info_${mod}.json\` add a configuration with your part fitted.` : ''}`,
    },
    {
      chapter: 'Your part', target: EDITOR, wide: true, enter: () => section(part), title: 'The part',
      text: `\`"${part}"\` is the part's name. Names are shared by everything loaded for ${model}: a part with the same name as another would replace it for every player.`,
    },
    {
      chapter: 'Your part', target: EDITOR, wide: true, enter: () => section(part, 'information'), title: 'information',
      text: `\`name\` is what the parts menu shows, \`authors\` and \`value\` (price, used in career) too.`,
    },
    {
      chapter: 'Your part', target: FILES, wide: true, enter: () => {
        section(part, 'slotType');
        useUi.setState({ sidebar: true, activity: 'structure', structMode: 'slots' });
      }, title: 'slotType: where it fits',
      text: `\`slotType\` says which slot the part goes in. Any slot whose \`allowTypes\` lists it accepts it.

The Slots view (here) shows every slot and what fills it; pick another part in a slot to compare.`,
    },
    ...(hasSlots ? [{
      chapter: 'Your part', target: EDITOR, wide: true, enter: () => section(part, def()?.sections.has('slots2') ? 'slots2' : 'slots'), title: 'Its own slots',
      text: `A part can hold slots too: badges, lights, license plates. These came with the copy and keep working.

Columns: \`name\`, \`allowTypes\`, \`default\` (what goes there unless a configuration says otherwise) and \`description\`.`,
    } as GuideStep] : []),
    {
      chapter: 'The mesh', target: EDITOR, wide: true, enter: () => {
        filesView();
        section(part, 'flexbodies');
      }, title: 'flexbodies',
      text: `Each row puts a mesh on the part's nodes: the mesh's object name, then the node groups it follows. A copy keeps the game's meshes, which load from the game.

To use your own: put your .dae in your mod folder, write its object names here, and describe its materials in a \`.materials.json\` with names nobody else uses.`,
    },
    {
      chapter: 'Nodes and beams', target: EDITOR, wide: true, enter: () => section(part, 'nodes'), title: 'nodes',
      text: `The part's points. Modifier rows like \`{"nodeWeight":1.2}\` apply to the rows below them.

They keep the original names, and that matters: other parts attach their beams to nodes by name. Renaming one (F2) updates your own files, but the game's parts that attach to it would come loose.`,
    },
    {
      chapter: 'Nodes and beams', target: EDITOR, wide: true, enter: () => section(part, 'beams'), title: 'beams',
      text: `Beams join two nodes, here and to the body: that is how the part is held on. Modifiers set \`beamSpring\` (stiffness), \`beamDamp\`, \`beamDeform\` (when it bends for good) and \`beamStrength\` (when it breaks).`,
    },
    { chapter: 'Try it', target: VIEW, title: 'Pick a node', text: 'The 3D view shows your part. Click one of its nodes.', task: selectNodeTask() },
    { chapter: 'Try it', target: VIEW, title: 'Move it', enter: move.enter, task: move.task, text: 'G moves it (X, Y or Z locks an axis). The code follows; Ctrl+Z undoes it.' },
    { chapter: 'Try it', target: '[aria-label="Save all"]', title: 'Save', text: 'Nothing is written to disk until you save.', task: saveTask() },
    {
      chapter: 'Try it', target: '[data-guide="reload"]', title: 'In the game', wide: true,
      text: `Reload in game (F5) respawns ${model} in BeamNG with the configuration you have open, your part fitted, and starts the game if needed.

In the game, the Vehicle Config menu (Ctrl+W) shows your part in its slot. BeamNG only sees a new mod folder when it starts: restart it once if it was running.`,
    },
    { chapter: 'Try it', target: '[data-guide="check"]', title: 'Check', text: 'Check finds loose nodes, duplicate beams, typos and more. Run it before you share the mod.', task: checkTask() },
    { chapter: 'Next', wide: true, title: 'Where to go from here', text: NEXT_STEPS },
  ];
  startGuide('tutorial.part', steps);
}

/** Help → Tutorial: for the vehicle or part of a mod that is open */
export function startTutorialForOpenMod(): boolean {
  const v = ws.vehicle;
  const model = ws.model;
  if (!v || !model) return false;
  const editable = (file: string) => {
    const d = ws.doc(file);
    return !!d?.writable && !d.isCommon;
  };
  if (v.root && editable(v.root.def.file)) {
    startVehicleTutorial(model);
    return true;
  }
  const target = useWs.getState().target;
  const part = target?.part ?? v.parts.find((p) => editable(p.def.file))?.def.name;
  if (part) {
    const m = /^vehicles\/[^/]+\/([^/]+)\//i.exec(ws.partDef(part)?.file ?? '');
    startPartTutorial(model, part, m?.[1] ?? 'your_mod', false);
    return true;
  }
  return false;
}
