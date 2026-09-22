import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Artifact, OutputSpec } from '../types.js';
import { nodeDir, runRoot } from './paths.js';

/**
 * How an agent declares what it produced.
 *
 * The contract is a file on disk, not a protocol. An agent that can write JSON
 * can participate, which means every Claude skill you already have works
 * without modification as long as its prompt tells it to write the manifest.
 */
const manifestSchema = z.object({
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(['document', 'records', 'note', 'ref', 'changeset']),
        summary: z.string().min(1),
        description: z.string().optional(),
        data: z.unknown().optional(),
        files: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export class ArtifactError extends Error {}

export function manifestPath(baseDir: string, runId: string, nodeId: string): string {
  return join(nodeDir(baseDir, runId, nodeId), 'outputs', 'manifest.json');
}

/**
 * Read a node's manifest and check it against what the node promised to emit.
 *
 * Validation is strict on purpose. A node that quietly produced nothing is the
 * failure mode that wastes the most time downstream: the next node starts, finds
 * no input, improvises, and you discover it three steps later.
 */
export function collectOutputs(
  baseDir: string,
  runId: string,
  nodeId: string,
  declared: OutputSpec[],
): Artifact[] {
  const file = manifestPath(baseDir, runId, nodeId);
  const required = declared.filter((d) => d.required !== false);

  if (!existsSync(file)) {
    if (declared.length === 0) return [];
    throw new ArtifactError(
      `node "${nodeId}" declared ${declared.length} output(s) but wrote no outputs/manifest.json`,
    );
  }

  let parsed: z.infer<typeof manifestSchema>;
  try {
    parsed = manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new ArtifactError(`node "${nodeId}" wrote an unreadable manifest: ${(err as Error).message}`);
  }

  const root = runRoot(baseDir, runId);
  const nodeOutputs = join(nodeDir(baseDir, runId, nodeId), 'outputs');
  const now = new Date().toISOString();

  const artifacts: Artifact[] = parsed.artifacts.map((entry) => {
    const spec = declared.find((d) => d.name === entry.name);
    if (spec && spec.kind !== entry.kind) {
      throw new ArtifactError(
        `node "${nodeId}" declared output "${entry.name}" as ${spec.kind} but emitted ${entry.kind}`,
      );
    }

    const files = entry.files.map((f) => {
      // Accept either a path relative to the node's outputs dir or an absolute
      // one inside the run. Anything pointing outside the run is refused: a
      // handoff must be self-contained or it cannot be replayed or archived.
      const abs = isAbsolute(f) ? resolve(f) : resolve(nodeOutputs, f);
      if (!abs.startsWith(resolve(root))) {
        throw new ArtifactError(
          `node "${nodeId}" listed file "${f}" outside the run directory; copy it into outputs/ instead`,
        );
      }
      if (!existsSync(abs)) {
        throw new ArtifactError(`node "${nodeId}" listed file "${f}", which does not exist`);
      }
      return relative(root, abs);
    });

    if (entry.kind === 'document' && files.length === 0) {
      throw new ArtifactError(`node "${nodeId}" emitted document "${entry.name}" with no files`);
    }

    return {
      name: entry.name,
      kind: entry.kind,
      node: nodeId,
      summary: entry.summary,
      description: entry.description,
      data: entry.data,
      files,
      createdAt: now,
    };
  });

  const emitted = new Set(artifacts.map((a) => a.name));
  const missing = required.filter((r) => !emitted.has(r.name)).map((r) => r.name);
  if (missing.length > 0) {
    throw new ArtifactError(
      `node "${nodeId}" did not emit required output(s): ${missing.join(', ')}`,
    );
  }

  writeFileSync(
    join(runRoot(baseDir, runId), 'nodes', nodeId, 'artifacts.json'),
    JSON.stringify(artifacts, null, 2),
    'utf8',
  );
  return artifacts;
}

/** Re-read artifacts a previous run already produced, so resume can hand them downstream. */
export function loadPersistedArtifacts(baseDir: string, runId: string, nodeId: string): Artifact[] {
  const file = join(runRoot(baseDir, runId), 'nodes', nodeId, 'artifacts.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Artifact[];
  } catch {
    return [];
  }
}

/**
 * Materialise an upstream artifact inside a downstream node's inputs/ directory.
 *
 * Files are copied rather than symlinked. It costs disk and buys two things that
 * matter more: a run stays readable after the source is cleaned up, and an agent
 * cannot accidentally write back through a link into another node's outputs.
 */
export function stageInput(baseDir: string, runId: string, consumer: string, artifact: Artifact): string {
  const dest = join(nodeDir(baseDir, runId, consumer), 'inputs', artifact.node, artifact.name);
  mkdirSync(dest, { recursive: true });

  writeFileSync(
    join(dest, 'summary.md'),
    `# ${artifact.name}\n\nFrom node: \`${artifact.node}\`\nKind: \`${artifact.kind}\`\n\n${artifact.summary}\n`,
    'utf8',
  );

  if (artifact.data !== undefined) {
    writeFileSync(join(dest, 'data.json'), JSON.stringify(artifact.data, null, 2), 'utf8');
  }

  const root = runRoot(baseDir, runId);
  for (const rel of artifact.files ?? []) {
    const src = join(root, rel);
    if (!existsSync(src)) continue;
    const target = join(dest, 'files', rel.split('/').pop() as string);
    mkdirSync(join(dest, 'files'), { recursive: true });
    cpSync(src, target, { recursive: statSync(src).isDirectory() });
  }
  return dest;
}
