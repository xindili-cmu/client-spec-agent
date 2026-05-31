#!/usr/bin/env node
/**
 * v3.4 schema migration — add entity_type field
 *
 * Adds:
 *   - `entity_type: "VC"` to every entry in vcs.{incubator, early, late}
 *   - 4 new top-level empty arrays: spacSponsors, pipeInvestors, familyOffices, strategics
 *   - Bumps schemaVersion 2.1 → 2.2
 *   - Records migration in top-level _schemaHistory[]
 *
 * Idempotent: re-running detects existing entity_type and skips.
 *
 * Why entity_type: per [[project-fusionpark-positioning]], Cindy's matching is
 * target ↔ {VC, SPAC sponsor, PIPE investor, Family office, Strategic acquirer}.
 * Each has distinct fit dimensions. This migration is the schema prep for v3.5
 * Achievable Public Price model and v3.8 Matching Agent.
 *
 * Audit provenance: per [[project-audit-provenance-convention]] — schema migrations
 * use `cindy-decision-week3` namespace in _schemaHistory.
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_PATH = path.resolve('data.json');
const FROM_VERSION = '2.1';
const TO_VERSION = '2.2';
const NEW_ARRAYS = ['spacSponsors', 'pipeInvestors', 'familyOffices', 'strategics'];

async function main() {
  const raw = await fs.readFile(DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);

  // Check schema version
  if (data.schemaVersion === TO_VERSION) {
    console.log(`⏭ Already at schema ${TO_VERSION}, nothing to do`);
    return;
  }
  if (data.schemaVersion !== FROM_VERSION) {
    console.warn(`⚠ Expected schema ${FROM_VERSION}, found ${data.schemaVersion} — proceeding anyway`);
  }

  // Track what we did
  const stats = {
    vcsAddedEntityType: 0,
    vcsAlreadyTagged: 0,
    arraysAdded: [],
    arraysAlreadyExisted: [],
  };

  // 1. Add entity_type to all VC entries
  const tiers = ['incubator', 'early', 'late'];
  for (const tier of tiers) {
    const arr = data.vcs?.[tier];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (entry.entity_type === 'VC') {
        stats.vcsAlreadyTagged++;
      } else {
        entry.entity_type = 'VC';
        stats.vcsAddedEntityType++;
      }
    }
  }

  // 2. Add 4 new empty top-level arrays (don't overwrite if existing)
  for (const arrName of NEW_ARRAYS) {
    if (Array.isArray(data[arrName])) {
      stats.arraysAlreadyExisted.push(arrName);
    } else {
      data[arrName] = [];
      stats.arraysAdded.push(arrName);
    }
  }

  // 3. Bump schema version
  data.schemaVersion = TO_VERSION;

  // 4. Record schema history entry
  data._schemaHistory = data._schemaHistory || [];
  data._schemaHistory.push({
    migratedAt: new Date().toISOString(),
    appliedBy: 'cindy-decision-week3',
    from: FROM_VERSION,
    to: TO_VERSION,
    description: 'Add entity_type field to VCs + 4 new top-level arrays for SPAC sponsors / PIPE / Family / Strategic. Schema prep for v3.5 Price model + v3.8 Matching Agent.',
    stats,
  });

  // Write back
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));

  // Report
  console.log('✓ Migration complete');
  console.log(`  schemaVersion: ${FROM_VERSION} → ${TO_VERSION}`);
  console.log(`  VCs tagged with entity_type=VC: ${stats.vcsAddedEntityType} (already tagged: ${stats.vcsAlreadyTagged})`);
  console.log(`  Top-level arrays added: ${stats.arraysAdded.join(', ') || '(none)'}`);
  if (stats.arraysAlreadyExisted.length) {
    console.log(`  Top-level arrays already existed: ${stats.arraysAlreadyExisted.join(', ')}`);
  }
  console.log(`  _schemaHistory entries: ${data._schemaHistory.length}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
