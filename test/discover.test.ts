import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSkills } from '../src/discover.js';

/**
 * Discovery reads frontmatter from skills people actually wrote, and skill
 * authors use folded block scalars constantly for long descriptions. A naive
 * reader returns ">" for those, which is how the first version shipped.
 */

function projectWithSkill(name: string, skillMd: string): string {
  const base = mkdtempSync(join(tmpdir(), 'skillflow-disc-'));
  const dir = join(base, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8');
  return base;
}

const projectOnly = (base: string) => findSkills(base).filter((s) => s.source === 'project');

test('a plain single-line description is read', () => {
  const base = projectWithSkill('alpha', '---\nname: alpha\ndescription: Does the alpha thing.\n---\n\nbody\n');
  const [skill] = projectOnly(base);
  assert.equal(skill.name, 'alpha');
  assert.equal(skill.description, 'Does the alpha thing.');
});

test('a folded block description is joined rather than read as ">"', () => {
  const base = projectWithSkill(
    'beta',
    '---\nname: beta\ndescription: >\n  First line of the description.\n  Second line that should join on.\n---\n\nbody\n',
  );
  const [skill] = projectOnly(base);
  assert.equal(skill.description, 'First line of the description. Second line that should join on.');
  assert.ok(!skill.description.startsWith('>'));
});

test('a literal block description is read too', () => {
  const base = projectWithSkill(
    'gamma',
    '---\nname: gamma\ndescription: |\n  Line one.\n  Line two.\n---\n',
  );
  const [skill] = projectOnly(base);
  assert.equal(skill.description, 'Line one. Line two.');
});

test('quotes are stripped from a quoted description', () => {
  const base = projectWithSkill('delta', '---\nname: delta\ndescription: "Quoted thing."\n---\n');
  assert.equal(projectOnly(base)[0].description, 'Quoted thing.');
});

test('a skill with no frontmatter falls back to its directory name', () => {
  const base = projectWithSkill('epsilon', '# Just a heading\n\nNo frontmatter here.\n');
  const [skill] = projectOnly(base);
  assert.equal(skill.name, 'epsilon');
  assert.equal(skill.description, '');
});

test('a directory without SKILL.md is not reported as a skill', () => {
  const base = mkdtempSync(join(tmpdir(), 'skillflow-disc-'));
  mkdirSync(join(base, '.claude', 'skills', 'notaskill'), { recursive: true });
  writeFileSync(join(base, '.claude', 'skills', 'notaskill', 'README.md'), 'nope', 'utf8');
  assert.deepEqual(projectOnly(base), []);
});

test('two skills with the same name collapse to one', () => {
  // Claude resolves a skill by name, so only one of a duplicated pair can ever
  // run. Offering both would be a choice the user cannot actually make.
  const base = projectWithSkill('shared', '---\nname: shared\ndescription: The project copy.\n---\n');
  const all = findSkills(base);
  assert.equal(all.filter((s) => s.name === 'shared').length, 1);
});

test('no name appears twice in a discovery listing', () => {
  const names = findSkills(mkdtempSync(join(tmpdir(), 'skillflow-disc-'))).map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});
