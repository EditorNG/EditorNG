bl_info = {
    "name": "EditorNG Link",
    "author": "EditorNG",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "3D Viewport > Sidebar (N) > EditorNG",
    "description": "Send mesh objects (vertices, edges, faces) to EditorNG as JBeam nodes, beams and triangles",
    "category": "Import-Export",
}

import bpy
import json
import urllib.request

_last_hash = None


def _payload(context, selected_only):
    depsgraph = context.evaluated_depsgraph_get()
    objs = context.selected_objects if selected_only else context.visible_objects
    out = []
    for obj in objs:
        if obj.type != 'MESH':
            continue
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
            groups = [g.name for g in obj.vertex_groups]
            vg = []
            for v in me.vertices:
                best, bw = -1, 0.0
                for g in v.groups:
                    if g.weight > bw:
                        best, bw = g.group, g.weight
                vg.append(best)
            out.append({'name': obj.name, 'verts': verts, 'edges': edges, 'tris': tris, 'looseEdges': [],
                        'vertexGroups': groups, 'vertGroup': vg, 'collection': ''})
        finally:
            ev.to_mesh_clear()
    return {'ok': True, 'blenderVersion': bpy.app.version_string, 'objects': out}


def _send(context):
    port = context.scene.editorng_port
    data = json.dumps(_payload(context, context.scene.editorng_selected_only)).encode('utf-8')
    req = urllib.request.Request(f'http://127.0.0.1:{port}/import', data=data, headers={'Content-Type': 'application/json'}, method='POST')
    urllib.request.urlopen(req, timeout=3).read()
    return len(data)


class EDITORNG_OT_send(bpy.types.Operator):
    bl_idname = "editorng.send"
    bl_label = "Send to EditorNG"
    bl_description = "Send the mesh objects to EditorNG's import dialog"

    def execute(self, context):
        try:
            n = _send(context)
            self.report({'INFO'}, f"Sent {n // 1024} KB to EditorNG")
        except Exception as e:
            self.report({'ERROR'}, f"EditorNG not reachable on port {context.scene.editorng_port}: {e}")
            return {'CANCELLED'}
        return {'FINISHED'}


def _auto_timer():
    global _last_hash
    ctx = bpy.context
    scene = getattr(ctx, 'scene', None)
    if scene is None or not scene.editorng_auto:
        return 1.0
    try:
        payload = json.dumps(_payload(ctx, scene.editorng_selected_only))
        h = hash(payload)
        if h != _last_hash:
            _last_hash = h
            req = urllib.request.Request(f'http://127.0.0.1:{scene.editorng_port}/import', data=payload.encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST')
            urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
    return 1.0


class EDITORNG_PT_panel(bpy.types.Panel):
    bl_label = "EditorNG"
    bl_idname = "EDITORNG_PT_panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "EditorNG"

    def draw(self, context):
        s = context.scene
        col = self.layout.column(align=True)
        col.operator("editorng.send", icon='EXPORT')
        col.prop(s, "editorng_selected_only")
        col.prop(s, "editorng_auto")
        col.prop(s, "editorng_port")
        self.layout.label(text="Vertices > nodes, edges > beams,")
        self.layout.label(text="faces > collision triangles.")


def register():
    bpy.types.Scene.editorng_port = bpy.props.IntProperty(name="Port", default=46790, min=1024, max=65535)
    bpy.types.Scene.editorng_selected_only = bpy.props.BoolProperty(name="Selected objects only", default=True)
    bpy.types.Scene.editorng_auto = bpy.props.BoolProperty(name="Auto-send on change", default=False)
    bpy.utils.register_class(EDITORNG_OT_send)
    bpy.utils.register_class(EDITORNG_PT_panel)
    if not bpy.app.timers.is_registered(_auto_timer):
        bpy.app.timers.register(_auto_timer, first_interval=1.0, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_auto_timer):
        bpy.app.timers.unregister(_auto_timer)
    bpy.utils.unregister_class(EDITORNG_PT_panel)
    bpy.utils.unregister_class(EDITORNG_OT_send)
    del bpy.types.Scene.editorng_port
    del bpy.types.Scene.editorng_selected_only
    del bpy.types.Scene.editorng_auto
