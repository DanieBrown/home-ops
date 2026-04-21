#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  readStdinJson,
  loadContract,
  saveContract,
  outstanding,
} from './contract-shared.mjs';

const ABORT_PATH = resolve(process.cwd(), '.home-ops', 'contract-abort.json');

function readAbort() {
  if (!existsSync(ABORT_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(ABORT_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function main() {
  const payload = await readStdinJson();

  if (payload?.stop_hook_active) process.exit(0);

  const contract = loadContract();
  if (!contract || !Array.isArray(contract.required)) process.exit(0);

  const abort = readAbort();
  if (abort?.reason) {
    contract.aborted = { reason: String(abort.reason), at: new Date().toISOString() };
    saveContract(contract);
    try { unlinkSync(ABORT_PATH); } catch {}
    process.exit(0);
  }

  const pending = outstanding(contract);
  if (pending.length === 0) process.exit(0);

  const failures = pending.filter((r) => r.failed);
  const unsatisfied = pending.filter((r) => !r.failed && !r.satisfied);

  const lines = [
    `home-ops "${contract.mode}" contract is NOT complete -- do not end the turn yet.`,
  ];

  if (failures.length) {
    lines.push(``, `Failed scripts (fix these first):`);
    for (const f of failures) {
      lines.push(`  - ${f.id} (exit ${f.last_exit_code ?? '?'}): ${f.description}`);
      if (f.last_command) lines.push(`      cmd: ${f.last_command}`);
      if (f.last_error) lines.push(`      err: ${f.last_error.split('\n').slice(0, 4).join(' | ')}`);
    }
  }

  if (unsatisfied.length) {
    lines.push(``, `Scripts that still need to run:`);
    for (const u of unsatisfied) {
      lines.push(`  - ${u.id}: ${u.description}`);
    }
  }

  lines.push(
    ``,
    `Options:`,
    `  1. Run the missing/failed scripts, then try to end the turn again.`,
    `  2. If an early exit is legitimate (browser dead, finalist gate failed with user override, etc.),`,
    `     write .home-ops/contract-abort.json with {"reason":"<why>"} and end the turn.`,
  );

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: lines.join('\n'),
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[contract on-stop] ${err?.message ?? err}\n`);
  process.exit(0);
});
