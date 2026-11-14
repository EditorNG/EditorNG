/**
 * Update logic that does not touch the system: which GitHub release to offer, and how its notes
 * become a changelog (headline features first, small improvements and fixes after).
 *
 * Release notes convention (GitHub release body, Markdown):
 *   ## New                      → headline features
 *   ### Feature title           → one feature, the paragraph under it is its description
 *   - **Feature title**: text   → also one feature
 *   ## Improvements             → small changes, one bullet each
 *   ## Fixes                    → bug fixes, one bullet each
 * Sections about downloading / installing are skipped in the app. Older notes with one
 * "What's in x.y.z" list are read too: bold-led bullets become features, the rest improvements.
 */

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  /** "sha256:<hex>" when GitHub provides it */
  digest?: string;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  date: string;
  body: string;
  url: string;
  asset?: ReleaseAsset;
}

/** "v0.2.13" / "0.2.13" → [0, 2, 13]; null when it is not a plain version (pre-releases included). */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The release asset EditorNG updates from: the portable Windows zip. */
export const ASSET_RE = /^EditorNG-\d+\.\d+\.\d+-win64\.zip$/i;

/** GitHub "list releases" JSON → published, non-pre-release releases newer than `current`, newest first. */
export function newerReleases(json: unknown, current: string): ReleaseInfo[] {
  if (!Array.isArray(json)) return [];
  const out: ReleaseInfo[] = [];
  for (const r of json as any[]) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string') continue;
    if (!parseVersion(r.tag_name) || compareVersions(r.tag_name, current) <= 0) continue;
    const a = (Array.isArray(r.assets) ? r.assets : []).find((x: any) => typeof x?.name === 'string' && ASSET_RE.test(x.name) && x.state !== 'starter');
    out.push({
      version: r.tag_name.replace(/^v/, ''),
      tag: r.tag_name,
      name: typeof r.name === 'string' && r.name ? r.name : `EditorNG ${r.tag_name.replace(/^v/, '')}`,
      date: r.published_at ?? r.created_at ?? '',
      body: typeof r.body === 'string' ? r.body : '',
      url: r.html_url ?? '',
      asset: a ? { name: a.name, size: +a.size || 0, url: a.browser_download_url, digest: typeof a.digest === 'string' ? a.digest : undefined } : undefined,
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

// ------------------------------------------------------------------------------------------
// changelog
// ------------------------------------------------------------------------------------------

export interface Feature {
  title: string;
  text: string;
  version: string;
}

export interface Changelog {
  features: Feature[];
  improvements: Array<{ text: string; version: string }>;
  fixes: Array<{ text: string; version: string }>;
}

type Kind = 'features' | 'improvements' | 'fixes' | 'mixed' | 'skip';

function kindOf(heading: string): Kind {
  const h = heading.toLowerCase();
  if (/download|install|how to|getting started|requirements/.test(h)) return 'skip';
  if (/fix|bug/.test(h)) return 'fixes';
  if (/improve|change|tweak|polish|small|other/.test(h)) return 'improvements';
  if (/^new|new feature|feature|highlight/.test(h)) return 'features';
  return 'mixed';
}

/** One release body → changelog entries. */
export function parseChangelog(body: string, version = ''): Changelog {
  const out: Changelog = { features: [], improvements: [], fixes: [] };
  let kind: Kind = 'mixed';
  let feature: Feature | null = null;
  const lines = body.replace(/\r/g, '').split('\n');
  const flush = () => {
    if (feature) {
      feature.text = feature.text.trim();
      out.features.push(feature);
    }
    feature = null;
  };
  // continuation lines of a bullet (indented, not a new bullet) are joined to it
  const items: Array<{ kind: Kind; text: string; h3?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      flush();
      kind = kindOf(h2[1]);
      continue;
    }
    if (kind === 'skip') continue;
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) {
      flush();
      feature = { title: h3[1].trim(), text: '', version };
      continue;
    }
    const b = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
    if (b) {
      flush();
      let text = b[1];
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*[-*]\s/.test(lines[i + 1])) text += ' ' + lines[++i].trim();
      items.push({ kind, text });
      continue;
    }
    if (feature && line.trim()) feature.text += (feature.text ? ' ' : '') + line.trim();
  }
  flush();
  for (const it of items) {
    const bold = /^\*\*(.+?)\*\*[:.\s—–-]*\s*(.*)$/.exec(it.text);
    if (it.kind === 'features' || (it.kind === 'mixed' && bold)) {
      if (bold) out.features.push({ title: bold[1].replace(/[:.]$/, ''), text: bold[2], version });
      else out.features.push({ title: '', text: it.text, version });
    } else if (it.kind === 'fixes') out.fixes.push({ text: it.text, version });
    else out.improvements.push({ text: it.text, version });
  }
  return out;
}

/** Changelog of every release since the running version (newest first). */
export function combinedChangelog(releases: ReleaseInfo[]): Changelog {
  const out: Changelog = { features: [], improvements: [], fixes: [] };
  for (const r of releases) {
    const c = parseChangelog(r.body, r.version);
    out.features.push(...c.features);
    out.improvements.push(...c.improvements);
    out.fixes.push(...c.fixes);
  }
  return out;
}
