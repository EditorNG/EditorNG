/** Short reference docs for JBeam sections and keys (hover + completion). */

export interface SectionDoc {
  doc: string;
  header?: string[];
  kind: 'table' | 'dict' | 'value';
}

export const SECTIONS: Record<string, SectionDoc> = {
  information: { kind: 'dict', doc: 'Part metadata: `name` (UI name), `authors`, `value` (price), `isAuxiliary`.' },
  slotType: { kind: 'value', doc: 'Slot type(s) this part fits into. `"main"` marks the vehicle root part. Can be a list.' },
  slots: { kind: 'table', header: ['type', 'default', 'description'], doc: 'Legacy slot list. Prefer `slots2`.' },
  slots2: { kind: 'table', header: ['name', 'allowTypes', 'denyTypes', 'default', 'description'], doc: 'Slots of this part. Options in the last column (`nodeOffset`, `nodeMove`, `variables`, `coreSlot`...) apply to the child part and its descendants.' },
  variables: { kind: 'table', header: ['name', 'type', 'unit', 'category', 'default', 'min', 'max', 'title', 'description'], doc: 'Tuning variables (`$name`), shown in the vehicle tuning UI.' },
  refNodes: { kind: 'table', header: ['ref:', 'back:', 'left:', 'up:'], doc: 'Reference nodes defining the vehicle frame (position, forward via `back`, `left`, `up`). Also used by cameras and many controllers.' },
  nodes: { kind: 'table', header: ['id', 'posX', 'posY', 'posZ'], doc: 'Mass points. +X = left, -Y = front, +Z = up (metres). Modifiers: `nodeWeight`, `nodeMaterial`, `frictionCoef`, `collision`, `selfCollision`, `group`, `fixed`...' },
  beams: { kind: 'table', header: ['id1:', 'id2:'], doc: 'Springs between two nodes. Modifiers: `beamSpring`, `beamDamp`, `beamDeform`, `beamStrength`, `beamType`, `beamPrecompression`, `deformGroup`, `breakGroup`...' },
  triangles: { kind: 'table', header: ['id1:', 'id2:', 'id3:'], doc: 'Collision / aerodynamic triangles. Winding defines the normal (outward faces count for drag and pressure).' },
  quads: { kind: 'table', header: ['id1:', 'id2:', 'id3:', 'id4:'], doc: 'Two triangles at once: (1,2,3) and (3,4,1).' },
  hydros: { kind: 'table', header: ['id1:', 'id2:'], doc: 'Beams whose length is driven by an input (`inputSource`, `factor`, `inRate`, `outRate`, `inLimit`, `outLimit`).' },
  torsionbars: { kind: 'table', header: ['id1:', 'id2:', 'id3:', 'id4:'], doc: 'Angular springs around the 2–3 axis (`spring`, `damp`, `deform`, `strength`).' },
  rails: { kind: 'dict', doc: 'Named rails: `{"name": {"links:": [nodes...], "looped": false, "capped": true}}`.' },
  slidenodes: { kind: 'table', header: ['id:', 'railName', 'attached', 'fixToRail', 'tolerance', 'spring', 'strength', 'capStrength'], doc: 'Nodes sliding along rails.' },
  flexbodies: { kind: 'table', header: ['mesh', '[group]:', 'nonFlexMaterials'], doc: 'Visual meshes deformed by the node groups listed. Options: `pos`, `rot`, `scale`, `materialOverride`, `deformGroup`...' },
  props: { kind: 'table', header: ['func', 'mesh', 'idRef:', 'idX:', 'idY:', 'baseRotation', 'rotation', 'translation', 'min', 'max', 'offset', 'multiplier'], doc: 'Rigid meshes / lights moved by an electrics value (`func`) relative to 3 nodes.' },
  pressureWheels: { kind: 'table', header: ['name', 'hubGroup', 'group', 'node1:', 'node2:', 'nodeS', 'nodeArm:', 'wheelDir'], doc: 'Procedurally generated tyre + hub around the axle `node1`→`node2`. Set `radius`, `hubRadius`, `tireWidth`, `hubWidth`, `numRays`, pressure, stiffness... in modifier rows.' },
  hubWheels: { kind: 'table', header: ['name', 'group', 'node1:', 'node2:', 'nodeS', 'nodeArm:', 'wheelDir'], doc: 'Hub-only wheels (no tyre).' },
  wheels: { kind: 'table', header: ['name', 'group', 'node1:', 'node2:', 'nodeS', 'nodeArm:', 'wheelDir'], doc: 'Legacy wheels.' },
  rotators: { kind: 'table', header: ['name', '[group]:', 'node1:', 'node2:', 'nodeS', 'nodeArm:', 'wheelDir'], doc: 'Rotating node groups driven by the powertrain (e.g. brake rotors without tyres).' },
  triggers: { kind: 'table', header: ['id', 'label', 'idRef:', 'idX:', 'idY:', 'type', 'size', 'baseRotation', 'rotation', 'translation', 'baseTranslation'], doc: 'Legacy clickable triggers. Prefer `triggers2`.' },
  triggers2: { kind: 'table', header: ['id', 'idRef:', 'idX:', 'idY:', 'type', 'size', 'baseRotation', 'rotation', 'translation', 'baseTranslation'], doc: 'Clickable interaction zones (box or sphere). `baseTranslationGlobal` places them in vehicle coordinates.' },
  triggerEventLinks2: { kind: 'table', header: ['triggerId:triggers2', 'triggerInput', 'inputAction'], doc: 'Links a trigger input (`action0`, `action1`...) to an action (generic, `common:...` or custom).' },
  actionsEnabled: { kind: 'table', header: ['id'], doc: 'Generic / custom actions used by this part (not needed for `common:` actions).' },
  controller: { kind: 'table', header: ['fileName'], doc: 'Lua controllers loaded for this part.' },
  powertrain: { kind: 'table', header: ['type', 'name', 'inputName', 'inputIndex'], doc: 'Powertrain devices and how they connect.' },
  cameraExternal: { kind: 'dict', doc: 'Orbit camera settings: `distance`, `distanceMin`, `offset`, `fov`.' },
  camerasInternal: { kind: 'table', header: ['type', 'x', 'y', 'z', 'fov', 'id1:', 'id2:', 'id3:', 'id4:', 'id5:', 'id6:'], doc: 'Interior cameras attached to nodes.' },
  glowMap: { kind: 'dict', doc: 'Material swaps driven by electrics (`simpleFunction`, `off`, `on`, `on_intense`).' },
  sounds: { kind: 'dict', doc: 'Sound settings (`cabinFilterCoef`, ...).' },
  occupantSystem: { kind: 'dict', doc: 'Enables the 0.40 occupant system: `{"enabled": true, "version": 1}`.' },
  components: { kind: 'dict', doc: 'Shared data merged across all parts, readable as `$components.a.b` in expressions.' },
  thrusters: { kind: 'table', header: ['id1:', 'id2:', 'factor', 'thrustLimit'], doc: 'Force between two nodes driven by an input.' },
  ropes: { kind: 'table', header: ['id1:', 'id2:', 'segments', 'length'], doc: 'Segmented ropes generated between nodes.' },
  couplers: { kind: 'dict', doc: 'Coupler definitions.' },
  vehicleController: { kind: 'dict', doc: 'Vehicle controller settings.' },
  engine: { kind: 'dict', doc: 'Legacy engine data.' },
  mainEngine: { kind: 'dict', doc: 'Combustion engine powertrain device data.' },
  gearbox: { kind: 'dict', doc: 'Gearbox powertrain device data.' },
  paints: { kind: 'dict', doc: 'Default paints.' },
  scriptTriggers: { kind: 'table', header: ['id', 'type'], doc: 'Lua triggers.' },
  soundscape: { kind: 'table', header: ['name', 'src'], doc: 'Sound emitter locations (`{"node:": "..."}`).' },
  mirrors: { kind: 'table', header: ['mesh', 'idRef:', 'id1:', 'id2:'], doc: 'Mirror cameras.' },
  licenseplates: { kind: 'table', header: ['mesh', 'idRef:'], doc: 'License plate meshes.' },
};

