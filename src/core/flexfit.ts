/**
 * Which node groups a flexbody should follow. The game binds each mesh vertex to the nearest
 * nodes of the listed groups, so the groups whose nodes are nearest to the mesh's vertices are
 * the ones it needs: every (sampled) vertex votes for the groups of its nearest node.
 */

export interface FitNode {
  x: number;
  y: number;
  z: number;
  groups: string[];
}

export interface GroupScore {
  group: string;
  /** share of the sampled vertices whose nearest node is in this group (0..1) */
  share: number;
  /** nodes of this group */
  nodes: number;
  suggested: boolean;
}

/**
 * @param pos mesh vertex positions (x, y, z…), vehicle coordinates
 * @param maxDist vertices farther than this from every node do not vote (metres)
 */
export function scoreGroups(pos: ArrayLike<number>, nodes: FitNode[], own?: Set<string>, maxSamples = 2500, maxDist = 0.35): GroupScore[] {
  const counts = new Map<string, number>();
  for (const n of nodes) for (const g of n.groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  const grouped = nodes.filter((n) => n.groups.length);
  const nv = Math.floor(pos.length / 3);
  if (!nv || !grouped.length) return [];
  const step = Math.max(1, Math.floor(nv / maxSamples));
  const votes = new Map<string, number>();
  let voters = 0;
  const max2 = maxDist * maxDist;
  for (let i = 0; i < nv; i += step) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let best: FitNode | null = null;
    let bd = Infinity;
    for (const n of grouped) {
      const dx = n.x - x, dy = n.y - y, dz = n.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (!best || bd > max2) continue;
    voters++;
    for (const g of best.groups) votes.set(g, (votes.get(g) ?? 0) + 1);
  }
  const out: GroupScore[] = [...votes].map(([group, v]) => ({ group, share: voters ? v / voters : 0, nodes: counts.get(group) ?? 0, suggested: false }));
  out.sort((a, b) => b.share - a.share);
  // the groups that carry a real part of the mesh (and always the main one); groups of the part
  // the flexbody goes in need less (they usually are what it should follow)
  for (const s of out) s.suggested = s.share >= 0.2 || (!!own?.has(s.group) && s.share >= 0.05);
  if (out.length) out[0].suggested = true;
  return out;
}
