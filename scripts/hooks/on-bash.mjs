#!/usr/bin/env node
import {
  readStdinJson,
  loadContract,
  saveContract,
  matchRequirement,
  normalizeBashPayload,
} from './contract-shared.mjs';

function trimForBlock(text, max = 800) {
  if (!text) return '';
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

async function main() {
  const payload = await readStdinJson();
  const norm = normalizeBashPayload(payload);
  if (!norm || !norm.isShell || !norm.command) process.exit(0);

  const contract = loadContract();
  if (!contract || !Array.isArray(contract.required)) process.exit(0);

  const match = matchRequirement(contract, norm.command);
  if (!match) process.exit(0);

  const target = contract.required.find((r) => r.id === match.id);
  if (!target) process.exit(0);

  target.attempts = (target.attempts ?? 0) + 1;
  target.last_exit_code = norm.exitCode;
  target.last_command = norm.command;
  target.last_ran_at = new Date().toISOString();
  target.last_source = norm.source;

  if (norm.exitCode === 0) {
    target.satisfied = true;
    target.failed = false;
    target.last_error = null;
    saveContract(contract);
    process.exit(0);
  }

  target.satisfied = false;
  target.failed = true;
  target.last_error = trimForBlock(norm.stderr);
  saveContract(contract);

  if (norm.source !== 'claude-code') {
    process.exit(0);
  }

  const reason = [
    `home-ops contract script FAILED (exit ${norm.exitCode}): ${target.id}`,
    `Command: ${norm.command}`,
    `Requirement: ${target.description}`,
    norm.stderr ? `Error output:\n${trimForBlock(norm.stderr)}` : 'No stderr captured.',
    `Investigate the failure before continuing. Re-run this script after fixing the root cause.`,
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason,
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[contract on-bash] ${err?.message ?? err}\n`);
  process.exit(0);
});