export const KEYS: Record<string, string> = {
  // nodes
  nodeWeight: 'Node mass in kg (default 25).',
  nodeMaterial: 'Surface material for sounds/particles, e.g. `|NM_METAL`, `|NM_RUBBER`, `|NM_PLASTIC`.',
  frictionCoef: 'Friction coefficient against the ground / other objects.',
  collision: 'Node collides with the world (default true).',
  selfCollision: 'Node collides with this vehicle\'s triangles (default false).',
  staticCollision: 'Node collides with static geometry (default true).',
  group: 'Node group(s) — used by flexbodies, wheels, etc. String or list.',
  fixed: 'Node is fixed in space (debugging / props).',
  surfaceCoef: 'Surface coefficient for drag.',
  volumeCoef: 'Volume coefficient for buoyancy.',
  chemEnergy: 'Combustible energy.',
  burnRate: 'Burn rate when on fire.',
  flashPoint: 'Ignition temperature.',
  specHeat: 'Specific heat.',
  smokePoint: 'Temperature where smoke starts.',
  selfCollisionGroup: 'Self collision group id.',
  pairedNode: 'Paired node for collision.',
  // beams
  beamSpring: 'Spring stiffness in N/m (default 4300000).',
  beamDamp: 'Damping in N·s/m (default 580).',
  beamDeform: 'Force (N) at which the beam starts deforming plastically (default 220000).',
  beamStrength: 'Force (N) at which the beam breaks (default FLT_MAX).',
  beamType: 'Beam type: `|NORMAL`, `|ANISOTROPIC`, `|BOUNDED`, `|SUPPORT`, `|PRESSURED`, `|HYDRO`, `|LBEAM`, `|BROKEN`.',
  beamPrecompression: 'Rest length factor relative to spawn length (1 = spawn length).',
  beamPrecompressionTime: 'Time (s) to reach the precompressed length.',
  beamShortBound: 'BOUNDED: compression limit (fraction of length).',
  beamLongBound: 'BOUNDED: extension limit (fraction of length).',
  beamLimitSpring: 'BOUNDED: stiffness beyond the bounds.',
  beamLimitDamp: 'BOUNDED: damping beyond the bounds.',
  beamLimitDampRebound: 'BOUNDED: rebound damping beyond the bounds.',
  beamDampRebound: 'Rebound damping (bounded beams).',
  beamDampFast: 'Fast compression damping.',
  beamDampReboundFast: 'Fast rebound damping.',
  beamDampVelocitySplit: 'Velocity where slow/fast damping split.',
  springExpansion: 'ANISOTROPIC: stiffness when extending.',
  dampExpansion: 'ANISOTROPIC: damping when extending.',
  transitionZone: 'ANISOTROPIC: blend zone.',
  deformLimit: 'Max deformation (compression) before the beam stops deforming.',
  deformLimitExpansion: 'Max deformation (extension).',
  deformationTriggerRatio: 'Deformation ratio that triggers the deformGroup.',
  deformGroup: 'Deform group(s) triggered when this beam deforms (breaks glass, lights...).',
  breakGroup: 'Beams in the same breakGroup break together.',
  breakGroupType: '`1` = breaks only when another beam of the group breaks.',
  optional: 'Row is skipped silently when a referenced node is missing.',
  disable: 'Disables the row.',
  precompressionRange: 'Precompression in metres.',
  boundZone: 'Bounded beam zone.',
  // flexbodies / props
  pos: 'Position offset `{x, y, z}` (m).',
  rot: 'Rotation `{x, y, z}` (degrees).',
  scale: 'Scale `{x, y, z}`.',
  materialOverride: 'Material swaps: `[["original","replacement"]]`.',
  deformMaterialBase: 'Material swapped when the deformGroup triggers.',
  deformMaterialDamaged: 'Damaged material after the deformGroup triggers.',
  deformSound: 'Sound when deformed.',
  baseTranslation: 'Offset in the node frame (m).',
  baseTranslationGlobal: 'Position in vehicle coordinates; overrides baseTranslation.',
  baseRotation: 'Base rotation (degrees).',
  translationGlobal: 'Global translation axis.',
  lightRange: 'Light range (m).',
  lightInnerAngle: 'Spotlight inner cone angle (deg).',
  lightOuterAngle: 'Spotlight outer cone angle (deg).',
  lightBrightness: 'Light brightness.',
  lightColor: 'Light colour `{r, g, b, a}` 0–255.',
  lightCastShadows: 'Cast shadows.',
  flareName: 'Lens flare.',
  flareScale: 'Lens flare scale.',
  // wheels
  radius: 'Tyre radius (m).',
  hubRadius: 'Hub radius (m).',
  tireWidth: 'Tyre width (m).',
  hubWidth: 'Hub width (m).',
  numRays: 'Number of rays (tread nodes per side).',
  wheelOffset: 'Offset of the wheel centre along the axle (m).',
  pressurePSI: 'Tyre pressure (psi).',
  hasTire: 'Generate a tyre.',
  enableTireLbeams: 'Tyre L-beams.',
  enableTireSideReinfBeams: 'Tyre side reinforcement beams.',
  enableTireReinfBeams: 'Tyre reinforcement beams.',
  enableTreadReinfBeams: 'Tread reinforcement beams.',
  enableTirePeripheryReinfBeams: 'Periphery reinforcement beams.',
  enableHubcaps: 'Hubcap nodes.',
  wheelDir: 'Wheel spin direction (1 / -1).',
  nodeArm: 'Node the brake torque reacts against.',
  brakeTorque: 'Brake torque (N·m).',
  parkingTorque: 'Parking brake torque.',
  brakeSpring: 'Brake spring.',
  hubNodeWeight: 'Hub node mass.',
  tireWeight: 'Total tyre mass (kg).',
  hubWeight: 'Total hub mass (kg).',
  tireTreadCoef: 'Tread coefficient.',
  enableBrakeThermals: 'Brake heating model.',
  // nodeOffset & co
  nodeOffset: 'Shifts nodes (x mirrored by side). Applied to the child parts of the slot.',
  nodeMove: 'Moves nodes by `{x, y, z}` (not mirrored).',
  nodeRotate: 'Rotates nodes `{x, y, z}` degrees (optional pivot `px, py, pz`).',
  coreSlot: 'Slot cannot be emptied in the UI.',
  // hydro
  inputSource: 'Electrics value driving the hydro (e.g. `steering`).',
  inputFactor: 'Input multiplier.',
  inRate: 'Contraction speed.',
  outRate: 'Extension speed.',
  inLimit: 'Min length factor.',
  outLimit: 'Max length factor.',
  factor: 'Length change factor (+/- relative).',
  autoCenterRate: 'Return-to-centre speed.',
  extentFactor: 'Extent in metres.',
  inExtent: 'Contraction extent (m).',
  outExtent: 'Extension extent (m).',
};

