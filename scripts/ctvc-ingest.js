#!/usr/bin/env node
/**
 * CTVC weekly ingestion orchestrator (v3.2)
 *
 * Flow:
 *   1. Fetch latest CTVC issue via Exa (or N issues if backfill mode)
 *   2. Parse deals via deterministic regex (ctvc-parser.js)
 *   3. For each candidate, run Critic Agent (critic.js)
 *   4. Apply verdicts:
 *      - accept → push to data.json with discoveredVia field
 *      - duplicate → log + maybe trigger status update
 *      - reject → log with reason (no action)
 *      - needs_human → add to email digest under "needs review"
 *   5. Return summary for refresh.js to roll into email
 *
 * Environment:
 *   EXA_API_KEY — required (already used by refresh.js)
 *   ANTHROPIC_API_KEY — required (new, for Critic Agent)
 *   BACKFILL_ISSUES — optional, comma-separated CTVC issue URLs for one-time backfill
 */

import fs from 'fs/promises';
import path from 'path';
import { criticReview } from './critic.js';
import { parseLine, splitIntoDealLines } from './ctvc-parser-lib.js';

const EXA_API_KEY = process.env.EXA_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Find latest CTVC issue URL via Exa.
 * Returns the most recent ctvc.co/[slug-N]/ URL.
 */
async function findLatestCtvcIssue() {
  if (DRY_RUN) return null;
  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': EXA_API_KEY },
    body: JSON.stringify({
      query: 'CTVC climate tech VC weekly newsletter Sunday briefing deals of the week',
      numResults: 3,
      type: 'auto',
      contents: { text: { maxCharacters: 200 } },
      includeDomains: ['ctvc.co'],
      startPublishedDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  });
  if (!res.ok) {
    console.warn(`Exa search for CTVC: ${res.status}`);
    return null;
  }
  const data = await res.json();
  const issues = (data.results || [])
    .filter(r => /ctvc\.co\/[a-z0-9-]+\-\d+\/?$/i.test(r.url))
    .sort((a, b) => new Date(b.publishedDate) - new Date(a.publishedDate));
  return issues[0]?.url || null;
}

async function fetchIssueText(url) {
  if (DRY_RUN) return '';
  const res = await fetch('https://api.exa.ai/contents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': EXA_API_KEY },
    body: JSON.stringify({
      urls: [url],
      text: { maxCharacters: 15000 },
    }),
  });
  if (!res.ok) {
    console.warn(`Exa fetch ${url}: ${res.status}`);
    return '';
  }
  const data = await res.json();
  return data.results?.[0]?.text || '';
}

/**
 * Run Critic on candidates with light concurrency control (avoid rate limit).
 */
async function reviewAll(candidates, context) {
  const verdicts = [];
  // Sequential to be safe with Anthropic rate limits; can parallelize later
  for (const candidate of candidates) {
    try {
      const verdict = await criticReview(candidate, context);
      verdicts.push({ candidate, verdict });
    } catch (e) {
      console.error(`Critic error for ${candidate.name}: ${e.message}`);
      verdicts.push({
        candidate,
        verdict: { decision: 'needs_human', confidence: 0, reason: `Critic error: ${e.message}` },
      });
    }
    await new Promise(r => setTimeout(r, 150)); // gentle pacing
  }
  return verdicts;
}

/**
 * Apply a verdict to data.json (mutating data in place).
 * Returns the new entry if accept, null otherwise.
 */
