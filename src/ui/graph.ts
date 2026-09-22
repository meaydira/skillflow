import type { LoadedWorkflow } from '../workflow/load.js';

/** Mermaid so it renders in a GitHub README or an issue without any tooling. */
export function toMermaid(wf: LoadedWorkflow): string {
  const lines = ['graph TD'];
  for (const node of wf.spec.nodes) {
    const label = [node.name ?? node.id, node.skill ? `[${node.skill}]` : node.agent ? `<${node.agent}>` : '']
      .filter(Boolean)
      .join('<br/>');
    const shape = node.approval ? `{{"${label}"}}` : `["${label}"]`;
    lines.push(`  ${node.id}${shape}`);
  }
  for (const node of wf.spec.nodes) {
    for (const dep of node.needs) {
      const produced = wf.byId.get(dep)?.outputs ?? [];
      const edge = produced.length > 0 ? `|${produced.map((o) => o.name).join(', ')}|` : '';
      lines.push(`  ${dep} -->${edge} ${node.id}`);
    }
  }
  lines.push('  classDef gate fill:#fff3cd,stroke:#b8860b;');
  const gates = wf.spec.nodes.filter((n) => n.approval).map((n) => n.id);
  if (gates.length > 0) lines.push(`  class ${gates.join(',')} gate;`);
  return lines.join('\n');
}

/** A quick text view of what runs when, which is usually what you actually want. */
export function toOutline(wf: LoadedWorkflow): string {
  const lines: string[] = [];
  wf.waves.forEach((wave, index) => {
    lines.push(`Stage ${index + 1}${wave.length > 1 ? `  (${wave.length} in parallel)` : ''}`);
    for (const id of wave) {
      const node = wf.byId.get(id);
      if (!node) continue;
      const bits = [
        node.skill ? `skill: ${node.skill}` : null,
        node.agent ? `agent: ${node.agent}` : null,
        node.resources.length > 0 ? `locks: ${node.resources.join(', ')}` : null,
        node.readonly ? 'read-only' : null,
        node.approval ? `gate: ${node.approval.when ?? 'after'}` : null,
        node.outputs.length > 0 ? `emits: ${node.outputs.map((o) => o.name).join(', ')}` : null,
      ].filter(Boolean);
      lines.push(`  ${id}`);
      for (const bit of bits) lines.push(`    ${bit}`);
    }
  });
  return lines.join('\n');
}
