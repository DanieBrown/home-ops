import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
export const STATE_PATH = resolve(ROOT, '.home-ops', 'command-contract.json');

const req = (id, description, patterns, opts = {}) => ({
  id,
  description,
  patterns,
  requires: opts.requires ?? [],
  isGate: Boolean(opts.isGate),
  satisfied: false,
  failed: false,
  attempts: 0,
  last_error: null,
  last_exit_code: null,
});

const CONTRACTS = {
  scan: {
    mode: 'scan',
    description: '/home-ops scan -- portal scan that writes to data/pipeline.md',
    required: [
      req('scan', 'Portal scan for new listings', [
        /scan-listings\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+scan\b/,
      ]),
      req('pipeline-write-verified', 'Verify scan updated data/pipeline.md', [
        /verify-pipeline-write\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+scan:verify\b/,
      ], { requires: ['scan'], isGate: true }),
    ],
  },
  hunt: {
    mode: 'hunt',
    description: '/home-ops hunt -- session check (auto-init if needed), reset, scan, evaluate pending, deep shortlist',
    required: [
      req('browser-status', 'Hosted browser session check (auto-runs init if closed)', [
        /npm(?:\.cmd)?\s+run\s+browser:status\b/,
        /browser-session\.mjs[^\n]*--status\b/,
      ]),
      req('reset:data', 'Clear generated search state', [
        /npm(?:\.cmd)?\s+run\s+reset:data\b/,
        /reset-search-state\.mjs\b/,
      ], { requires: ['browser-status'] }),
      req('verify-pipeline', 'Post-reset pipeline health check', [
        /verify-pipeline\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+verify\b/,
      ], { requires: ['reset:data'] }),
      req('scan', 'Portal scan for new listings', [
        /scan-listings\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+scan\b/,
      ], { requires: ['verify-pipeline'] }),
      req('pipeline-write-verified', 'Verify scan updated data/pipeline.md', [
        /verify-pipeline-write\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+scan:verify\b/,
      ], { requires: ['scan'] }),
      req('evaluate-pending', 'Batch evaluate the pending pipeline', [
        /evaluate-pending\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+evaluate:pending\b/,
      ], { requires: ['pipeline-write-verified'] }),
      req('merge-tracker', 'Merge staged tracker TSVs', [
        /merge-tracker\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+merge\b/,
      ], { requires: ['evaluate-pending'] }),
      req('research-audit', 'Post-batch research coverage audit', [
        /research-coverage-audit\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+audit:research\b/,
      ], { requires: ['merge-tracker'] }),
      req('review-tabs-top10', 'Open top-10 review tab group', [
        /review-tabs\.mjs[^\n]*shortlist-top10/,
        /npm(?:\.cmd)?\s+run\s+browser:review[^\n]*shortlist-top10/,
      ], {
        requires: ['reset:data', 'verify-pipeline', 'scan', 'pipeline-write-verified', 'evaluate-pending', 'merge-tracker', 'research-audit'],
      }),
      req('research-source-plan', 'Deep phase: shortlist source plan (fan-out 6a)', [
        /research-source-plan\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+plan:research[^\n]*--shortlist/,
      ], { requires: ['review-tabs-top10'] }),
      req('sentiment-extract', 'Deep phase: shortlist sentiment capture (fan-out 6c)', [
        /sentiment-browser-extract\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+extract:sentiment[^\n]*--shortlist/,
      ], { requires: ['review-tabs-top10'] }),
      req('construction-check', 'Deep phase: shortlist NCDOT construction check (fan-out 6d)', [
        /construction-check\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+check:construction[^\n]*--shortlist/,
      ], { requires: ['review-tabs-top10'] }),
      req('deep-research-packet', 'Deep phase: research packets per shortlisted home', [
        /deep-research-packet\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+prepare:deep[^\n]*--shortlist/,
      ], { requires: ['research-source-plan', 'sentiment-extract', 'construction-check'] }),
      req('finalist-gate', 'Deep phase: finalist gate before promoting top 3', [
        /shortlist-finalist-gate\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+gate:finalists\b/,
      ], { requires: ['deep-research-packet'] }),
      req('review-tabs-top3', 'Deep phase: replace tabs with top-3 finalists', [
        /review-tabs\.mjs[^\n]*shortlist-top3/,
        /npm(?:\.cmd)?\s+run\s+browser:review[^\n]*shortlist-top3/,
      ], {
        isGate: true,
        requires: ['research-source-plan', 'sentiment-extract', 'construction-check', 'deep-research-packet', 'finalist-gate'],
      }),
      req('briefing-pdf', 'Deep phase: render top-3 briefing PDF', [
        /briefing-pdf\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+brief:top3\b/,
      ], {
        isGate: true,
        requires: ['review-tabs-top3'],
      }),
    ],
  },
  'evaluate-pending': {
    mode: 'evaluate-pending',
    description: '/home-ops evaluate (no target) -- batch pending pipeline',
    required: [
      req('evaluate-pending', 'Batch evaluate the pending pipeline', [
        /evaluate-pending\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+evaluate:pending\b/,
      ]),
      req('merge-tracker', 'Merge staged tracker TSVs', [
        /merge-tracker\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+merge\b/,
      ], { requires: ['evaluate-pending'] }),
      req('research-audit', 'Post-batch research coverage audit', [
        /research-coverage-audit\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+audit:research\b/,
      ], { requires: ['merge-tracker'] }),
      req('review-tabs-top10', 'Open top-10 review tab group', [
        /review-tabs\.mjs[^\n]*shortlist-top10/,
        /npm(?:\.cmd)?\s+run\s+browser:review[^\n]*shortlist-top10/,
      ], {
        isGate: true,
        requires: ['evaluate-pending', 'merge-tracker', 'research-audit'],
      }),
    ],
  },
  'deep-shortlist': {
    mode: 'deep-shortlist',
    description: '/home-ops deep -- shortlist batch branch',
    required: [
      req('research-audit', 'Pre-rerank research coverage audit', [
        /research-coverage-audit\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+audit:research\b/,
      ]),
      req('research-source-plan', 'Shortlist source plan (parallel fan-out 6a)', [
        /research-source-plan\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+plan:research[^\n]*--shortlist/,
      ], { requires: ['research-audit'] }),
      req('sentiment-extract', 'Shortlist sentiment capture (fan-out 6b)', [
        /sentiment-browser-extract\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+extract:sentiment[^\n]*--shortlist/,
      ], { requires: ['research-audit'] }),
      req('construction-check', 'Shortlist NCDOT construction check (fan-out 6c)', [
        /construction-check\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+check:construction[^\n]*--shortlist/,
      ], { requires: ['research-audit'] }),
      req('deep-research-packet', 'Deep research packets per shortlisted home', [
        /deep-research-packet\.mjs[^\n]*--shortlist/,
        /npm(?:\.cmd)?\s+run\s+prepare:deep[^\n]*--shortlist/,
      ], { requires: ['research-source-plan', 'sentiment-extract', 'construction-check'] }),
      req('finalist-gate', 'Shortlist finalist gate before promoting top 3', [
        /shortlist-finalist-gate\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+gate:finalists\b/,
      ], { requires: ['deep-research-packet'] }),
      req('review-tabs-top3', 'Replace tabs with top-3 finalists', [
        /review-tabs\.mjs[^\n]*shortlist-top3/,
        /npm(?:\.cmd)?\s+run\s+browser:review[^\n]*shortlist-top3/,
      ], {
        isGate: true,
        requires: ['research-audit', 'research-source-plan', 'sentiment-extract', 'construction-check', 'deep-research-packet', 'finalist-gate'],
      }),
      req('briefing-pdf', 'Render top-3 briefing PDF', [
        /briefing-pdf\.mjs\b/,
        /npm(?:\.cmd)?\s+run\s+brief:top3\b/,
      ], {
        isGate: true,
        requires: ['review-tabs-top3'],
      }),
    ],
  },
};