function applyVerdict(data, candidate, verdict, issueUrl) {
  if (verdict.decision !== 'accept') return null;

  const newEntry = {
    id: verdict.suggested_id || candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
    name: candidate.name,
    sector: verdict.suggested_sector || candidate.sector || 'other',
    hq: candidate.hq,
    status: candidate.kind === 'ipo' ? 'public' : 'private',
    tech: candidate.tech,
    round: candidate.kind === 'funding' ? {
      type: candidate.roundType,
      amount: candidate.amount,
      date: new Date().toISOString().slice(0, 7), // YYYY-MM
      lead: candidate.leadInvestor,
    } : null,
    cindyVCBackers: [], // populated below from context match
    source: issueUrl,
    discoveredVia: `CTVC-${new Date().toISOString().slice(0, 10)}`,
    criticReason: verdict.reason,
    criticConfidence: verdict.confidence,
    leadership: { ceo: null, cofounders: [], board: [], introPaths: [] },
    recentNews: [{
      date: new Date().toISOString().slice(0, 7),
      text: `Auto-added from CTVC: ${candidate.kind === 'ipo' ? `IPO at $${candidate.amount}M on ${candidate.exchange} (${candidate.ticker})` : `${candidate.roundType} $${candidate.amount}M led by ${candidate.leadInvestor}`}`,
    }],
  };

  // Cross-reference investors against Cindy VC universe
  const vcSet = new Set((data.vcs?.incubator || []).concat(data.vcs?.early || [], data.vcs?.late || []).map(v => v.name.toLowerCase()));
  newEntry.cindyVCBackers = (candidate.investors || []).filter(inv =>
    [...vcSet].some(vc => inv.toLowerCase().includes(vc) || vc.includes(inv.toLowerCase()))
  );

  data.startups.push(newEntry);
  return newEntry;
}

/**
 * Main: process one or more CTVC issues, return summary.
 */
export async function ingestCtvc(data, options = {}) {
  const issueUrls = options.backfillUrls || [];
  if (issueUrls.length === 0) {
    const latest = await findLatestCtvcIssue();
    if (latest) issueUrls.push(latest);
  }

  if (issueUrls.length === 0) {
    console.warn('No CTVC issues found to process');
    return { processed: 0, accepted: [], duplicates: [], rejected: [], needsHuman: [] };
  }

  const allCandidates = [];
  for (const url of issueUrls) {
    console.log(`[ctvc] Fetching ${url}`);
    const text = await fetchIssueText(url);
    const lines = splitIntoDealLines(text);
    const parsed = lines.map(parseLine).filter(Boolean);
    parsed.forEach(p => p._sourceUrl = url);
    allCandidates.push(...parsed);
    console.log(`[ctvc] ${url}: ${parsed.length} candidates parsed`);
  }

  const vcUniverse = [...(data.vcs?.incubator || []), ...(data.vcs?.early || []), ...(data.vcs?.late || [])].map(v => v.name);

  console.log(`[ctvc] Running Critic on ${allCandidates.length} candidates`);
  const verdicts = await reviewAll(allCandidates, {
    issueDate: new Date().toISOString().slice(0, 10),
    existingStartups: data.startups,
    vcUniverse,
  });

  const accepted = [], duplicates = [], rejected = [], needsHuman = [];
  for (const { candidate, verdict } of verdicts) {
    if (verdict.decision === 'accept') {
      const entry = applyVerdict(data, candidate, verdict, candidate._sourceUrl);
      if (entry) accepted.push({ candidate, verdict, entry });
    } else if (verdict.decision === 'duplicate') {
      duplicates.push({ candidate, verdict });
    } else if (verdict.decision === 'needs_human') {
      needsHuman.push({ candidate, verdict });
    } else {
      rejected.push({ candidate, verdict });
    }
  }

  console.log(`[ctvc] Critic verdicts: ${accepted.length} accept · ${duplicates.length} dup · ${needsHuman.length} human · ${rejected.length} reject`);

  return {
    processed: allCandidates.length,
    issueUrls,
    accepted,
    duplicates,
    rejected,
    needsHuman,
  };
}

// CLI mode for backfill: node ctvc-ingest.js <data.json> [url1 url2 ...]
if (import.meta.url === `file://${process.argv[1]}`) {
  const dataPath = process.argv[2] || './data.json';
  const backfillUrls = process.argv.slice(3);
  const data = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
  const result = await ingestCtvc(data, { backfillUrls });
  await fs.writeFile(dataPath, JSON.stringify(data, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(`Accepted: ${result.accepted.length}`);
  result.accepted.forEach(a => console.log(`  + ${a.entry.name} (${a.entry.sector}) — ${a.verdict.reason}`));
  console.log(`Duplicates: ${result.duplicates.length}`);
  result.duplicates.forEach(d => console.log(`  = ${d.candidate.name} → ${d.verdict.duplicate_of}`));
  console.log(`Needs human: ${result.needsHuman.length}`);
  result.needsHuman.forEach(n => console.log(`  ? ${n.candidate.name} — ${n.verdict.reason}`));
  console.log(`Rejected: ${result.rejected.length}`);
}