export const BEAM_TYPES = ['|NORMAL', '|ANISOTROPIC', '|BOUNDED', '|SUPPORT', '|PRESSURED', '|HYDRO', '|LBEAM', '|BROKEN'];
export const NODE_MATERIALS = ['|NM_METAL', '|NM_PLASTIC', '|NM_RUBBER', '|NM_GLASS', '|NM_WOOD', '|NM_FOLIAGE', '|NM_CLOTH', '|NM_ASPHALT'];


/**
 * Trigger actions for triggerEventLinks2, from the game files: "common:" = the vehicle input
 * actions (lua/ge/extensions/core/input/actions/vehicle.json, no actionsEnabled needed), generic =
 * vehicles/common/common_default.interaction.json (listed in actionsEnabled; most need the
 * matching coupler name). Labels are what the menu shows.
 */
export interface ActionDef {
  id: string;
  label: string;
}
export interface ActionGroup {
  group: string;
  actions: ActionDef[];
}

const A = (id: string, label: string): ActionDef => ({ id, label });

export const TRIGGER_ACTIONS: ActionGroup[] = [
  { group: 'Lights', actions: [
    A('common:toggle_headlights', 'Headlights'), A('common:highbeam', 'High beam'), A('common:toggle_foglights', 'Fog lights'),
    A('common:toggle_left_signal', 'Left signal'), A('common:toggle_right_signal', 'Right signal'), A('common:toggle_hazard_signal', 'Hazard lights'),
    A('common:toggle_lightbar_signal', 'Lightbar'), A('common:toggleLightbarMode', 'Lightbar mode'), A('common:toggle_underglow', 'Underglow'),
    A('toggle_lowbeam', 'Low beam (generic)'), A('toggle_highbeam', 'High beam (generic)'),
  ] },
  { group: 'Ignition & horn', actions: [
    A('common:activateStarterMotor', 'Starter motor'), A('common:setIgnitionLevel3Momentary', 'Key to start (momentary)'),
    A('common:setIgnitionLevel0', 'Ignition off'), A('common:setIgnitionLevel1', 'Ignition accessory'), A('common:setIgnitionLevel2', 'Ignition on'),
    A('common:setIgnitionLevel3', 'Ignition start'), A('common:setIgnitionLevel1Momentary', 'Ignition accessory (momentary)'),
    A('common:setIgnitionLevel2Momentary', 'Ignition on (momentary)'), A('common:horn', 'Horn'), A('common:enterSeat', 'Enter seat'),
  ] },
  { group: 'Brakes', actions: [
    A('common:parkingbrake_toggle', 'Parking brake (toggle)'), A('common:parkingbrake', 'Parking brake (hold)'),
    A('common:parkingbrake_temporary', 'Parking brake (hydraulic handbrake)'), A('parkingBrake_on', 'Parking brake pedal: on'), A('parkingBrake_off', 'Parking brake pedal: release'),
    A('common:toggleTransbrake', 'Transbrake'), A('common:toggleLineLock', 'Line lock'),
  ] },
  { group: 'Gearbox', actions: [
    A('common:shiftUp', 'Shift up'), A('common:shiftDown', 'Shift down'), A('common:gearN', 'Neutral'), A('common:gearR', 'Reverse'),
    A('common:gear1', 'Gear 1'), A('common:gear2', 'Gear 2'), A('common:gear3', 'Gear 3'), A('common:gear4', 'Gear 4'), A('common:gear5', 'Gear 5'), A('common:gear6', 'Gear 6'),
    A('common:toggleShifterMode', 'Shifter mode'),
  ] },
  { group: 'Driving aids', actions: [
    A('common:toggleESCMode', 'ESC on / off'), A('common:nextESCMode', 'Next ESC mode'), A('common:previousESCMode', 'Previous ESC mode'),
    A('common:toggleTwoStep', 'Two-step'), A('common:increaseTwoStepRPM', 'Two-step RPM up'), A('common:decreaseTwoStepRPM', 'Two-step RPM down'),
    A('common:toggleNitrousOxide', 'Nitrous'), A('common:toggleDiffMode', 'Diff mode'), A('common:toggle4WDStatus', '4WD'), A('common:toggleRangeStatus', 'Range'),
    A('common:set_cc_speed', 'Cruise control: set'), A('common:reset_cc_speed', 'Cruise control: resume'), A('common:increase_cc_speed', 'Cruise control faster'),
    A('common:decrease_cc_speed', 'Cruise control slower'), A('common:disable_cc', 'Cruise control off'), A('basicCruiseCointrol', 'Basic cruise control'),
  ] },
  { group: 'Doors & openables', actions: [
    A('door_FL', 'Door FL'), A('door_FR', 'Door FR'), A('door_RL', 'Door RL'), A('door_RR', 'Door RR'), A('door_L', 'Door L'), A('door_R', 'Door R'),
    A('door_RL_half', 'Door RL (half)'), A('door_RR_half', 'Door RR (half)'), A('door_rear', 'Rear door'),
    A('sidedoor', 'Side door'), A('sidedoor_F', 'Side door front'), A('sidedoor_R', 'Side door rear'),
    A('barndoor_L', 'Barn door L'), A('barndoor_R', 'Barn door R'), A('barndoor_RL', 'Barn door RL'), A('barndoor_RR', 'Barn door RR'),
    A('hoodCatch', 'Hood catch (outside)'), A('hoodRelease', 'Hood release (inside)'),
    A('trunk', 'Trunk'), A('decklid', 'Decklid'), A('hatch', 'Hatch'), A('tailgate', 'Tailgate'), A('tailgate_lower', 'Tailgate lower'), A('tailgate_upper', 'Tailgate upper'),
    A('tailgateCatch', 'Tailgate catch'), A('tailgateRelease', 'Tailgate release'), A('toggle_cargodoorRL', 'Cargo door L'), A('toggle_cargodoorRR', 'Cargo door R'),
    A('spareholder', 'Spare holder'), A('folding_step', 'Folding step'), A('roofbox', 'Roof box'),
    A('sunvisor_L_open', 'Sun visor L open'), A('sunvisor_L_close', 'Sun visor L close'), A('sunvisor_R_open', 'Sun visor R open'), A('sunvisor_R_close', 'Sun visor R close'),
  ] },
  { group: 'Drivetrain', actions: [
    A('toggleFrontDiff', 'Front diff lock'), A('toggleRearDiff', 'Rear diff lock'), A('toggleInteraxleDiff', 'Centre diff lock'),
    A('toggleRangebox', 'Range box'), A('setRangeboxLow', 'Range box low'), A('setRangeboxHigh', 'Range box high'),
    A('toggleTransfercase', 'Transfer case'), A('setTransfercase2hi', 'Transfer case 2H'), A('setTransfercase4hi', 'Transfer case 4H'), A('setTransfercase4lo', 'Transfer case 4L'),
    A('toggleCompressionBrake', 'Compression brake'), A('increaseRetarderLevel', 'Retarder up'), A('decreaseRetarderLevel', 'Retarder down'),
  ] },
  { group: 'Police', actions: [
    A('toggle_lightbar', 'Lightbar'), A('toggle_siren', 'Siren'), A('toggle_lightbar_siren', 'Lightbar and siren'), A('toggle_beacon', 'Beacon'),
    A('toggle_lightbar_mode', 'Lightbar mode'), A('lightbar_setmode_1', 'Lightbar mode 1'), A('lightbar_setmode_2', 'Lightbar mode 2'),
    A('lightbar_setmode_3', 'Lightbar mode 3'), A('lightbar_setmode_4', 'Lightbar mode 4'),
  ] },
  { group: 'Trucks & trailers', actions: [
    A('towHitchToggle', 'Tow hitch'), A('gooseneckToggle', 'Gooseneck'), A('pintleHitchToggle', 'Pintle hitch'), A('fifthwheelDecouple', 'Fifth wheel decouple'),
    A('fifthwheelSliderLock', 'Fifth wheel slider lock'), A('fifthwheelTiltLock', 'Fifth wheel tilt lock'), A('feet_up', 'Trailer feet up'), A('feet_down', 'Trailer feet down'),
    A('toggleTrailerAirSupply', 'Trailer air supply'), A('liftAxle_toggle', 'Lift axle'), A('toggleManualIdleRaise', 'Idle raise'),
    A('tilt', 'Upfit tilt'), A('extendRetract', 'Upfit extend / retract'), A('dumpTailgateLock', 'Dump tailgate lock'),
  ] },
  { group: 'Hydraulics', actions: [
    A('hydraulics_jump_full', 'Hop all'), A('hydraulics_jump_front', 'Hop front'), A('hydraulics_jump_rear', 'Hop rear'),
    A('hydraulics_jump_left', 'Hop left'), A('hydraulics_jump_right', 'Hop right'), A('hydraulics_raise_full', 'Raise all'), A('hydraulics_lower_full', 'Lower all'),
  ] },
];

