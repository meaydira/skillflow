/**
 * A deliberately tiny expression language: ${{ path.to.value }}.
 *
 * It is not a sandbox for arbitrary code and must never become one. Workflow
 * files are executable configuration, and every extra capability here is a new
 * way for a shared workflow to do something its reader did not expect.
 */

export interface TemplateScope {
  inputs: Record<string, string>;
  run: { id: string; date: string; workflow: string };
  env: Record<string, string | undefined>;
  /** Upstream artifact summaries, addressable as nodes.<id>.outputs.<name>. */
  nodes: Record<string, { outputs: Record<string, { summary: string; data?: unknown }> }>;
}

const EXPR = /\$\{\{\s*([^}]+?)\s*\}\}/g;

function resolvePath(scope: TemplateScope, path: string): unknown {
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  let cursor: unknown = scope;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

/**
 * Replace every ${{ ... }} in `text`. Unknown paths resolve to an empty string
 * rather than throwing, but they are reported so `validate` can warn about a
 * typo before a run burns tokens discovering it.
 */
export function render(text: string, scope: TemplateScope): { out: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = text.replace(EXPR, (_match, expr: string) => {
    const value = resolvePath(scope, expr);
    if (value === undefined) unresolved.push(expr);
    return stringify(value);
  });
  return { out, unresolved };
}

/** Every ${{ ... }} path appearing in a string, for static validation. */
export function referencedPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(EXPR)) found.push(match[1].trim());
  return found;
}
