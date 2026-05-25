#!/usr/bin/env node
/**
 * One-off cleanup for v3.3.1 week-2 false positives.
 *
 * Run AFTER verifying the Form Energy TechCrunch article yourself:
 *   https://techcrunch.com/2026/02/26/google-paid-startup-form-energy-1b-for-its-massive-100-hour-battery/
 *
 * If the article says "Google INVESTED $1B in Series G" → Form Energy update is LEGIT.
 *   Run with KEEP_FORM_ENERGY=true to only revert Mantle8:
 *     KEEP_FORM_ENERGY=true node scripts/cleanup-v3.3-week2.mjs
 *
 * If the article says "Google PAID/PURCHASED/PREPAID $1B for batteries" → commercial deal, not equity.
 *   Run normally (default reverts both):
 *     node scripts/cleanup-v3.3-week2.mjs
 *
 * Mantle8 is ALWAYS reverted — the €31M → $44M currency conversion is provably wrong
 * (€31M × 1.07 ≈ $33M USD, not $44M; the stored $36M from CTVC is closer to truth).
 *
 * Idempotent — detects state before mutating.
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_PATH = path.resolve('data.json');
const KEEP_FORM_ENERGY = process.env.KEEP_FORM_ENERGY === 'true';

function findStartup(data, id) {
  return data.startups.find(s => s.id === id || s.name.toLowerCase() === id.toLowerCase());
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

  // ============ 1. Form Energy $1B revert (conditional) ============
  console.log('\n=== Form Energy ===');
  if (KEEP_FORM_ENERGY) {
    console.log('  ⏭ KEEP_FORM_ENERGY=true — skipping Form Energy revert (Cindy verified $1B is real equity)');
  } else {
    const form = findStartup(data, 'form');
    if (!form) {
      console.log('  ✗ Not found in data.json — skipping');
    } else {
      logState('before', form);
      // Match the specific false positive: $1B Series G with Google as lead from Feb 2026
      const isFalsePositive = form.round?.amount === 1000
        && form.round?.lead?.includes('Google')
        && form.round?.date === '2026-02-26';
      if (isFalsePositive) {
        const reverted = revertOneAuditEntry(form);
        if (reverted) {
          logState('after ', form);
          console.log('  ✓ Reverted Form Energy $1B Google → previous Series F $405M (Google "paid" = commercial purchase, not equity)');
          changedCount++;
        } else {
          console.log('  ⚠ Matches false positive pattern but no _audit to revert — manual fix needed');
        }
      } else {
        console.log(`  ⏭ Skipping — current state does not match the Feb 2026 Google $1B false positive`);
      }
    }
  }

  // ============ 2. Mantle8 $44M revert (always, currency math is provably wrong) ============
  console.log('\n=== Mantle8 ===');
  const mantle = findStartup(data, 'mantle8');
  if (!mantle) {
    console.log('  ✗ Not found in data.json — skipping');
  } else {
    logState('before', mantle);
    if (mantle.round?.amount === 44) {
      const reverted = revertOneAuditEntry(mantle);
      if (reverted) {
        logState('after ', mantle);
        console.log('  ✓ Reverted Mantle8 $44M → previous $36M (€31M ≈ $33M USD, not $44M; CTVC value is closer)');
        changedCount++;
      } else {
        console.log('  ⚠ Amount is $44M but no _audit to revert — manual fix needed');
      }
    } else {
      console.log(`  ⏭ Skipping — current amount is $${mantle.round?.amount}M, not $44M`);
    }
  }

  // ============ Save ============
  if (changedCount > 0) {
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    console.log(`\n✓ Wrote ${DATA_PATH} with ${changedCount} startup(s) cleaned up`);
    console.log(`\nNext steps:`);
    console.log(`  1. git diff data.json   # verify reverts look right`);
    console.log(`  2. git add data.json scripts/cleanup-v3.3-week2.mjs`);
    console.log(`  3. git commit -m "fix: v3.3.2 week2 cleanup — revert Form Energy + Mantle8 false positives"`);
    console.log(`  4. git push`);
    console.log(`  5. (separately) add AUTO_APPLY_THRESHOLD=0.9 to GitHub Secrets`);
  } else {
    console.log(`\n⏭ No changes made (data.json already clean or KEEP_FORM_ENERGY blocked Mantle8 too)`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