export function detectMode(prompt) {
  if (typeof prompt !== 'string') return null;
  const p = prompt.trim();

  const hunt = /(?:^|\s)\/home-ops[-\s]+hunt\b/i;
  if (hunt.test(p)) return 'hunt';

  const scan = /(?:^|\s)\/home-ops[-\s]+scan\b/i;
  if (scan.test(p)) return 'scan';

  const deep = /(?:^|\s)\/home-ops[-\s]+deep\b/i;
  if (deep.test(p)) {
    const batchHint = /\b(shortlist|top[-\s]?10|top[-\s]?3|batch)\b/i;
    if (batchHint.test(p)) return 'deep-shortlist';
    return null;
  }

  const evalCmd = /(?:^|\s)\/home-ops[-\s]+evaluate\b/i;
  if (evalCmd.test(p)) {
    const hasUrl = /https?:\/\/\S+/i.test(p);
    const hasAddress = /\b\d+\s+\w[\w\s]+\b(?:st|street|rd|road|ln|lane|ave|avenue|dr|drive|ct|court|blvd|way|ter|terrace|pl|place|pkwy)\b/i;
    if (!hasUrl && !hasAddress.test(p)) return 'evaluate-pending';
    return null;
  }

  return null;
}

export function loadContract() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveContract(contract) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(contract, null, 2));
}

