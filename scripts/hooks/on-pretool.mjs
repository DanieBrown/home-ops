#!/usr/bin/env node
import {
  readStdinJson,
  loadContract,
  matchRequirement,
  unsatisfiedPrereqs,
} from './contract-shared.mjs';

function extractCommand(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.toolName === 'string') {
    let args = {};
    try {
      args = typeof payload.toolArgs === 'string' ? JSON.parse(payload.toolArgs) : (payload.toolArgs ?? {});
    } catch {}
    return String(args.command ?? args.cmd ?? args.script ?? '');
  }
  if (payload.tool_input && typeof payload.tool_input === 'object') {
    return String(payload.tool_input.command ?? '');
  }
  return '';
}

async function main() {
  const payload = await readStdinJson();
  const command = extractCommand(payload);
  if (!command) process.exit(0);

  const contract = loadContract();
  if (!contract || !Array.isArray(contract.required)) process.exit(0);
  if (contract.aborted) process.exit(0);

  const match = matchRequirement(contract, command);
  if (!match) process.exit(0);

  const liveRequirement = contract.required.find((r) => r.id === match.id);
  if (!liveRequirement || !liveRequirement.isGate) process.exit(0);

  const missing = unsatisfiedPrereqs(contract, liveRequirement);
  if (missing.length === 0) process.exit(0);

  const lines = [
    `home-ops "${contract.mode}" gate denied: "${liveRequirement.id}" cannot run yet.`,
    `This step requires these prereqs to succeed first:`,
    ...missing.map((m) => {
      const status = m.failed ? `FAILED (exit ${m.last_exit_code ?? '?'})` : 'not yet run';
      return `  - ${m.id}: ${m.description} [${status}]`;
    }),
    ``,
    `Run (and succeed) the prereqs above before attempting "${liveRequirement.id}" again.`,
  ];

  process.stdout.write(
    JSON.stringify({
      decision: 'deny',
      reason: lines.join('\n'),
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[contract on-pretool] ${err?.message ?? err}\n`);
  process.exit(0);
});
