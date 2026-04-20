/**
 * Shared helpers for the data/listings.md tracker table.
 *
 * The tracker is an 11-column markdown table:
 *   # | Date | Address | City | Price | Beds/Baths | SqFt | Score | Status | Report | Notes
 *
 * STATUS_RANK ordering controls which status survives a merge or dedup pass:
 * `closed`/`sold` are terminal, `under contract` outranks earlier states,
 * `passed` and `evaluated` tie because both end the buyer's interest.
 */

export const STATUS_RANK = {
  'new': 0,
  'evaluated': 1,
  'passed': 1,
  'skip': 0,
  'interested': 2,
  'tour scheduled': 3,
  'toured': 4,
  'offer submitted': 5,
  'under contract': 6,
  'closed': 7,
  'sold': 7,
};

export function parseListingRow(line, lineIndex = -1) {
  const columns = line.split('|').map((value) => value.trim()).filter(Boolean);
  if (columns.length !== 11) {
    return null;
  }

  const num = Number.parseInt(columns[0], 10);
  if (Number.isNaN(num)) {
    return null;
  }

  return {
    num,
    date: columns[1],
    address: columns[2],
    city: columns[3],
    price: columns[4],
    bedsBaths: columns[5],
    sqft: columns[6],
    score: columns[7],
    status: columns[8],
    report: columns[9],
    notes: columns[10] || '',
    lineIndex,
  };
}

export function serializeListing(entry) {
  return `| ${entry.num} | ${entry.date} | ${entry.address} | ${entry.city} | ${entry.price} | ${entry.bedsBaths} | ${entry.sqft} | ${entry.score} | ${entry.status} | ${entry.report} | ${entry.notes} |`;
}

export function parseScore(value) {
  const match = value.replace(/\*\*/g, '').match(/([\d.]+)/);
  return match ? Number.parseFloat(match[1]) : 0;
}

export function parseReportNumber(value) {
  const match = value.match(/\[(\d+)\]/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function mergeNotes(...values) {
  const seen = new Set();
  const merged = [];

  values
    .flatMap((value) => (value || '').split(/\s*\.\s*/))
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      merged.push(value);
    });

  return merged.join('. ');
}

export function chooseBetterStatus(left, right) {
  const leftRank = STATUS_RANK[left.toLowerCase()] ?? 0;
  const rightRank = STATUS_RANK[right.toLowerCase()] ?? 0;
  return rightRank > leftRank ? right : left;
}
