#!/usr/bin/env node
/**
 * Add ECOR Global as a new startup entry to data.json.
 *
 * Source: ECOR Global official website (https://ecorglobal.com/) + RocketReach public profile.
 * Per [[project-andrew-vdr-automation]] confidentiality tier — this entry is LAYER 1 only
 * (publicly available info from company website / public press). No deal-status info, no
 * VDR contents, no Cindy-internal relationship data.
 *
 * Idempotent: skips if a startup with id="ecor" already exists.
 *
 * Audit provenance: per [[project-audit-provenance-convention]] — uses cindy-decision-week3.
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_PATH = path.resolve('data.json');

const ECOR_ENTRY = {
  id: 'ecor',
  name: 'ECOR Global',
  sector: 'industrial-decarb',
  hq: 'La Jolla, CA (HQ); Tavnik, Serbia (manufacturing)',
  status: 'private',
  tech: 'Converts agricultural and urban waste cellulose fibers into sustainable building panels replacing traditional wood-based products. 100% bio-based, no urea formaldehyde / isocyanides. Panel thickness 1.8-16mm. Customer roster includes Mars, Google, Amazon, Whole Foods, Hunter Douglas, General Mills.',
  round: {
    type: 'Private — funding history not publicly disclosed',
    amount: null,
    date: null,
    lead: null,
  },
  cindyVCBackers: [],
  source: 'https://ecorglobal.com/',
  leadership: {
    ceo: {
      name: 'Jay Potter',
      title: 'Founder & CEO',
      bg: '25-year clean-tech veteran; has directed $85M+ into sustainability / circularity ventures',
    },
    cofounders: [],
    board: [],
    introPaths: [],
  },
  recentNews: [],
  _audit: [
    {
      appliedAt: new Date().toISOString(),
      appliedBy: 'cindy-decision-week3',
      action: 'add_startup',
      reason: 'Manually added — Cindy active target. Public-info layer 1 only per Ecor confidentiality constraint discussed 2026-05-26.',
      source: 'https://ecorglobal.com/',
      sourceTitle: 'ECOR Global - Home Page (official site)',
      previousState: null,
    },
  ],
};

async function main() {
  const raw = await fs.readFile(DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data.startups)) {
    console.error('Unexpected: data.startups is not an array');
    process.exit(1);
  }

  // Idempotency check
  const existing = data.startups.find((s) => s.id === 'ecor');
  if (existing) {
    console.log('⏭ Skipping — startup with id="ecor" already exists');
    console.log('  current name:', existing.name);
    console.log('  current source:', existing.source);
    return;
  }

  // Append
  data.startups.push(ECOR_ENTRY);

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));

  console.log('✓ Added ECOR Global to data.json');
  console.log(`  Total startups: ${data.startups.length}`);
  console.log(`  Sector: ${ECOR_ENTRY.sector}`);
  console.log(`  HQ: ${ECOR_ENTRY.hq}`);
  console.log(`  CEO: ${ECOR_ENTRY.leadership.ceo.name}`);
  console.log(`  Public funding info: not disclosed (round.amount = null)`);
  console.log();
  console.log('Next: review with `git diff data.json`, then commit + push.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
