# EditorNG: headless mesh extraction.
# Usage: blender -b file.blend --python extract_mesh.py -- output.json
# Writes every visible mesh object (modifiers applied, world space) as vertices / edges / triangles.
import bpy
import json
import sys


def mesh_payload(obj, depsgraph):
    ev = obj.evaluated_get(depsgraph)
    me = ev.to_mesh()
    try:
        mw = obj.matrix_world
        verts = []
        for v in me.vertices:
            co = mw @ v.co
            verts.extend((round(co.x, 6), round(co.y, 6), round(co.z, 6)))
        edges = []
        for e in me.edges:
            edges.extend((e.vertices[0], e.vertices[1]))
        me.calc_loop_triangles()
        tris = []
        for t in me.loop_triangles:
            tris.extend((t.vertices[0], t.vertices[1], t.vertices[2]))
        face_edges = set()
        for p in me.polygons:
            for k in p.edge_keys:
                face_edges.add(tuple(sorted(k)))
        loose = [i for i, e in enumerate(me.edges) if tuple(sorted(e.vertices)) not in face_edges]
        groups = [g.name for g in obj.vertex_groups]
        vert_group = []
        for v in me.vertices:
            best, bw = -1, 0.0
            for g in v.groups:
                if g.weight > bw:
                    best, bw = g.group, g.weight
            vert_group.append(best)
        coll = obj.users_collection[0].name if obj.users_collection else ''
        return {
            'name': obj.name,
            'verts': verts,
            'edges': edges,
            'tris': tris,
            'looseEdges': loose,
            'vertexGroups': groups,
            'vertGroup': vert_group,
            'collection': coll,
        }
    finally:
        ev.to_mesh_clear()


def main():
    argv = sys.argv
    out = argv[argv.index('--') + 1] if '--' in argv else 'editorng_mesh.json'
    depsgraph = bpy.context.evaluated_depsgraph_get()
    objects = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        if obj.hide_get() or obj.hide_viewport:
            continue
        objects.append(mesh_payload(obj, depsgraph))
    data = {'ok': True, 'blenderVersion': bpy.app.version_string, 'objects': objects}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f)


main()