export function clearContract() {
  if (existsSync(STATE_PATH)) {
    try {
      writeFileSync(STATE_PATH, JSON.stringify({ cleared_at: new Date().toISOString() }, null, 2));
    } catch {}
  }
}

export function startContract(mode) {
  const template = CONTRACTS[mode];
  if (!template) return null;
  const contract = {
    mode: template.mode,
    description: template.description,
    started_at: new Date().toISOString(),
    aborted: null,
    required: template.required.map((r) => ({
      ...r,
      patterns: r.patterns.map((rx) => rx.source),
    })),
  };
  saveContract(contract);
  return contract;
}

export function matchRequirement(contract, commandString) {
  if (!contract || !Array.isArray(contract.required) || !commandString) return null;
  for (const item of contract.required) {
    for (const src of item.patterns) {
      try {
        const rx = new RegExp(src);
        if (rx.test(commandString)) return item;
      } catch {}
    }
  }
  return null;
}

export function outstanding(contract) {
  if (!contract || !Array.isArray(contract.required)) return [];
  return contract.required.filter((r) => !r.satisfied || r.failed);
}

export function unsatisfiedPrereqs(contract, requirement) {
  if (!contract || !requirement || !Array.isArray(requirement.requires)) return [];
  const byId = new Map((contract.required ?? []).map((r) => [r.id, r]));
  const missing = [];
  for (const depId of requirement.requires) {
    const dep = byId.get(depId);
    if (!dep) continue;
    if (!dep.satisfied || dep.failed) missing.push(dep);
  }
  return missing;
}

export function normalizePromptPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.prompt === 'string') return payload.prompt;
  if (typeof payload.initialPrompt === 'string') return payload.initialPrompt;
  return '';
}

export function normalizeBashPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (typeof payload.tool_name === 'string' && payload.tool_input) {
    const cmd = payload.tool_input.command ?? '';
    const resp = payload.tool_response ?? {};
    return {
      source: 'claude-code',
      tool: payload.tool_name,
      command: String(cmd),
      exitCode: typeof resp.exitCode === 'number'
        ? resp.exitCode
        : (typeof resp.exit_code === 'number' ? resp.exit_code : 0),
      stderr: String(resp.stderr ?? resp.error ?? ''),
      isShell: payload.tool_name === 'Bash' || payload.tool_name === 'PowerShell',
    };
  }

  if (typeof payload.toolName === 'string') {
    let args = {};
    try {
      args = typeof payload.toolArgs === 'string' ? JSON.parse(payload.toolArgs) : (payload.toolArgs ?? {});
    } catch {}
    const command = String(args.command ?? args.cmd ?? args.script ?? '');
    const resultType = payload.toolResult?.resultType ?? 'success';
    const stderr = String(payload.toolResult?.textResultForLlm ?? '');
    return {
      source: 'copilot',
      tool: payload.toolName,
      command,
      exitCode: resultType === 'success' ? 0 : (resultType === 'denied' ? 126 : 1),
      stderr: resultType === 'success' ? '' : stderr,
      isShell: Boolean(command),
    };
  }

  return null;
}

export function readStdinJson() {
  return new Promise((resolvePromise) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {});
      } catch {
        resolvePromise({});
      }
    });
    process.stdin.on('error', () => resolvePromise({}));
  });
}

export function emitDecision(payload) {
  process.stdout.write(JSON.stringify(payload));
}
