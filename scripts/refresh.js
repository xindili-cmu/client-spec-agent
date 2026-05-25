#!/usr/bin/env node
/**
 * FusionPark Climate Tech Intelligence — weekly refresh
 *
 * Runs from GitHub Actions every Monday 9am UTC.
 * For each of 26 startups:
 *   1. Query Exa for new funding rounds (last 12 months)
 *   2. Query Exa for recent news (last 30 days)
 *   3. Extract structured candidates via regex
 *   4. Diff against current data.json
 *   5. Write changelog markdown
 *   6. Send email digest via Resend
 *   7. Update data.json's dataAsOf field
 *
 * IMPORTANT: this script DETECTS candidates and surfaces them in
 * the email + changelog. It does NOT auto-modify the round/leadership
 * fields in data.json (those changes are reviewed manually by Cindy
 * to avoid fabrication risk — see [[feedback-prototype-discipline]]).
 *
 * Environment variables required:
 *   EXA_API_KEY      — exa.ai REST API key
 *   RESEND_API_KEY   — resend.com API key (optional, email skipped if missing)
 *   EMAIL_TO         — recipient email (default cindylips2001@gmail.com)
 *   DRY_RUN          — set to 'true' to skip Exa/Resend calls and just print
 */

import fs from 'fs/promises';
import path from 'path';
import { ingestCtvc } from './ctvc-ingest.js';
import { criticRoundCandidate } from './critic.js';

const EXA_API_KEY = process.env.EXA_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO || 'cindylips2001@gmail.com';
const DRY_RUN = process.env.DRY_RUN === 'true';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://climate-intel.pages.dev';
const SKIP_CTVC = process.env.SKIP_CTVC === 'true';
const CURRENT_YEAR = new Date().getFullYear();
const LAST_YEAR = CURRENT_YEAR - 1;

// v3.3: Confidence threshold for auto-mutating data.json.
// Critic verdicts below this confidence get routed to needsReview instead of applied.
// Override with env var AUTO_APPLY_THRESHOLD (e.g., "0.9" for stricter, "0.7" for looser).
const AUTO_APPLY_THRESHOLD = parseFloat(process.env.AUTO_APPLY_THRESHOLD || '0.85');
const ACCEPT_ACTIONS = ['update_round', 'update_status', 'merge_info'];

const DATA_PATH = path.resolve('data.json');
const CHANGELOG_DIR = path.resolve('data');

if (!DRY_RUN && !EXA_API_KEY) {
  console.error('FATAL: EXA_API_KEY env var is required');
  process.exit(1);
}

