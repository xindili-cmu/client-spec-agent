#!/usr/bin/env node
/**
 * Week 3 backfill — ECOR Global public-info enrichment from v3.6 research-agent run.
 *
 * Adds layer-1 public info surfaced by `scripts/research-agent/run.mjs` on 2026-05-30:
 *   - Legal entity disambiguation (Noble Environmental Technologies, formerly Kiva)
 *   - CEO Jay Potter's prior NASDAQ board experience (Beam Global director 2006-2018)
 *   - Co-founder Robert L. Noble
 *   - Most recent public funding event (Phalanx Impact Partners, 2023-11)
 *   - Aggregate funding estimate ~$20M per third-party trackers (kept amount=null since
 *     individual rounds are undisclosed; only aggregate from trackers is known)
 *
 * Source: /Users/lilali/climate agent/research-reports/ecor-global/research-report.md
 * Idempotent: detects existing backfill via tech-string containing "Noble Environmental"
 * Audit provenance: cindy-decision-week3 per [[project-audit-provenance-convention]]
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_PATH = path.resolve('data.json');

async function main() {
  const raw = await fs.readFile(DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);

  const ecor = data.startups.find((s) => s.id === 'ecor');
  if (!ecor) {
    console.error('Ecor entry not found in data.json');
    process.exit(1);
  }

  // Idempotency
  if (ecor.tech.includes('Noble Environmental Technologies')) {
    console.log('⏭ Skipping — Ecor already has Noble Environmental backfill applied');
    return;
  }

  // Snapshot previousState BEFORE mutation
  const previousState = {
    tech: ecor.tech,
    round: JSON.parse(JSON.stringify(ecor.round)),
    leadership: JSON.parse(JSON.stringify(ecor.leadership)),
    recentNews: [...(ecor.recentNews || [])],
  };

  // 1. tech — append legal entity disambiguation
  ecor.tech =
    ecor.tech +
    ' Legal entity: Noble Environmental Technologies, Inc. (formerly Kiva Advanced Environmental Technologies).';

  // 2. round — record most recent known event + aggregate caveat in type; keep amount=null
  ecor.round = {
    type: 'Strategic growth (2023-11, amount undisclosed); ~$20M aggregate to date per third-party trackers (PitchBook / Tracxn / Crunchbase)',
    amount: null,
    date: '2023-11-20',
    lead: 'Phalanx Impact Partners (2023 strategic); Keshif Ventures (2014 Series A, undisclosed)',
  };

  // 3. CEO bg — append Beam Global NASDAQ board role (most SPAC-relevant single fact)
  ecor.leadership.ceo.bg =
    "25-year clean-tech veteran; has directed $85M+ into sustainability / circularity ventures. Director at Beam Global 2006-2018, through that company's NASDAQ listing. Founded GreenCore Capital in 2008. Aerospace engineering background.";

  // 4. Add co-founder Robert L. Noble
  ecor.leadership.cofounders = [
    {
      name: 'Robert L. Noble',
      title: 'Co-Founder',
      bg: 'Co-founded company with Jay Potter in 2006; legal entity Noble Environmental Technologies is named after him.',
    },
  ];

  // 5. recentNews — add 2023 Phalanx event
  ecor.recentNews = ecor.recentNews || [];
  ecor.recentNews.push({
    date: '2023-11',
    text: 'Strategic investment from Phalanx Impact Partners to accelerate pre-construction of first U.S. manufacturing facility and expand Serbian operations',
  });

  // 6. Audit
  ecor._audit = ecor._audit || [];
  ecor._audit.push({
    appliedAt: new Date().toISOString(),
    appliedBy: 'cindy-decision-week3',
    action: 'backfill_public_info',
    reason:
      'Public-info layer 1 backfill from v3.6 research-agent run on 2026-05-30. Adds legal entity disambiguation, CEO NASDAQ board experience, co-founder, most recent funding event. All sources from research-report Sources section.',
    source:
      'https://www.businesswire.com/news/home/20231120099344/en/ECOR-Global-Inc.-Secures-Funding-from-Phalanx-Impact-Partners-to-Accelerate-Capital-Projects',
    sourceTitle:
      'BusinessWire — ECOR Global Secures Funding from Phalanx Impact Partners (2023-11-20)',
    researchReport: 'research-reports/ecor-global/research-report.md',
    previousState,
  });

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));

  console.log('✓ Ecor public-info backfilled');
  console.log('  Legal entity: Noble Environmental Technologies added to tech');
  console.log('  Round: Phalanx 2023 + ~$20M aggregate (amount stays null per discipline)');
  console.log('  CEO bg: Beam Global NASDAQ board director 2006-2018 added');
  console.log('  Co-founder: Robert L. Noble added');
  console.log('  recentNews: Phalanx 2023 entry added');
  console.log('  _audit entries: ' + ecor._audit.length);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
