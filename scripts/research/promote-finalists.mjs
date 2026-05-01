#!/usr/bin/env node

/**
 * promote-finalists.mjs -- Auto-select top 3 from the shortlist and write them
 * to the "## Refined Top 3 After Deep" section of data/shortlist.md.
 *
 * Runs between deep-research-packet and shortlist-finalist-gate in the deep phase.
 * Ranks the shortlist top-10 by score and audit cleanliness, picks the top 3,
 * and writes them into the section so finalist-gate has rows to validate.
 */

import { readFileSync, writeFileSync } from 'fs';
import { ROOT, SHORTLIST_PATH } from '../shared/paths.mjs';
import {
  auditParsedReport,
  getCriticalAuditFindings,
  parseReport,
  parseShortlist,
} from './research-utils.mjs';

const SECTION_HEADERS = ['## Refined Top 3 After Deep', '## Refined Ranking After Deep'];

function scoreVerdict(score, clean) {
  const scoreStr = score != null ? `${score}/5` : 'N/A';
  if (score == null) return `${scoreStr} — unscored`;
  if (score >= 4.5) return `${scoreStr} — Strong finalist${clean ? '' : ' (gaps)'}`;
  if (score >= 4.0) return `${scoreStr} — Tour candidate${clean ? '' : ' (gaps)'}`;
  if (score >= 3.5) return `${scoreStr} — Plausible${clean ? '' : ' (gaps)'}`;
  return `${scoreStr} — Marginal${clean ? '' : ' (gaps)'}`;
}

function buildRow(rank, item) {
  const { row, score, clean, blockers } = item;
  const verdict = scoreVerdict(score, clean);
  const gapDetail = clean ? '' : `; audit gaps: ${blockers.map((b) => b.heading).join(', ')}`;
  const why = `Rank ${rank} by score${gapDetail}`;
  return `| ${rank} | ${row.address} | ${row.city} | ${verdict} | ${why} |`;
}

function replaceRefinedSection(content, newRows) {
  const lines = content.split(/\r?\n/);

  let sectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADERS.includes(lines[i].trim())) {
      sectionIdx = i;
      break;
    }
  }

  const tableHeader = '| Rank | Address | City | Updated Verdict | Why |';
  const tableSeparator = '|------|---------|------|-----------------|-----|';

  if (sectionIdx === -1) {
    // Section missing entirely — append it before ## Notes (or at end)
    const notesIdx = lines.findIndex((l) => l.trim() === '## Notes');
    const insertAt = notesIdx === -1 ? lines.length : notesIdx;
    const block = ['', SECTION_HEADERS[0], '', tableHeader, tableSeparator, ...newRows, ''];
    lines.splice(insertAt, 0, ...block);
    return lines.join('\n');
  }

  // Find the separator row within this section
  let sepIdx = -1;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith('|') && /\|[-\s|]+\|/.test(lines[i])) {
      sepIdx = i;
      break;
    }
    // Stop if we hit another section heading
    if (i !== sectionIdx && lines[i].trim().startsWith('## ')) break;
  }

  if (sepIdx === -1) {
    // No table yet — insert one right after the section heading
    const block = ['', tableHeader, tableSeparator, ...newRows];
    lines.splice(sectionIdx + 1, 0, ...block);
    return lines.join('\n');
  }

  // Find the end of the table (first line after separator that doesn't start with |)
  let tableEnd = sepIdx + 1;
  while (tableEnd < lines.length && lines[tableEnd].trim().startsWith('|')) {
    tableEnd++;
  }

  // Replace the data rows (everything from sepIdx+1 to tableEnd)
  lines.splice(sepIdx + 1, tableEnd - (sepIdx + 1), ...newRows);
  return lines.join('\n');
}

function main() {
  const shortlist = parseShortlist(ROOT);

  if (shortlist.top10.length === 0) {
    console.error('promote-finalists: no top-10 entries in data/shortlist.md — run evaluate first.');
    process.exit(1);
  }

  const evaluated = shortlist.top10.map((row) => {
    try {
      const report = parseReport(ROOT, row.reportPath);
      const audit = auditParsedReport(report);
      // Use non-strict warnings so only explicit coverage gaps block, not source-reference warnings
      const blockers = getCriticalAuditFindings(audit, {
        headings: ['Neighborhood Sentiment', 'School Review', 'Development and Infrastructure'],
        strictWarnings: false,
      });
      return { row, score: report.scoreNumber ?? 0, blockers, clean: blockers.length === 0 };
    } catch {
      return { row, score: -1, blockers: [], clean: false };
    }
  });

  // Rank: audit-clean first, then score descending
  evaluated.sort((a, b) => {
    if (a.clean !== b.clean) return (b.clean ? 1 : 0) - (a.clean ? 1 : 0);
    return b.score - a.score;
  });

  const top3 = evaluated.slice(0, 3);

  console.log('promote-finalists: top-3 selected from shortlist');
  top3.forEach((item, i) => {
    const gapNote = item.clean ? 'clean' : `gaps: ${item.blockers.map((b) => b.heading).join(', ')}`;
    console.log(`  ${i + 1}. ${item.row.address}, ${item.row.city} — ${item.score}/5 (${gapNote})`);
  });

  const newRows = top3.map((item, i) => buildRow(i + 1, item));
  const original = readFileSync(SHORTLIST_PATH, 'utf8');
  const updated = replaceRefinedSection(original, newRows);

  writeFileSync(SHORTLIST_PATH, updated, 'utf8');
  console.log('promote-finalists: data/shortlist.md updated with refined top-3.');
}

main();
