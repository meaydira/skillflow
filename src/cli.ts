#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { loadWorkflow, lintWorkflow, WorkflowError } from './workflow/load.js';
import { executeRun, loadRunState, newRunId } from './engine/run.js';
import { decideApproval, pendingApprovals, readApproval } from './engine/approvals.js';
import { Ledger } from './engine/ledger.js';
import { toMermaid, toOutline } from './ui/graph.js';
import { describeRun, listRuns } from './ui/status.js';
import { runRoot } from './engine/paths.js';
import { findAgents, findSkills } from './discover.js';
import { writeFileSync } from 'node:fs';

const program = new Command();
const BASE = process.env.SKILLFLOW_HOME ?? process.cwd();

program
  .name('skillflow')
  .description('Run your Claude skills as a dependency graph, with real handoffs between them.')
  .version('0.1.0');

function parseInputs(pairs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index === -1) throw new Error(`bad --input "${pair}", expected key=value`);
    out[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return out;
}

function fail(err: unknown): never {
  const message = err instanceof WorkflowError ? err.message : (err as Error).message;
  process.stderr.write(`\nerror: ${message}\n\n`);
  process.exit(1);
}

program
  .command('run <workflow>')
  .description('execute a workflow')
  .option('-i, --input <key=value...>', 'run inputs', [])
  .option('--dry-run', 'walk the graph without invoking any agent')
  .option('--run-id <id>', 'use a specific run id')
  .action(async (file: string, opts: { input: string[]; dryRun?: boolean; runId?: string }) => {
    try {
      const workflow = loadWorkflow(file);
      const inputs = parseInputs(opts.input);

      for (const warning of lintWorkflow(workflow, inputs)) {
        process.stderr.write(`warn  ${warning.node ? `${warning.node}: ` : ''}${warning.message}\n`);
      }

      const runId = opts.runId ?? newRunId();
      process.stdout.write(`\n${workflow.spec.name}\nrun ${runId}\n\n`);

      const summary = await executeRun({
        baseDir: BASE,
        workflow,
        inputs,
        runId,
        dryRun: opts.dryRun,
        onLog: (line) => process.stdout.write(`${line}\n`),
      });

      process.stdout.write(`\n${'-'.repeat(60)}\n`);
      process.stdout.write(`outcome   ${summary.outcome}\n`);
      process.stdout.write(`cost      $${summary.totalCostUsd.toFixed(2)}\n`);
      process.stdout.write(`artifacts ${runRoot(BASE, runId)}\n`);

      if (summary.blocked.length > 0) {
        process.stdout.write(`blocked   ${summary.blocked.join(', ')}\n`);
      }

      if (summary.pending.length > 0) {
        process.stdout.write(`\nwaiting on you:\n`);
        for (const node of summary.pending) {
          const approval = readApproval(BASE, runId, node);
          process.stdout.write(`  ${node}  ${approval?.prompt ?? ''}\n`);
        }
        process.stdout.write(`\n  skillflow review ${runId}\n`);
        process.stdout.write(`  skillflow approve ${runId} <node>\n`);
        process.stdout.write(`  skillflow resume ${runId}\n`);
      }
      process.stdout.write('\n');
      process.exit(summary.outcome === 'failed' ? 1 : 0);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('resume <runId>')
  .description('continue a paused or partially failed run, skipping what already finished')
  .action(async (runId: string) => {
    try {
      const state = loadRunState(BASE, runId);
      if (!state) throw new Error(`no run ${runId} under ${BASE}`);
      const workflow = loadWorkflow(state.workflowPath);

      process.stdout.write(`\n${workflow.spec.name}\nresuming ${runId}\n\n`);
      const summary = await executeRun({
        baseDir: BASE,
        workflow,
        inputs: state.inputs,
        runId,
        resume: true,
        dryRun: state.dryRun,
        onLog: (line) => process.stdout.write(`${line}\n`),
      });

      process.stdout.write(`\n${'-'.repeat(60)}\noutcome   ${summary.outcome}\n`);
      if (summary.pending.length > 0) {
        process.stdout.write(`still waiting: ${summary.pending.join(', ')}\n`);
      }
      process.stdout.write('\n');
      process.exit(summary.outcome === 'failed' ? 1 : 0);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('status [runId]')
  .description('show a run, or list recent runs')
  .action((runId?: string) => {
    if (runId) {
      process.stdout.write(`\n${describeRun(BASE, runId)}\n\n`);
      return;
    }
    const runs = listRuns(BASE);
    if (runs.length === 0) {
      process.stdout.write('\nno runs yet\n\n');
      return;
    }
    process.stdout.write('\n');
    for (const run of runs.slice(0, 20)) {
      process.stdout.write(
        `  ${run.outcome.padEnd(10)} ${run.runId}  ${run.workflow}  ${run.startedAt.slice(0, 16).replace('T', ' ')}\n`,
      );
    }
    process.stdout.write('\n');
  });

program
  .command('review <runId>')
  .description('print everything currently waiting for your approval')
  .action((runId: string) => {
    const waiting = pendingApprovals(BASE, runId);
    if (waiting.length === 0) {
      process.stdout.write(`\nnothing is waiting on you in ${runId}\n\n`);
      return;
    }
    for (const approval of waiting) {
      process.stdout.write(`\n${'='.repeat(60)}\n`);
      process.stdout.write(`node    ${approval.node}\n`);
      process.stdout.write(`gate    ${approval.when}\n`);
      process.stdout.write(`asking  ${approval.prompt}\n`);
      process.stdout.write(`${'='.repeat(60)}\n\n`);
      process.stdout.write(`${approval.preview ?? '(nothing to preview)'}\n\n`);
      process.stdout.write(`  skillflow approve ${runId} ${approval.node}\n`);
      process.stdout.write(`  skillflow reject  ${runId} ${approval.node} --note "why"\n\n`);
    }
  });

program
  .command('approve <runId> <node>')
  .description('grant an approval and let the run continue')
  .option('-n, --note <text>', 'note recorded with the decision')
  .action((runId: string, node: string, opts: { note?: string }) => {
    try {
      decideApproval(BASE, runId, node, 'granted', userInfo().username, opts.note);
      new Ledger(BASE, runId).append({ type: 'approval.granted', node, by: userInfo().username, note: opts.note });
      process.stdout.write(`\napproved ${node}\n\n  skillflow resume ${runId}\n\n`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('reject <runId> <node>')
  .description('reject an approval; everything downstream of this node stops')
  .option('-n, --note <text>', 'note recorded with the decision')
  .action((runId: string, node: string, opts: { note?: string }) => {
    try {
      decideApproval(BASE, runId, node, 'rejected', userInfo().username, opts.note);
      new Ledger(BASE, runId).append({ type: 'approval.rejected', node, by: userInfo().username, note: opts.note });
      process.stdout.write(`\nrejected ${node}; downstream nodes will not run\n\n`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('validate <workflow>')
  .description('check a workflow without running it')
  .option('-i, --input <key=value...>', 'inputs to check against', [])
  .action((file: string, opts: { input: string[] }) => {
    try {
      const workflow = loadWorkflow(file);
      const warnings = lintWorkflow(workflow, parseInputs(opts.input));
      process.stdout.write(`\n${workflow.spec.name}\n${workflow.spec.nodes.length} nodes, ${workflow.waves.length} stages\n\n`);
      process.stdout.write(`${toOutline(workflow)}\n\n`);
      if (warnings.length === 0) {
        process.stdout.write('no warnings\n\n');
        return;
      }
      for (const warning of warnings) {
        process.stdout.write(`warn  ${warning.node ? `${warning.node}: ` : ''}${warning.message}\n`);
      }
      process.stdout.write('\n');
    } catch (err) {
      fail(err);
    }
  });

program
  .command('graph <workflow>')
  .description('print the workflow as a mermaid diagram')
  .action((file: string) => {
    try {
      process.stdout.write(`\n\`\`\`mermaid\n${toMermaid(loadWorkflow(file))}\n\`\`\`\n\n`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('logs <runId> [node]')
  .description('replay the ledger for a run, or for one node in it')
  .option('--tools', 'show tool calls')
  .action((runId: string, node: string | undefined, opts: { tools?: boolean }) => {
    const events = new Ledger(BASE, runId).read();
    for (const event of events) {
      if (node && 'node' in event && event.node !== node) continue;
      if (event.type === 'node.tool' && !opts.tools) continue;
      const time = event.ts.slice(11, 19);
      const who = 'node' in event ? event.node : 'run';
      let detail = '';
      if (event.type === 'node.text') detail = event.text.split('\n')[0].slice(0, 120);
      else if (event.type === 'node.tool') detail = `${event.tool} ${event.detail ?? ''}`;
      else if (event.type === 'node.failed') detail = event.error;
      else if (event.type === 'node.artifact') detail = `${event.artifact.name} (${event.artifact.kind})`;
      else if (event.type === 'node.completed') detail = `$${event.costUsd.toFixed(2)} in ${event.turns} turns`;
      process.stdout.write(`${time}  ${event.type.padEnd(18)} ${who.padEnd(20)} ${detail}\n`);
    }
  });

program
  .command('artifacts <runId> [node]')
  .description('list the artifacts a run produced')
  .action((runId: string, node?: string) => {
    const events = new Ledger(BASE, runId).read();
    const artifacts = events.filter((e) => e.type === 'node.artifact');
    for (const event of artifacts) {
      if (event.type !== 'node.artifact') continue;
      if (node && event.node !== node) continue;
      const { artifact } = event;
      process.stdout.write(`\n${artifact.node}/${artifact.name}  [${artifact.kind}]\n`);
      process.stdout.write(`  ${artifact.summary.split('\n').join('\n  ')}\n`);
      for (const file of artifact.files ?? []) {
        process.stdout.write(`  file: ${join(runRoot(BASE, runId), file)}\n`);
      }
    }
    process.stdout.write('\n');
  });

program
  .command('ui')
  .description('open a local web view of your runs, with approve and reject buttons')
  .option('-p, --port <n>', 'port to listen on', '4600')
  .action(async (opts: { port: string }) => {
    const { startUi } = await import('./ui/server.js');
    try {
      const url = await startUi(BASE, Number(opts.port));
      process.stdout.write(`\nskillflow ui  ${url}\n`);
      process.stdout.write(`reading ${BASE}/.skillflow/runs\n\nCtrl-C to stop.\n\n`);
    } catch (err) {
      fail(new Error(`could not start the ui: ${(err as Error).message}`));
    }
  });

program
  .command('list [what]')
  .description('list the skills and agents installed on this machine, for use as nodes')
  .option('-s, --search <text>', 'filter by name or description')
  .action((what: string | undefined, opts: { search?: string }) => {
    const wanted = (what ?? 'all').toLowerCase();
    const match = (text: string): boolean =>
      !opts.search || text.toLowerCase().includes(opts.search.toLowerCase());

    const render = (title: string, items: ReturnType<typeof findSkills>, key: string) => {
      const filtered = items.filter((i) => match(`${i.name} ${i.description} ${i.source}`));
      process.stdout.write(`\n${title} (${filtered.length})\n\n`);
      if (filtered.length === 0) {
        process.stdout.write('  none found\n');
        return;
      }
      for (const item of filtered) {
        const summary = item.description.replace(/\s+/g, ' ').slice(0, 96);
        process.stdout.write(`  ${item.name}\n`);
        process.stdout.write(`    ${key}: ${item.name}    source: ${item.source}\n`);
        if (summary) process.stdout.write(`    ${summary}${item.description.length > 96 ? '...' : ''}\n`);
        process.stdout.write('\n');
      }
    };

    if (wanted === 'all' || wanted === 'skills') render('Skills', findSkills(), 'skill');
    if (wanted === 'all' || wanted === 'agents') render('Agents', findAgents(), 'agent');
    process.stdout.write('Put the name on a node as `skill: <name>` or `agent: <name>`.\n\n');
  });

program
  .command('new <file>')
  .description('scaffold a workflow file you can edit')
  .option('-n, --node <name...>', 'node ids to create, in order', [])
  .action((file: string, opts: { node: string[] }) => {
    const ids = opts.node.length > 0 ? opts.node : ['gather', 'decide', 'deliver'];
    const name = file.replace(/.*\//, '').replace(/\.ya?ml$/, '');

    const nodes = ids.map((id, index) => {
      const needs = index === 0 ? '' : `    needs: [${ids[index - 1]}]\n`;
      return [
        `  - id: ${id}`,
        `    name: ${id.charAt(0).toUpperCase()}${id.slice(1)}`,
        `    # skill: your-skill        # run \`skillflow list skills\` to see what you have`,
        `    # agent: your-agent        # or run the node as one of your agents`,
        `    # readonly: true           # say so when the node cannot change anything`,
        `    # resources: [crm:main]    # logical lock: nothing else touches this at the same time`,
        needs.trimEnd(),
        `    prompt: |`,
        `      What ${id} should do.`,
        ``,
        `      Say plainly what you want back, and what should happen if it cannot be done.`,
        `    outputs:`,
        `      - name: result`,
        `        kind: note              # document | records | note | ref | changeset`,
        `        description: what this node hands to the next one`,
      ]
        .filter((line) => line !== '')
        .join('\n');
    });

    const body = [
      `name: ${name}`,
      `description: what this workflow is for`,
      ``,
      `inputs:`,
      `  example:`,
      `    description: something the run needs, referenced as \${{ inputs.example }}`,
      `    required: true`,
      ``,
      `# MCP servers nodes can opt into with \`connectors: [name]\``,
      `connectors: {}`,
      ``,
      `defaults:`,
      `  permissionMode: acceptEdits`,
      `  maxTurns: 30`,
      `  idleTimeoutSec: 600`,
      ``,
      `concurrency: 2`,
      ``,
      `nodes:`,
      ...nodes,
      ``,
      `# Add a human gate to any node that does something you cannot undo:`,
      `#`,
      `#   approval:`,
      `#     when: before     # hold the node until you approve`,
      `#     when: after      # let it run, hold its outputs`,
      `#     prompt: what you are being asked to check`,
      ``,
    ].join('\n');

    writeFileSync(file, body, 'utf8');
    process.stdout.write(`\nwrote ${file}\n\n  skillflow validate ${file}\n  skillflow run ${file} -i example=value --dry-run\n\n`);
  });

program.parseAsync(process.argv).catch(fail);
