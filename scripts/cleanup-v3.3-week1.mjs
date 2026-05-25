#!/usr/bin/env node
/**
 * One-off cleanup for v3.3 week-1 false positives.
 *
 * Run once after `git pull` brings the post-v3.3 Action mutations into local main:
 *   node scripts/cleanup-v3.3-week1.mjs
 *
 * Reverts 3 known false-positive auto-applies:
 *   1. Oklo $1.2B (biggo.com "Meta prepayment" mistaken for equity round)
 *   2. Mantle8 $44M (wrong EUR→USD conversion; €31M ≈ $33M, not $44M)
 *   3. Last Energy duplicate _audit entries (same Series C event clustered as 2)
 *
 * Idempotent: detects whether each mutation is present before touching it.
 * Skips silently if state doesn't match (e.g., already cleaned up, or new mutation
 * happened that doesn't match the original false-positive pattern).
 *
 * After running, inspect with: git diff data.json
 * Then commit + push if it looks right.
 *
 * Delete this script after running — it's a one-off historical artifact.
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_PATH = path.resolve('data.json');

function findStartup(data, idOrName) {
  return data.startups.find(s =>
    s.id === idOrName ||
    s.name.toLowerCase() === idOrName.toLowerCase() ||
    s.id?.toLowerCase().includes(idOrName.toLowerCase()),
  );
}

function logState(label, s) {
  console.log(`  [${label}] round=${JSON.stringify(s.round)} source=${(s.source || '').slice(0, 80)} _audit=${s._audit?.length || 0}`);
}

function revertOneAuditEntry(s) {
  if (!s._audit?.length) return false;
  const last = s._audit[s._audit.length - 1];
  if (!last.previousState) return false;
  if (last.previousState.round) s.round = last.previousState.round;
  if ('source' in last.previousState && last.previousState.source) {
    s.source = last.previousState.source;
  }
  if ('status' in last.previousState && last.previousState.status !== null) {
    s.status = last.previousState.status;
  }
  if ('ticker' in last.previousState) {
    if (last.previousState.ticker === null) delete s.ticker;
    else s.ticker = last.previousState.ticker;
  }
  s._audit.pop();
  return true;
}

async function main() {
  const data = JSON.parse(await fs.readFile(DATA_PATH, 'utf-8'));
  let changedCount = 0;

  // ============ 1. Oklo $1.2B revert ============
  console.log('\n=== Oklo ===');
  const oklo = findStartup(data, 'oklo');
  if (!oklo) {
    console.log('  ✗ Not found in data.json — skipping');
  } else {
    logState('before', oklo);
    if (Math.round(oklo.round?.amount || 0) === 1200) {
      const reverted = revertOneAuditEntry(oklo);
      if (reverted) {
        logState('after ', oklo);
        console.log('  ✓ Reverted Oklo $1.2B → previous round (likely SPAC merger $306M)');
        changedCount++;
      } else {
        console.log('  ⚠ Amount is $1.2B but no _audit entry to revert from — manual fix needed');
      }
    } else {
      console.log(`  ⏭ Skipping — current amount is $${oklo.round?.amount}M, not $1.2B (already clean or different state)`);
    }
  }

  // ============ 2. Mantle8 $44M revert ============
  console.log('\n=== Mantle8 ===');
  const mantle = findStartup(data, 'mantle8');
  if (!mantle) {
    console.log('  ✗ Not found in data.json — skipping');
  } else {
    logState('before', mantle);
    if (mantle.round?.amount === 44 || mantle.round?.amount === 44.0) {
      const reverted = revertOneAuditEntry(mantle);
      if (reverted) {
        logState('after ', mantle);
        console.log('  ✓ Reverted Mantle8 $44M → previous round (should be $36M from CTVC)');
        changedCount++;
      } else {
        console.log('  ⚠ Amount is $44M but no _audit entry to revert from — manual fix needed');
      }
    } else {
      console.log(`  ⏭ Skipping — current amount is $${mantle.round?.amount}M, not $44M (already clean or different state)`);
    }
  }

  // ============ 3. Last Energy duplicate _audit collapse ============
  console.log('\n=== Last Energy ===');
  const lastEnergy = findStartup(data, 'lastenergy') || findStartup(data, 'last energy') || findStartup(data, 'last-energy');
  if (!lastEnergy) {
    console.log('  ✗ Not found in data.json — skipping');
  } else {
    logState('before', lastEnergy);
    const audits = lastEnergy._audit || [];
    // Detect duplicate: 2+ consecutive update_round entries for the same Series C $100M event
    const sameEventAudits = audits.filter(a =>
      a.action === 'update_round' &&
      (a.reason || '').toLowerCase().includes('series c') &&
      (a.reason || '').includes('100')
    );
    if (sameEventAudits.length >= 2) {
      // Keep the LATEST one (most recent applied), and reset its previousState
      // to the OLDEST entry's previousState (the true pre-v3.3 state)
      const oldest = sameEventAudits[0];
      const latest = sameEventAudits[sameEventAudits.length - 1];
      const merged = { ...latest, previousState: oldest.previousState };
      // Replace all sameEventAudits with single merged entry
      const newAudits = audits.filter(a => !sameEventAudits.includes(a));
      newAudits.push(merged);
      lastEnergy._audit = newAudits;
      logState('after ', lastEnergy);
      console.log(`  ✓ Collapsed ${sameEventAudits.length} duplicate Series C $100M audit entries into 1 with correct previousState`);
      changedCount++;
    } else {
      console.log(`  ⏭ Skipping — found ${sameEventAudits.length} matching audit entries (need ≥2 to collapse)`);
    }
  }

  // ============ Save ============
  if (changedCount > 0) {
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    console.log(`\n✓ Wrote ${DATA_PATH} with ${changedCount} startup(s) cleaned up`);
    console.log(`\nNext steps:`);
    console.log(`  1. git diff data.json   # verify the reverts look right`);
    console.log(`  2. git add data.json scripts/refresh.js scripts/cleanup-v3.3-week1.mjs`);
    console.log(`  3. git commit -m "fix: v3.3.1 cluster window 30d + domain blocklist + week1 cleanup"`);
    console.log(`  4. git push`);
    console.log(`  5. (optional) delete scripts/cleanup-v3.3-week1.mjs since it's a one-off`);
  } else {
    console.log(`\n⏭ No changes made (data.json already clean or in unexpected state)`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