// ---------------- Exa REST API ----------------
async function exaSearch(query, numResults = 4) {
  if (DRY_RUN) {
    console.log(`  [DRY] Would search: ${query.slice(0, 80)}…`);
    return { results: [] };
  }
  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify({
        query,
        numResults,
        type: 'auto',
        contents: { text: { maxCharacters: 3000 } },
      }),
    });
    if (!res.ok) {
      console.warn(`  ! Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { results: [] };
    }
    return res.json();
  } catch (err) {
    console.warn(`  ! Exa fetch error: ${err.message}`);
    return { results: [] };
  }
}

// ---------------- Candidate extraction ----------------
function extractRoundCandidate(result) {
  const text = `${result.title || ''} ${result.text || ''}`;
  // Look for "$XYZ million" or "$XYZ M" or "$X.Y billion"
  const amtMatch = text.match(/\$\s?(\d+(?:\.\d+)?)\s?(million|M\b|billion|B\b)/i);
  // Look for "Series X" with optional digit or sign
  const seriesMatch = text.match(/Series\s+([A-G](?:\d|[+-])?)/i);
  // Look for "raised", "closed", "secured" near amount (signal that it's a real round)
  const hasRoundVerb = /\b(rais(?:ed|es|ing)|clos(?:ed|es|ing)|secur(?:ed|es)|announced)\b/i.test(text);
  if (!amtMatch || !hasRoundVerb) return null;
  let amount = parseFloat(amtMatch[1]);
  if (/B|billion/i.test(amtMatch[2])) amount *= 1000;
  return {
    amount,
    type: seriesMatch ? `Series ${seriesMatch[1]}` : 'Funding round',
    publishedDate: result.publishedDate || null,
    url: result.url,
    title: result.title,
  };
}

// ---------------- Per-startup check ----------------
async function checkStartup(startup) {
  const changes = [];
  const currentRoundDate = new Date(startup.round?.date || '2020-01-01');
  const currentAmount = startup.round?.amount;

  // 1. New funding round
  const fundingQuery = `${startup.name} ${startup.sector} funding round Series raised announced ${CURRENT_YEAR} ${LAST_YEAR}`;
  const fundingRes = await exaSearch(fundingQuery, 5);
  const seenUrls = new Set();
  for (const result of fundingRes.results || []) {
    if (!result.publishedDate || seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);
    const pubDate = new Date(result.publishedDate);
    if (isNaN(pubDate.getTime()) || pubDate <= currentRoundDate) continue;
    const candidate = extractRoundCandidate(result);
    if (!candidate) continue;
    // Filter out near-duplicates of existing round (within 5% of amount AND same series type)
    if (currentAmount && Math.abs(candidate.amount - currentAmount) / currentAmount < 0.05
        && candidate.type === startup.round?.type) continue;
    changes.push({
      kind: 'new-round-candidate',
      startup: startup.name,
      candidate,
    });
  }

  // 2. Recent news (last 30 days)
  const newsQuery = `${startup.name} ${startup.sector} partnership deployment contract announcement`;
  const newsRes = await exaSearch(newsQuery, 3);
  const knownNews = new Set((startup.recentNews || []).map(n => (n.text || '').toLowerCase().slice(0, 40)));
  for (const result of newsRes.results || []) {
    if (!result.publishedDate) continue;
    const pubDate = new Date(result.publishedDate);
    if (isNaN(pubDate.getTime())) continue;
    const daysAgo = (Date.now() - pubDate) / (1000 * 60 * 60 * 24);
    if (daysAgo > 30 || daysAgo < 0) continue;
    const titleLower = (result.title || '').toLowerCase().slice(0, 40);
    if (!titleLower) continue;
    // Skip if title overlaps significantly with existing recentNews
    let isDup = false;
    for (const known of knownNews) {
      if (titleLower.includes(known) || known.includes(titleLower)) { isDup = true; break; }
    }
    if (isDup) continue;
    changes.push({
      kind: 'new-news',
      startup: startup.name,
      date: result.publishedDate.slice(0, 10),
      title: result.title,
      url: result.url,
    });
  }

  return changes;
}

// ---------------- v3.3: Cluster + Prefilter + Critic ----------------

const AGGREGATOR_DOMAINS = [
  'cbinsights.com', 'tracxn.com', 'wikipedia.org', 'pitchbook.com/profiles',
  'crunchbase.com/organization', 'dealroom.co', 'owler.com',
];

// v3.3.1: Domains that should NEVER auto-mutate data.json regardless of Critic confidence.
// Reason: these are SEC/IPO/equity-aggregator sites that often misrepresent commercial
// commitments, ATM raises, or SPAC follow-ons as fresh equity rounds.
// Example: Oklo $1.2B from biggo.com was a Meta prepayment contract, not equity.
// Any verdict citing one of these as primary source → forced to needsReview.
const NEVER_AUTO_APPLY_DOMAINS = [
  'biggo.com',         // Taiwanese SEC/finance aggregator
  'accessipos.com',    // IPO speculation/forecasting site
  'stocktitan.net',    // SEC filing republisher
  'rareearthexchanges.com', // Speculative commodity blog
  'tracxn.com',        // Already in AGGREGATOR_DOMAINS but doubled here for clarity
  'nextinvestors.com', // Retail equity speculation
];

function isNeverAutoApplyDomain(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return NEVER_AUTO_APPLY_DOMAINS.some(d => u.includes(d));
}

/**
 * Group raw candidates by event signature.
 * Two candidates are "same event" if:
 *   - Same startup (caller guarantees)
 *   - Amount within ±15% OR exact match
 *   - Dates within 30 days (bumped from 14 in v3.3.1 — funding news cycles span 2-4 weeks
 *     of follow-up coverage; 14d was missing Last Energy / Twelve same-event duplicates)
 */
function clusterCandidates(candidates) {
  const clusters = [];
  for (const c of candidates) {
    if (!c.publishedDate) continue;
    const cDate = new Date(c.publishedDate);
    if (isNaN(cDate.getTime())) continue;
    let placed = false;
    for (const cluster of clusters) {
      const repr = cluster[0];
      const reprDate = new Date(repr.publishedDate);
      const daysApart = Math.abs((cDate - reprDate) / (1000 * 60 * 60 * 24));
      const amountClose = Math.abs(c.amount - repr.amount) / Math.max(repr.amount, 1) < 0.15;
      if (amountClose && daysApart <= 30) {
        cluster.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([c]);
  }
  // Within each cluster, prefer official sources first (helps Critic pick chosen_source_index=0)
  for (const cluster of clusters) {
    cluster.sort((a, b) => sourcePriority(b.url) - sourcePriority(a.url));
  }
  return clusters;
}

function sourcePriority(url) {
  if (!url) return 0;
  const u = url.toLowerCase();
  if (u.includes('businesswire.com') || u.includes('prnewswire.com')) return 10;
  if (u.includes('sec.gov')) return 9;
  // company's own domain — heuristic: short domain, no aggregator pattern
  if (u.includes('techcrunch.com') || u.includes('reuters.com') || u.includes('bloomberg.com')) return 7;
  if (AGGREGATOR_DOMAINS.some(d => u.includes(d))) return 1;
  return 5;
}

/**
 * Apply zero-cost hard rules. Returns annotated candidates with hints[].
 * Hints help the Critic but DO NOT auto-reject — Critic always has final say.
 */
function annotateCluster(cluster, startup) {
  const currentAmount = startup.round?.amount;
  const currentDate = startup.round?.date ? new Date(startup.round.date) : null;
  for (const c of cluster) {
    c.hints = [];
    if (c.amount > 5000) c.hints.push('suspect_large_amount');
    if (AGGREGATOR_DOMAINS.some(d => c.url?.toLowerCase().includes(d))) c.hints.push('aggregator_source');
    if (currentDate && c.publishedDate) {
      const pubDate = new Date(c.publishedDate);
      const daysOlder = (currentDate - pubDate) / (1000 * 60 * 60 * 24);
      if (daysOlder >= -7) c.hints.push('possibly_stale'); // pub date is on/before current round
    }
    if (currentAmount && c.amount > currentAmount * 3) c.hints.push('amount_exceeds_3x_current');
    if (/\bipo\b|public-company|nasdaq|nyse/i.test(`${c.title} ${c.url}`)) c.hints.push('ipo_keyword_in_source');
    if (/\bgrant\b|department.of.energy|doe\b/i.test(`${c.title} ${c.url}`)) c.hints.push('grant_keyword');
    if (/\batm\b|at-the-market/i.test(c.title || '')) c.hints.push('atm_offering');
  }
  return cluster;
}

/**
 * Apply a single Critic verdict to a startup entry in memory.
 * On successful mutation, append an entry to startup._audit with the
 * previous state snapshot — so 6 months from now, `git diff` + a single
 * data.json view tell you why every field changed and which verdict drove it.
 * (The leading underscore signals "metadata, not display data" — dashboard ignores.)
 * Returns true if startup was mutated.
 */
function applyVerdict(startup, cluster, verdict) {
  // Snapshot previous state BEFORE mutating, in case Critic later turns out wrong
  // Schema matches data.json: round={type,amount,date,lead}, source is top-level, no ipoDate
  const previousState = {
    round: startup.round ? JSON.parse(JSON.stringify(startup.round)) : null,
    status: startup.status ?? null,
    ticker: startup.ticker ?? null,
    source: startup.source ?? null,
  };

  // Helper: apply a new_round payload onto startup (used by both update_round and IPO under update_status)
  // Key principle: a NEW round = a new event. Never inherit old round's lead investor.
  // type/date fall back to old only if Critic omitted them entirely (defensive default).
  const writeRound = (newRound) => {
    if (!newRound || !newRound.amount) return false;
    startup.round = {
      type: newRound.type || startup.round?.type,
      amount: newRound.amount,
      date: newRound.date || startup.round?.date,
      // 'lead' carried forward ONLY if Critic didn't include the key at all;
      // explicit null wins (IPO has no lead, debt facility has no lead, etc.)
      lead: 'lead' in newRound ? newRound.lead : (startup.round?.lead ?? null),
    };
    // Top-level source field points to round announcement URL (dashboard reads s.source)
    const newSource = newRound.source || cluster[0]?.url;
    if (newSource) startup.source = newSource;
    return true;
  };

  let mutated = false;
  switch (verdict.action) {
    case 'update_round': {
      mutated = writeRound(verdict.new_round);
      break;
    }
    case 'update_status': {
      if (!verdict.new_status) return false;
      if (verdict.new_status.status) { startup.status = verdict.new_status.status; mutated = true; }
      if (verdict.new_status.ticker) { startup.ticker = verdict.new_status.ticker; mutated = true; }
      // IPO events also carry new_round; apply both atomically
      if (verdict.new_round && verdict.new_round.amount) {
        writeRound(verdict.new_round);
        mutated = true;
      }
      break;
    }
    case 'merge_info': {
      if (!verdict.additional_info) return false;
      if (verdict.additional_info.newLeads?.length && startup.round) {
        const existing = startup.round.lead || '';
        const merged = [existing, ...verdict.additional_info.newLeads].filter(Boolean).join(', ');
        startup.round.lead = merged;
        mutated = true;
      }
      break;
    }
    default:
      return false;
  }

  if (mutated) {
    startup._audit = startup._audit || [];
    startup._audit.push({
      appliedAt: new Date().toISOString(),
      appliedBy: 'critic-round-v3.3',
      action: verdict.action,
      confidence: verdict.confidence,
      reason: verdict.reason,
      source: cluster[0]?.url || null,
      sourceTitle: cluster[0]?.title || null,
      clusterSize: cluster.length,
      previousState,
    });
  }
  return mutated;
}

// ---------------- Email + changelog formatting ----------------
function fmtAmount(m) {
  if (m == null) return '—';
  if (m >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m}M`;
}

function describeVerdict(v) {
  const a = v.action;
  if (a === 'update_round') return 'New round applied';
  if (a === 'update_status') return 'Status change applied';
  if (a === 'merge_info') return 'Round info merged';
  if (a === 'reject_stale') return 'Stale (already in data.json)';
  if (a === 'reject_aggregate') return 'Aggregator total-funding';
  if (a === 'reject_ipo_only') return 'IPO market activity, not equity round';
  if (a === 'reject_other') return 'Not a real funding event';
  if (a === 'needs_human') return 'Needs review';
  return a;
}

function formatChangelogMd(roundBuckets, newsItems, today, ctvcResult) {
  const { autoUpdated, needsReview, silentReject } = roundBuckets;
  let md = `# FusionPark Climate Intel — Weekly Diff ${today}\n\n`;
  md += `## Summary\n\n`;
  md += `- ${autoUpdated.length} existing-watchlist rounds auto-applied by Critic\n`;
  md += `- ${needsReview.length} existing-watchlist candidates need your review\n`;
  md += `- ${silentReject.length} existing-watchlist candidates rejected (noise filtered)\n`;
  md += `- ${newsItems.length} news events (last 30d)\n`;
  if (ctvcResult) {
    md += `- ${ctvcResult.accepted.length} new companies auto-added from CTVC (Critic-approved)\n`;
    md += `- ${ctvcResult.needsHuman.length} CTVC candidates need your review\n`;
    md += `- ${ctvcResult.duplicates.length} CTVC dup · ${ctvcResult.rejected.length} CTVC rejected\n`;
  }
  md += `\n`;

  if (autoUpdated.length) {
    md += `## ✅ Auto-applied to data.json (existing watchlist)\n\n`;
    for (const r of autoUpdated) {
      md += `- **${r.startup.name}** — ${describeVerdict(r.verdict)} (conf ${r.verdict.confidence})\n`;
      md += `  - _${r.verdict.reason}_\n`;
      if (r.verdict.action === 'update_round' && r.verdict.new_round) {
        md += `  - New round: ${r.verdict.new_round.type} ${fmtAmount(r.verdict.new_round.amount)} (${r.verdict.new_round.date})\n`;
      }
      if (r.verdict.action === 'update_status' && r.verdict.new_status) {
        const ipoTail = r.verdict.new_round?.type === 'IPO' && r.verdict.new_round?.date
          ? ` · IPO ${r.verdict.new_round.date} · ${fmtAmount(r.verdict.new_round.amount)}`
          : '';
        md += `  - New status: ${r.verdict.new_status.status}${r.verdict.new_status.ticker ? ' · ' + r.verdict.new_status.ticker : ''}${ipoTail}\n`;
      }
      md += `  - Source: ${r.cluster[0]?.url || '—'}\n\n`;
    }
  }

  if (ctvcResult?.accepted.length) {
    md += `## ✅ Auto-added from CTVC (Critic-approved new companies)\n\n`;
    for (const a of ctvcResult.accepted) {
      md += `- **${a.entry.name}** (${a.entry.sector}) — ${a.candidate.roundType || a.candidate.kind} ${fmtAmount(a.candidate.amount)}\n`;
      md += `  - HQ: ${a.entry.hq}\n  - Tech: ${a.entry.tech}\n  - Critic: _${a.verdict.reason}_ (conf ${a.verdict.confidence})\n\n`;
    }
  }

  if (needsReview.length) {
    md += `## ❓ Existing-watchlist candidates need your review\n\n`;
    for (const r of needsReview) {
      const isSubThreshold = r.verdict._subThreshold === true;
      const isRefused = r.verdict._applyRefused === true;
      const isBlockedDomain = r.verdict._blockedDomain === true;
      const tag = isBlockedDomain
        ? `Critic said **${describeVerdict(r.verdict)}** (conf ${r.verdict.confidence}) but source domain is on blocklist`
        : isSubThreshold
          ? `Critic suggested **${describeVerdict(r.verdict)}** but confidence ${r.verdict.confidence} < ${AUTO_APPLY_THRESHOLD} threshold`
          : isRefused
            ? `Critic said **${describeVerdict(r.verdict)}** but verdict missing required fields`
            : `${describeVerdict(r.verdict)}`;
      md += `- **${r.startup.name}** — ${tag}\n`;
      md += `  - Critic: _${r.verdict.reason}_\n`;
      if (isSubThreshold && r.verdict.action === 'update_round' && r.verdict.new_round) {
        md += `  - Would set: ${r.verdict.new_round.type} ${fmtAmount(r.verdict.new_round.amount)} (${r.verdict.new_round.date || '—'})\n`;
      }
      if (isSubThreshold && r.verdict.action === 'update_status' && r.verdict.new_status) {
        const ipoTail = r.verdict.new_round?.type === 'IPO' && r.verdict.new_round?.date
          ? `, IPO ${r.verdict.new_round.date} ${fmtAmount(r.verdict.new_round.amount)}`
          : '';
        md += `  - Would set: status=${r.verdict.new_status.status}${r.verdict.new_status.ticker ? ' ticker=' + r.verdict.new_status.ticker : ''}${ipoTail}\n`;
      }
      for (const c of r.cluster) {
        md += `  - ${c.type} ${fmtAmount(c.amount)} · ${c.publishedDate?.slice(0, 10) || '—'} · ${c.url}\n`;
      }
      md += `\n`;
    }
  }

  if (ctvcResult?.needsHuman.length) {
    md += `## ❓ CTVC candidates need your review\n\n`;
    for (const n of ctvcResult.needsHuman) {
      md += `- **${n.candidate.name}** (${n.candidate.hq}) — ${fmtAmount(n.candidate.amount)} ${n.candidate.roundType || ''}\n`;
      md += `  - Tech: ${n.candidate.tech}\n  - Critic: _${n.verdict.reason}_\n\n`;
    }
  }

  if (silentReject.length) {
    md += `## 🤫 Silently rejected (noise filtered by Critic)\n\n`;
    const byReason = {};
    for (const r of silentReject) {
      const key = describeVerdict(r.verdict);
      (byReason[key] ||= []).push(r);
    }
    for (const [reason, items] of Object.entries(byReason)) {
      md += `- **${reason}** (${items.length}): ${items.map(i => i.startup.name).join(', ')}\n`;
    }
    md += `\n`;
  }

  if (newsItems.length) {
    md += `## 📰 New news events (last 30d)\n\n`;
    for (const n of newsItems) {
      md += `- **${n.startup}** · ${n.date} — ${n.title}\n  - ${n.url}\n\n`;
    }
  }

  if (autoUpdated.length === 0 && needsReview.length === 0 && newsItems.length === 0
      && (!ctvcResult || (ctvcResult.accepted.length === 0 && ctvcResult.needsHuman.length === 0))) {
    md += `## No changes detected this week\n\nAll startups checked. No new rounds or relevant news. CTVC produced no new accept-grade candidates.\n`;
  }
  return md;
}

function formatEmailHtml(roundBuckets, newsItems, today, ctvcResult, totalStartups) {
  const { autoUpdated, needsReview, silentReject } = roundBuckets;
  const ctvcAccepted = ctvcResult?.accepted || [];
  const ctvcNeedsHuman = ctvcResult?.needsHuman || [];
  const totalActivity = autoUpdated.length + needsReview.length + newsItems.length + ctvcAccepted.length + ctvcNeedsHuman.length;

  let html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;color:#0f172a;line-height:1.5">`;
  html += `<h2 style="color:#4f46e5;margin-bottom:4px">FusionPark Climate Intel</h2>`;
  html += `<p style="color:#64748b;margin-top:0">Weekly refresh · ${today}</p>`;

  if (totalActivity === 0) {
    html += `<p style="color:#475569;padding:16px;background:#f4f5f7;border-radius:8px">No new signals this week. All clear.</p>`;
  } else {
    html += `<p style="background:#eef2ff;padding:10px 14px;border-radius:6px;font-size:13px"><strong>${autoUpdated.length}</strong> auto-applied · <strong>${ctvcAccepted.length}</strong> new from CTVC · <strong>${needsReview.length + ctvcNeedsHuman.length}</strong> need your review · <strong>${silentReject.length}</strong> noise filtered · <strong>${newsItems.length}</strong> news events</p>`;

    // ✅ BUCKET 1: Auto-applied to existing watchlist
    if (autoUpdated.length) {
      html += `<h3 style="color:#059669;margin-top:28px;padding-bottom:6px;border-bottom:2px solid #ecfdf5">✅ Auto-applied to data.json (existing watchlist)</h3>`;
      html += `<p style="color:#64748b;font-size:13px;font-style:italic;margin-top:6px">Critic confirmed and updated these in your dashboard. Verify if anything looks off.</p>`;
      html += `<ul style="padding-left:18px">`;
      for (const r of autoUpdated) {
        const v = r.verdict;
        let detail = '';
        if (v.action === 'update_round' && v.new_round) {
          detail = `<strong style="color:#059669">New round:</strong> ${v.new_round.type} ${fmtAmount(v.new_round.amount)} <span style="color:#94a3b8">(${v.new_round.date || '—'})</span>`;
        } else if (v.action === 'update_status' && v.new_status) {
          const ipoTail = v.new_round?.type === 'IPO' && v.new_round?.date
            ? ` · IPO ${v.new_round.date} · ${fmtAmount(v.new_round.amount)}`
            : '';
          detail = `<strong style="color:#059669">Status change:</strong> ${v.new_status.status}${v.new_status.ticker ? ' · ticker <code>' + v.new_status.ticker + '</code>' : ''}${ipoTail}`;
        } else if (v.action === 'merge_info') {
          detail = `<strong style="color:#059669">Info merged into existing round</strong>`;
        }
        html += `<li style="margin-bottom:12px"><strong>${r.startup.name}</strong> <span style="background:#ecfdf5;color:#059669;padding:1px 6px;border-radius:4px;font-size:11px">${r.startup.sector}</span><br>${detail}<br><span style="font-size:11px;color:#94a3b8;font-style:italic">Critic: ${v.reason} (conf ${v.confidence})</span><br><a href="${r.cluster[0]?.url}" style="font-size:11px">Source ↗</a></li>`;
      }
      html += `</ul>`;
    }

    // ✅ BUCKET 2: Auto-added new companies from CTVC
    if (ctvcAccepted.length) {
      html += `<h3 style="color:#059669;margin-top:28px;padding-bottom:6px;border-bottom:2px solid #ecfdf5">✅ Auto-added new companies from CTVC</h3>`;
      html += `<ul style="padding-left:18px">`;
      for (const a of ctvcAccepted) {
        html += `<li style="margin-bottom:10px"><strong>${a.entry.name}</strong> <span style="background:#ecfdf5;color:#059669;padding:1px 6px;border-radius:4px;font-size:11px">${a.entry.sector}</span> · ${fmtAmount(a.candidate.amount)} ${a.candidate.roundType || ''}<br><span style="font-size:12px;color:#475569">${a.entry.tech}</span><br><span style="font-size:11px;color:#94a3b8;font-style:italic">Critic: ${a.verdict.reason} (conf ${a.verdict.confidence})</span></li>`;
      }
      html += `</ul>`;
    }

    // ❓ BUCKET 3: Needs your review (merged from both sources)
    if (needsReview.length || ctvcNeedsHuman.length) {
      html += `<h3 style="color:#d97706;margin-top:28px;padding-bottom:6px;border-bottom:2px solid #fef3c7">❓ Needs your review</h3>`;
      html += `<p style="color:#64748b;font-size:13px;font-style:italic;margin-top:6px">Critic flagged or sub-threshold — you decide</p>`;
      html += `<ul style="padding-left:18px">`;
      for (const r of needsReview) {
        const cs = r.cluster.map(c => `${c.type} ${fmtAmount(c.amount)} · ${c.publishedDate?.slice(0, 10) || '—'}`).join(' / ');
        const isSubThreshold = r.verdict._subThreshold === true;
        const isRefused = r.verdict._applyRefused === true;
        const isBlockedDomain = r.verdict._blockedDomain === true;
        let badge, suggestion = '';
        if (isBlockedDomain) {
          badge = `<span style="background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:4px;font-size:10px">blocked domain · ${describeVerdict(r.verdict)}</span>`;
        } else if (isSubThreshold) {
          badge = `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px">sub-threshold ${describeVerdict(r.verdict)}</span>`;
          if (r.verdict.action === 'update_round' && r.verdict.new_round) {
            suggestion = `<br><span style="font-size:11px;color:#92400e">Would set: ${r.verdict.new_round.type} ${fmtAmount(r.verdict.new_round.amount)} (${r.verdict.new_round.date || '—'}) — conf ${r.verdict.confidence} &lt; ${AUTO_APPLY_THRESHOLD}</span>`;
          } else if (r.verdict.action === 'update_status' && r.verdict.new_status) {
            const ipoTail = r.verdict.new_round?.type === 'IPO' && r.verdict.new_round?.date
              ? ` · IPO ${r.verdict.new_round.date} ${fmtAmount(r.verdict.new_round.amount)}`
              : '';
            suggestion = `<br><span style="font-size:11px;color:#92400e">Would set: status=${r.verdict.new_status.status}${r.verdict.new_status.ticker ? ' · ticker ' + r.verdict.new_status.ticker : ''}${ipoTail} — conf ${r.verdict.confidence} &lt; ${AUTO_APPLY_THRESHOLD}</span>`;
          }
        } else if (isRefused) {
          badge = `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px">verdict incomplete</span>`;
        } else {
          badge = `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px">ambiguous</span>`;
        }
        html += `<li style="margin-bottom:10px"><strong>${r.startup.name}</strong> ${badge}<br><span style="font-size:12px;color:#475569">${cs}</span>${suggestion}<br><span style="font-size:11px;color:#94a3b8;font-style:italic">Critic: ${r.verdict.reason}</span><br>${r.cluster.map(c => `<a href="${c.url}" style="font-size:11px;margin-right:8px">Source ↗</a>`).join('')}</li>`;
      }
      for (const n of ctvcNeedsHuman) {
        html += `<li style="margin-bottom:10px"><strong>${n.candidate.name}</strong> <span style="color:#94a3b8;font-size:11px">CTVC new</span> (${n.candidate.hq}) — ${fmtAmount(n.candidate.amount)} ${n.candidate.roundType || ''}<br><span style="font-size:12px;color:#475569">${n.candidate.tech}</span><br><span style="font-size:11px;color:#94a3b8;font-style:italic">Critic: ${n.verdict.reason}</span></li>`;
      }
      html += `</ul>`;
    }

    // 🤫 BUCKET 4: Silent reject summary (collapsed by reason)
    if (silentReject.length) {
      const byReason = {};
      for (const r of silentReject) {
        const key = describeVerdict(r.verdict);
        (byReason[key] ||= []).push(r.startup.name);
      }
      html += `<h3 style="color:#94a3b8;margin-top:28px;font-size:14px">🤫 Filtered as noise (${silentReject.length})</h3>`;
      html += `<ul style="padding-left:18px;color:#64748b;font-size:12px">`;
      for (const [reason, names] of Object.entries(byReason)) {
        html += `<li><strong>${reason}</strong> (${names.length}): ${names.join(', ')}</li>`;
      }
      html += `</ul>`;
    }

    // 📰 News
    if (newsItems.length) {
      html += `<h3 style="color:#475569;margin-top:28px;padding-bottom:6px;border-bottom:2px solid #f1f5f9">📰 New news (last 30d)</h3>`;
      html += `<ul style="padding-left:18px">`;
      for (const n of newsItems) {
        html += `<li style="margin-bottom:8px"><strong>${n.startup}</strong> · ${n.date}<br>${n.title}<br><a href="${n.url}" style="font-size:12px">Source ↗</a></li>`;
      }
      html += `</ul>`;
    }
  }
  html += `<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb">`;
  html += `<p style="color:#94a3b8;font-size:11px">Dashboard: <a href="${DASHBOARD_URL}" style="color:#94a3b8">${DASHBOARD_URL}</a> · ${totalStartups} startups tracked · v3.3 with Round Critic Agent</p>`;
  html += `</div>`;
  return html;
}

// ---------------- Email send ----------------
async function sendEmail(subject, html) {
  if (DRY_RUN) {
    console.log(`[DRY] Email subject: ${subject}`);
    console.log(html.slice(0, 500) + '…');
    return;
  }
  if (!RESEND_API_KEY) {
    console.warn('No RESEND_API_KEY set — skipping email');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'FusionPark Intel <onboarding@resend.dev>',
      to: [EMAIL_TO],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    console.error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } else {
    console.log(`Email sent to ${EMAIL_TO}`);
  }
}

// ---------------- Main ----------------
async function main() {
  const data = JSON.parse(await fs.readFile(DATA_PATH, 'utf-8'));
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[refresh] Starting weekly refresh — ${data.startups.length} startups · today=${today} · dry=${DRY_RUN}`);

  const allChanges = [];
  for (const startup of data.startups) {
    console.log(`  → ${startup.name}`);
    try {
      const changes = await checkStartup(startup);
      allChanges.push(...changes);
      await new Promise(r => setTimeout(r, 200)); // gentle pacing
    } catch (err) {
      console.error(`  ! Error checking ${startup.name}: ${err.message}`);
    }
  }

  console.log(`[refresh] ${allChanges.length} raw change candidates detected for existing watchlist`);

  // ---- v3.3: Cluster + Critic on per-startup round candidates ----
  // Group rounds by startup, cluster within startup, send each cluster to Critic
  const roundBuckets = {
    autoUpdated: [],   // { startup, cluster, verdict } — data.json mutated in memory
    needsReview: [],   // { startup, cluster, verdict } — surface in email
    silentReject: [],  // { startup, cluster, verdict } — changelog only, counted
  };
  const newsItems = allChanges.filter(c => c.kind === 'new-news');
  const roundCandidatesByStartup = {};
  for (const change of allChanges) {
    if (change.kind !== 'new-round-candidate') continue;
    (roundCandidatesByStartup[change.startup] ||= []).push(change.candidate);
  }

  const SKIP_ROUND_CRITIC = process.env.SKIP_ROUND_CRITIC === 'true';
  if (!SKIP_ROUND_CRITIC && process.env.ANTHROPIC_API_KEY) {
    console.log(`[refresh] v3.3 Round Critic: processing ${Object.keys(roundCandidatesByStartup).length} startups with candidates`);
    for (const [startupName, candidates] of Object.entries(roundCandidatesByStartup)) {
      const startup = data.startups.find(s => s.name === startupName);
      if (!startup) continue;
      const clusters = clusterCandidates(candidates);
      console.log(`  → ${startupName}: ${candidates.length} candidates → ${clusters.length} clusters`);
      for (const rawCluster of clusters) {
        const cluster = annotateCluster(rawCluster, startup);
        try {
          const verdict = await criticRoundCandidate(startup, cluster);
          const record = { startup, cluster, verdict };
          if (ACCEPT_ACTIONS.includes(verdict.action)) {
            // v3.3.1: Domain blocklist check — overrides confidence gate.
            // Even high-confidence verdicts from these sources get routed to review,
            // because they're known to misrepresent commercial deals as equity rounds.
            const chosenIdx = typeof verdict.chosen_source_index === 'number' ? verdict.chosen_source_index : 0;
            const chosenUrl = cluster[chosenIdx]?.url || cluster[0]?.url;
            const blockedDomain = isNeverAutoApplyDomain(chosenUrl);
            if (blockedDomain) {
              verdict._blockedDomain = true;
              verdict._blockedUrl = chosenUrl;
              roundBuckets.needsReview.push(record);
              console.log(`    🛑 ${verdict.action} blocked by domain (${chosenUrl}): ${verdict.reason}`);
            } else if (typeof verdict.confidence === 'number' && verdict.confidence >= AUTO_APPLY_THRESHOLD) {
              // Confidence gate — only auto-mutate if Critic is confident enough
              const mutated = applyVerdict(startup, cluster, verdict);
              if (mutated) {
                roundBuckets.autoUpdated.push(record);
                console.log(`    ✓ ${verdict.action} (conf ${verdict.confidence}): ${verdict.reason}`);
              } else {
                // applyVerdict refused (missing required fields) — surface for review
                verdict._subThreshold = false;
                verdict._applyRefused = true;
                roundBuckets.needsReview.push(record);
                console.log(`    ⚠ ${verdict.action} refused by applyVerdict (missing fields): ${verdict.reason}`);
              }
            } else {
              // Below threshold — surface to user with what Critic *would* have done
              verdict._subThreshold = true;
              roundBuckets.needsReview.push(record);
              console.log(`    ? ${verdict.action} sub-threshold (conf ${verdict.confidence} < ${AUTO_APPLY_THRESHOLD}): ${verdict.reason}`);
            }
          } else if (verdict.action === 'needs_human') {
            roundBuckets.needsReview.push(record);
            console.log(`    ? needs_human (conf ${verdict.confidence}): ${verdict.reason}`);
          } else {
            roundBuckets.silentReject.push(record);
            console.log(`    ✗ ${verdict.action} (conf ${verdict.confidence}): ${verdict.reason}`);
          }
          await new Promise(r => setTimeout(r, 150)); // gentle pacing for Anthropic
        } catch (err) {
          console.warn(`    ! Round Critic failed for ${startupName}: ${err.message}`);
          // Fallback: surface to review so info isn't lost
          roundBuckets.needsReview.push({ startup, cluster, verdict: { action: 'needs_human', reason: 'Critic error: ' + err.message, confidence: 0 } });
        }
      }
    }
    console.log(`[refresh] Round Critic done: ${roundBuckets.autoUpdated.length} auto · ${roundBuckets.needsReview.length} review · ${roundBuckets.silentReject.length} reject`);
  } else {
    console.log(`[refresh] Round Critic skipped (SKIP_ROUND_CRITIC or no ANTHROPIC_API_KEY) — falling back to flat candidate list`);
    // Fallback: all clusters surface as needsReview (preserves v3.2 behavior)
    for (const [startupName, candidates] of Object.entries(roundCandidatesByStartup)) {
      const startup = data.startups.find(s => s.name === startupName);
      if (!startup) continue;
      for (const cluster of clusterCandidates(candidates)) {
        roundBuckets.needsReview.push({
          startup, cluster,
          verdict: { action: 'needs_human', reason: 'Critic disabled — manual review', confidence: 0 },
        });
      }
    }
  }

  // ---- v3.2: CTVC ingestion + Critic Agent ----
  let ctvcResult = null;
  if (!SKIP_CTVC) {
    try {
      console.log(`[refresh] Starting CTVC ingestion + Critic Agent`);
      ctvcResult = await ingestCtvc(data);
      console.log(`[refresh] CTVC: ${ctvcResult.accepted.length} accept · ${ctvcResult.needsHuman.length} review · ${ctvcResult.duplicates.length} dup · ${ctvcResult.rejected.length} reject`);
    } catch (err) {
      console.error(`[refresh] CTVC ingestion failed: ${err.message}`);
    }
  } else {
    console.log(`[refresh] SKIP_CTVC=true, skipping CTVC step`);
  }

  // Write changelog
  await fs.mkdir(CHANGELOG_DIR, { recursive: true });
  const changelogPath = path.join(CHANGELOG_DIR, `changelog_${today}.md`);
  await fs.writeFile(changelogPath, formatChangelogMd(roundBuckets, newsItems, today, ctvcResult));
  console.log(`[refresh] Wrote ${changelogPath}`);

  // Update dataAsOf + save (CTVC may have pushed new entries to data.startups; Round Critic may have mutated existing entries)
  data.dataAsOf = today;
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`[refresh] Updated ${DATA_PATH} (dataAsOf=${today}, ${data.startups.length} startups)`);

  // Email
  const ctvcAdded = ctvcResult?.accepted.length || 0;
  const autoUpdated = roundBuckets.autoUpdated.length;
  const totalSignals = autoUpdated + roundBuckets.needsReview.length + newsItems.length
    + (ctvcResult ? ctvcResult.accepted.length + ctvcResult.needsHuman.length : 0);
  const subject = totalSignals === 0
    ? `FusionPark Climate Intel — No changes (${today})`
    : (ctvcAdded + autoUpdated) > 0
      ? `FusionPark Climate Intel — ${autoUpdated} auto-updated · ${ctvcAdded} new from CTVC · ${totalSignals} total signals (${today})`
      : `FusionPark Climate Intel — ${totalSignals} updates (${today})`;
  await sendEmail(subject, formatEmailHtml(roundBuckets, newsItems, today, ctvcResult, data.startups.length));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