/** "common:" input actions (no actionsEnabled entry) and generic interaction actions */
export const COMMON_ACTIONS = TRIGGER_ACTIONS.flatMap((g) => g.actions.map((a) => a.id)).filter((a) => a.startsWith('common:'));
export const GENERIC_ACTIONS = TRIGGER_ACTIONS.flatMap((g) => g.actions.map((a) => a.id)).filter((a) => !a.startsWith('common:'));

/** id -> label, for every catalogued action */
export const ACTION_LABEL = new Map(TRIGGER_ACTIONS.flatMap((g) => g.actions.map((a) => [a.id, a.label] as const)));

/** Light roles for the Lights tool: bulb, electrics value, direction and names. */
export interface LightRole {
  id: string;
  label: string;
  bulb: string;
  electric: string;
  /** slot name token: <car>_<token>_<side>_bulb */
  token: string;
  /** description: "<Side> <desc> bulb" */
  desc: string;
  /** rotation on the left (+X) side; the right side is mirrored */
  rot: { x: number; y: number; z: number };
  /** headlight beam pattern (LHD / RHD / US) applies */
  pattern?: boolean;
  /** small lights: short range, wide cone */
  small?: boolean;
  /** usually one light on the centre line */
  centre?: boolean;
}

export const LIGHT_ROLES: LightRole[] = [
  { id: 'low', label: 'Low beam', bulb: 'headlightBulb_halogen_55W', electric: 'lowhighbeam', token: 'headlight_low', desc: 'lowbeam headlight', rot: { x: 0, y: 0, z: 180 }, pattern: true },
  { id: 'high', label: 'High beam', bulb: 'headlightBulb_halogen_60W', electric: 'highbeam', token: 'headlight_high', desc: 'highbeam headlight', rot: { x: 0, y: 0, z: 180 }, pattern: true },
  { id: 'signalF', label: 'Front signal', bulb: 'incandescent_amber_21W', electric: 'signal_L', token: 'signal_F', desc: 'front signal', rot: { x: 0, y: 0, z: 150 } },
  { id: 'tail', label: 'Tail / brake', bulb: 'incandescent_red_21W', electric: 'brakelights', token: 'taillight', desc: 'taillight', rot: { x: 0, y: 0, z: 20 } },
  { id: 'signalR', label: 'Rear signal', bulb: 'incandescent_red_21W', electric: 'signal_L', token: 'signal_R', desc: 'rear signal', rot: { x: 0, y: 0, z: 20 } },
  { id: 'reverse', label: 'Reverse', bulb: 'incandescent_white_21W', electric: 'reverse', token: 'reverse', desc: 'reverse light', rot: { x: 0, y: 0, z: 0 } },
  { id: 'fog', label: 'Fog', bulb: 'incandescent_white_55W', electric: 'fog', token: 'foglight', desc: 'fog light', rot: { x: 0, y: 0, z: 180 } },
  { id: 'markerF', label: 'Marker front', bulb: 'incandescent_amber_5W', electric: 'lowhighbeam', token: 'marker_F', desc: 'front side marker', rot: { x: 0, y: 0, z: -270 }, small: true },
  { id: 'markerR', label: 'Marker rear', bulb: 'incandescent_red_5W', electric: 'lowhighbeam', token: 'marker_R', desc: 'rear side marker', rot: { x: 0, y: 0, z: -270 }, small: true },
  { id: 'plate', label: 'Plate', bulb: 'incandescent_white_5W', electric: 'lowhighbeam', token: 'licenseplate', desc: 'license plate light', rot: { x: 100, y: 0, z: 0 }, small: true, centre: true },
  { id: 'interior', label: 'Interior', bulb: 'incandescent_white_5W', electric: 'lowhighbeam', token: 'interior', desc: 'interior light', rot: { x: 90, y: 0, z: 0 }, small: true, centre: true },
  { id: 'trunk', label: 'Trunk', bulb: 'incandescent_white_5W', electric: 'lowhighbeam', token: 'trunk', desc: 'trunk light', rot: { x: 90, y: 0, z: 0 }, small: true, centre: true },
];

/** electrics values a bulb usually reads (custom ones from the vehicle are added in the tool) */
export const COMMON_ELECTRICS = ['lowhighbeam', 'lowbeam', 'highbeam', 'brakelights', 'reverse', 'fog', 'signal_L', 'signal_R', 'hazard', 'parkingbrake', 'lightbar'];

export const BULB_TYPES = [
  { id: 'headlightBulb_halogen_55W', use: 'Low beam' },
  { id: 'headlightBulb_halogen_60W', use: 'High beam' },
  { id: 'incandescent_amber_21W', use: 'Front signal' },
  { id: 'incandescent_red_21W', use: 'Brake / tail / rear signal' },
  { id: 'incandescent_white_21W', use: 'Reverse' },
  { id: 'incandescent_amber_5W', use: 'Front side marker' },
  { id: 'incandescent_red_5W', use: 'Rear side marker' },
  { id: 'incandescent_white_5W', use: 'Plate / trunk / cabin' },
  { id: 'incandescent_white_55W', use: 'Fog light' },
];
