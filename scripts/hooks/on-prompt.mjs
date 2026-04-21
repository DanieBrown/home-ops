#!/usr/bin/env node
import {
  readStdinJson,
  detectMode,
  startContract,
  clearContract,
  normalizePromptPayload,
} from './contract-shared.mjs';

async function main() {
  const payload = await readStdinJson();
  const prompt = normalizePromptPayload(payload);
  const mode = detectMode(prompt);

  if (!mode) {
    clearContract();
    process.exit(0);
  }

  const contract = startContract(mode);
  if (!contract) {
    process.exit(0);
  }

  const lines = [
    `home-ops contract armed for mode: ${contract.mode}`,
    `${contract.description}`,
    `Required scripts (all must run successfully before turn end):`,
    ...contract.required.map((r) => `  - ${r.id}: ${r.description}`),
    ``,
    `Legitimate early-exit? Write .home-ops/contract-abort.json with {"reason":"..."} and the Stop hook will let you finish.`,
  ];
  const additionalContext = lines.join('\n');
  process.stdout.write(JSON.stringify({ additionalContext }));
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[contract on-prompt] ${err?.message ?? err}\n`);
  process.exit(0);
});
