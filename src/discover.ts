import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

/**
 * Find the skills and agents already installed on this machine.
 *
 * You should not have to remember what you have. `skillflow list` prints what
 * can go in a workflow, and the names it prints are the names a node uses.
 */

export interface Discovered {
  name: string;
  description: string;
  /** Where it came from, for display: "user", "project", or a plugin name. */
  source: string;
  path: string;
}

function frontmatter(file: string): { name?: string; description?: string } {
  try {
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith('---')) return {};
    const end = text.indexOf('\n---', 3);
    if (end === -1) return {};

    // Deliberately not a full YAML parse: this frontmatter is two keys, and
    // pulling in a parser to read them would be the wrong trade. It does have to
    // handle folded and literal block scalars though, because skill authors use
    // them constantly for long descriptions and a naive reader returns ">".
    const lines = text.slice(3, end).split('\n');
    const out: Record<string, string> = {};

    for (let i = 0; i < lines.length; i += 1) {
      const match = /^(name|description):\s*(.*)$/.exec(lines[i]);
      if (!match) continue;
      const [, key, rawValue] = match;
      const value = rawValue.trim();

      if (value === '>' || value === '|' || value === '>-' || value === '|-') {
        const block: string[] = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          const line = lines[j];
          if (line.trim() !== '' && !/^\s/.test(line)) break;
          block.push(line.trim());
          i = j;
        }
        out[key] = block.join(' ').replace(/\s+/g, ' ').trim();
      } else {
        out[key] = value.replace(/^["']|["']$/g, '').trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function skillsUnder(dir: string, source: string, depth = 0): Discovered[] {
  if (!existsSync(dir) || depth > 3) return [];
  const found: Discovered[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillFile = join(full, 'SKILL.md');
    if (existsSync(skillFile)) {
      const meta = frontmatter(skillFile);
      found.push({
        name: meta.name ?? entry,
        description: meta.description ?? '',
        source,
        path: skillFile,
      });
    } else {
      found.push(...skillsUnder(full, source, depth + 1));
    }
  }
  return found;
}

/** Plugin skills live at <plugins root>/**\/<plugin>/skills/<skill>/SKILL.md. */
function pluginSkills(): Discovered[] {
  const root = join(homedir(), '.claude', 'plugins');
  if (!existsSync(root)) return [];
  const found: Discovered[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry === 'skills') {
        // The plugin is the directory holding `skills`.
        found.push(...skillsUnder(full, basename(dir)));
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

function agentsUnder(dir: string, source: string): Discovered[] {
  if (!existsSync(dir)) return [];
  const found: Discovered[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const full = join(dir, entry);
    const meta = frontmatter(full);
    found.push({
      name: meta.name ?? entry.replace(/\.md$/, ''),
      description: meta.description ?? '',
      source,
      path: full,
    });
  }
  return found;
}

/**
 * De-duplicate by NAME, not by source.
 *
 * A name is how a workflow refers to a skill, and how Claude resolves one, so
 * two installs sharing a name are not two choices: only one of them can ever
 * run. Listing both puts a decision in front of the user that their answer
 * cannot affect. User and project copies win over plugin ones, matching
 * resolution order.
 */
const SOURCE_RANK: Record<string, number> = { user: 0, project: 1 };

function dedupe(items: Discovered[]): Discovered[] {
  const best = new Map<string, Discovered>();
  for (const item of items) {
    const current = best.get(item.name);
    if (!current) {
      best.set(item.name, item);
      continue;
    }
    const rank = (d: Discovered) => SOURCE_RANK[d.source] ?? 2;
    if (rank(item) < rank(current)) best.set(item.name, item);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkills(cwd = process.cwd()): Discovered[] {
  return dedupe([
    ...skillsUnder(join(homedir(), '.claude', 'skills'), 'user'),
    ...skillsUnder(join(homedir(), '.agents', 'skills'), 'user'),
    ...skillsUnder(join(cwd, '.claude', 'skills'), 'project'),
    ...pluginSkills(),
  ]);
}

export function findAgents(cwd = process.cwd()): Discovered[] {
  const plugins: Discovered[] = [];
  const root = join(homedir(), '.claude', 'plugins');
  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || !existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (entry === 'agents') plugins.push(...agentsUnder(full, basename(dir)));
      else walk(full, depth + 1);
    }
  };
  walk(root, 0);

  return dedupe([
    ...agentsUnder(join(homedir(), '.claude', 'agents'), 'user'),
    ...agentsUnder(join(cwd, '.claude', 'agents'), 'project'),
    ...plugins,
  ]);
}
