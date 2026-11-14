import { expect, it } from 'vitest';
import { scanDae } from '../src/core/dae';

const dae = `<COLLADA>
<library_geometries>
  <geometry id="mesh_1" name="mesh_1"><mesh/></geometry>
  <geometry id="mesh_2" name="mesh_2"><mesh/></geometry>
  <geometry id="orphan_geo" name="orphan_geo"><mesh/></geometry>
</library_geometries>
<library_visual_scenes><visual_scene id="Scene">
  <node id="car_hood" name="car_hood" type="NODE">
    <matrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix>
    <instance_geometry url="#mesh_1" name="car_hood"/>
  </node>
  <node id="rig" name="rig" type="NODE">
    <node id="car_door_L" name="car_door_L" type="NODE"><instance_geometry url="#mesh_2"/></node>
  </node>
  <node id="empty" name="empty" type="NODE"/>
</visual_scene></library_visual_scenes>
</COLLADA>`;

it('lists objects by name, not their exporter-named geometry', () => {
  const r = scanDae(dae);
  expect(r.meshes.sort()).toEqual(['car_door_L', 'car_hood', 'orphan_geo']);
  // every name still resolves (the 3D view finds meshes referenced either way)
  for (const n of ['car_hood', 'car_door_L', 'rig', 'empty', 'mesh_1', 'mesh_2', 'orphan_geo']) expect(r.names).toContain(n);
});
