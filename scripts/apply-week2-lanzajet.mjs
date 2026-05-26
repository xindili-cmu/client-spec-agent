#!/usr/bin/env node
/**
 * One-off apply for one of week-2's needs_review items.
 *
 * Updates LanzaJet round.type to reflect that the recorded $47M is a 1st close
 * of a $135M planned round (per ESGPost article verified by Cindy 2026-05-25).
 *
 * Keeps amount=47, date=2026-02-19, lead unchanged. Only type changes:
 *   "Series funding" → "1st close (of $135M planned)"
 *
 * Adds _audit entry attributing the change to "cindy-decision-week2"
 * (distinct from "critic-round-v3.3" so future audits can tell the two apart).
 *
 * Idempotent — detects current state before mutating.
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_PATH = path.resolve('data.json');
const NEW_TYPE = '1st close (of $135M planned)';
const TARGET_AMOUNT = 47;
const TARGET_DATE = '2026-02-19';

async function main() {
  const data = JSON.parse(await fs.readFile(DATA_PATH, 'utf-8'));
  const lanza = data.startups.find(s => s.id === 'lanzajet' || s.name === 'LanzaJet');
  if (!lanza) {
    console.error('LanzaJet not found in data.json');
    process.exit(1);
  }

  console.log('=== LanzaJet ===');
  console.log(`  [before] round = ${JSON.stringify(lanza.round)}`);

  // Idempotency check
  if (lanza.round?.type === NEW_TYPE) {
    console.log(`  ⏭ Skipping — round.type is already "${NEW_TYPE}"`);
    return;
  }

  // Safety check — only apply if amount + date match what we expect
  if (lanza.round?.amount !== TARGET_AMOUNT || lanza.round?.date !== TARGET_DATE) {
    console.log(`  ⚠ Round state has shifted (amount=${lanza.round?.amount}, date=${lanza.round?.date})`);
    console.log(`     Expected amount=${TARGET_AMOUNT}, date=${TARGET_DATE}. Bailing to avoid bad mutation.`);
    process.exit(1);
  }

  // Snapshot previous state for audit
  const previousState = {
    round: JSON.parse(JSON.stringify(lanza.round)),
    status: lanza.status ?? null,
    ticker: lanza.ticker ?? null,
    source: lanza.source ?? null,
  };

  // Mutate
  lanza.round.type = NEW_TYPE;

  // Append audit entry
  lanza._audit = lanza._audit || [];
  lanza._audit.push({
    appliedAt: new Date().toISOString(),
    appliedBy: 'cindy-decision-week2',
    action: 'update_round',
    confidence: 1.0,
    reason: 'Cindy verified ESGPost article: $47M is 1st close of $135M planned round; updating type field to reflect partial-close structure',
    source: 'https://esgpost.com/lanzajet-secures-first-close-of-135m-equity-round-to-scale-saf-technology/',
    sourceTitle: 'LanzaJet secures first close of $135m equity round to scale SAF technology',
    previousState,
  });

  console.log(`  [after]  round = ${JSON.stringify(lanza.round)}`);
  console.log(`  [audit]  +1 entry by cindy-decision-week2`);

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`\n✓ Wrote ${DATA_PATH}`);
  console.log(`\nNext steps:`);
  console.log(`  1. git diff data.json`);
  console.log(`  2. git add data.json scripts/apply-week2-lanzajet.mjs`);
  console.log(`  3. git commit -m "feat: week2 manual decision — LanzaJet type updated to '1st close (of $135M planned)'"`);
  console.log(`  4. git push`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
