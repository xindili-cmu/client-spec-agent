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

const EXA_API_KEY = process.env.EXA_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO || 'cindylips2001@gmail.com';
const DRY_RUN = process.env.DRY_RUN === 'true';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://climate-intel.pages.dev';
const SKIP_CTVC = process.env.SKIP_CTVC === 'true';
const CURRENT_YEAR = new Date().getFullYear();
const LAST_YEAR = CURRENT_YEAR - 1;

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

// ---------------- Email + changelog formatting ----------------
function fmtAmount(m) {
  if (m == null) return '—';
  if (m >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m}M`;
}

function formatChangelogMd(allChanges, today, ctvcResult) {
  const newRounds = allChanges.filter(c => c.kind === 'new-round-candidate');
  const newsItems = allChanges.filter(c => c.kind === 'new-news');
  let md = `# FusionPark Climate Intel — Weekly Diff ${today}\n\n`;
  md += `## Summary\n\n`;
  md += `- ${newRounds.length} potential new funding rounds (require review)\n`;
  md += `- ${newsItems.length} new news events (last 30d)\n`;
  if (ctvcResult) {
    md += `- ${ctvcResult.accepted.length} new companies auto-added from CTVC (Critic-approved)\n`;
    md += `- ${ctvcResult.needsHuman.length} CTVC candidates need your review\n`;
    md += `- ${ctvcResult.duplicates.length} duplicates skipped · ${ctvcResult.rejected.length} rejected by Critic\n`;
  }
  md += `\n`;
  if (ctvcResult?.accepted.length) {
    md += `## ✅ Auto-added from CTVC (Critic-approved)\n\n`;
    for (const a of ctvcResult.accepted) {
      md += `- **${a.entry.name}** (${a.entry.sector}) — ${a.candidate.roundType || a.candidate.kind} ${fmtAmount(a.candidate.amount)}\n`;
      md += `  - HQ: ${a.entry.hq}\n  - Tech: ${a.entry.tech}\n  - Critic: _${a.verdict.reason}_ (conf ${a.verdict.confidence})\n\n`;
    }
  }
  if (ctvcResult?.needsHuman.length) {
    md += `## ❓ CTVC candidates need your review\n\n`;
    for (const n of ctvcResult.needsHuman) {
      md += `- **${n.candidate.name}** (${n.candidate.hq}) — ${fmtAmount(n.candidate.amount)} ${n.candidate.roundType || ''}\n`;
      md += `  - Tech: ${n.candidate.tech}\n  - Critic: _${n.verdict.reason}_\n\n`;
    }
  }
  if (newRounds.length) {
    md += `## ⚡ Potential new funding rounds (existing watchlist)\n\n`;
    md += `> Candidates from Exa search — verify each before updating \`data.json\`.\n\n`;
    for (const c of newRounds) {
      md += `- **${c.startup}**: ${c.candidate.type} ${fmtAmount(c.candidate.amount)} · published ${c.candidate.publishedDate}\n`;
      md += `  - Title: _${c.candidate.title}_\n  - Source: ${c.candidate.url}\n\n`;
    }
  }
  if (newsItems.length) {
    md += `## 📰 New news events\n\n`;
    for (const n of newsItems) {
      md += `- **${n.startup}** · ${n.date} — ${n.title}\n  - ${n.url}\n\n`;
    }
  }
  if (allChanges.length === 0 && (!ctvcResult || (ctvcResult.accepted.length === 0 && ctvcResult.needsHuman.length === 0))) {
    md += `## No changes detected this week\n\nAll startups checked. No new rounds or relevant news. CTVC produced no new accept-grade candidates.\n`;
  }
  return md;
}

function formatEmailHtml(allChanges, today, ctvcResult, totalStartups) {
  const newRounds = allChanges.filter(c => c.kind === 'new-round-candidate');
  const newsItems = allChanges.filter(c => c.kind === 'new-news');
  const ctvcAccepted = ctvcResult?.accepted || [];
  const ctvcNeedsHuman = ctvcResult?.needsHuman || [];
  const totalActivity = newRounds.length + newsItems.length + ctvcAccepted.length + ctvcNeedsHuman.length;

  let html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;color:#0f172a;line-height:1.5">`;
  html += `<h2 style="color:#4f46e5;margin-bottom:4px">FusionPark Climate Intel</h2>`;
  html += `<p style="color:#64748b;margin-top:0">Weekly refresh · ${today}</p>`;

  if (totalActivity === 0) {
    html += `<p style="color:#475569;padding:16px;background:#f4f5f7;border-radius:8px">No new signals this week. All clear.</p>`;
  } else {
    html += `<p style="background:#eef2ff;padding:10px 14px;border-radius:6px;font-size:13px"><strong>${ctvcAccepted.length}</strong> auto-added from CTVC · <strong>${ctvcNeedsHuman.length}</strong> need your review · <strong>${newRounds.length}</strong> existing-watchlist rounds · <strong>${newsItems.length}</strong> news events</p>`;

    if (ctvcAccepted.length) {
      html += `<h3 style="color:#059669;margin-top:24px">✅ Auto-added from CTVC (Critic-approved)</h3>`;
      html += `<ul style="padding-left:18px">`;
      for (const a of ctvcAccepted) {
        html += `<li style="margin-bottom:10px"><strong>${a.entry.name}</strong> <span style="background:#ecfdf5;color:#059669;padding:1px 6px;border-radius:4px;font-size:11px">${a.entry.sector}</span> · ${fmtAmount(a.candidate.amount)} ${a.candidate.roundType || ''}<br><span style="font-size:12px;color:#475569">${a.entry.tech}</span><br><span style="font-size:11px;color:#94a3b8;font-style:italic">Critic: ${a.verdict.reason} (confidence ${a.verdict.confidence})</span></li>`;
      }
      html += `</ul>`;
    }

    if (ctvcNeedsHuman.length) {
      html += `<h3 style="color:#d97706;margin-top:24px">❓ Needs your review</h3>`;
      html += `<p style="color:#64748b;font-size:13px;font-style:italic">Critic flagged as ambiguous — you decide whether to add</p>`;
      html += `<ul style="padding-left:18px">`;
      for (const n of ctvcNeedsHuman) {
        html += `<li style="margin-bottom:10px"><strong>${n.candidate.name}</strong> (${n.candidate.hq}) — ${fmtAmount(n.candidate.amount)} ${n.candidate.roundType || ''}<br><span style="font-size:12px;color:#475569">${n.candidate.tech}</span><br><span style="font-size:11px;color:#94a3b8;font-style:italic">Critic: ${n.verdict.reason}</span></li>`;
      }
      html += `</ul>`;
    }

    if (newRounds.length) {
      html += `<h3 style="color:#0284c7;margin-top:24px">⚡ Existing-watchlist round candidates</h3>`;
      html += `<ul style="padding-left:18px">`;
      for (const c of newRounds) {
        html += `<li style="margin-bottom:10px"><strong>${c.startup}</strong>: ${c.candidate.type} ${fmtAmount(c.candidate.amount)} <span style="color:#94a3b8">(${c.candidate.publishedDate})</span><br><a href="${c.candidate.url}" style="font-size:12px">Source ↗</a></li>`;
      }
      html += `</ul>`;
    }
    if (newsItems.length) {
      html += `<h3 style="color:#475569;margin-top:24px">📰 New news (last 30d)</h3>`;
      html += `<ul style="padding-left:18px">`;
      for (const n of newsItems) {
        html += `<li style="margin-bottom:8px"><strong>${n.startup}</strong> · ${n.date}<br>${n.title}<br><a href="${n.url}" style="font-size:12px">Source ↗</a></li>`;
      }
      html += `</ul>`;
    }
  }
  html += `<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb">`;
  html += `<p style="color:#94a3b8;font-size:11px">Dashboard: <a href="${DASHBOARD_URL}" style="color:#94a3b8">${DASHBOARD_URL}</a> · ${totalStartups} startups tracked · v3.2 with Critic Agent</p>`;
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

  console.log(`[refresh] ${allChanges.length} change candidates detected for existing watchlist`);

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
  await fs.writeFile(changelogPath, formatChangelogMd(allChanges, today, ctvcResult));
  console.log(`[refresh] Wrote ${changelogPath}`);

  // Update dataAsOf + save (CTVC may have pushed new entries to data.startups in memory)
  data.dataAsOf = today;
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`[refresh] Updated ${DATA_PATH} (dataAsOf=${today}, ${data.startups.length} startups)`);

  // Email
  const ctvcAdded = ctvcResult?.accepted.length || 0;
  const totalSignals = allChanges.length + (ctvcResult ? ctvcResult.accepted.length + ctvcResult.needsHuman.length : 0);
  const subject = totalSignals === 0
    ? `FusionPark Climate Intel — No changes (${today})`
    : ctvcAdded > 0
      ? `FusionPark Climate Intel — ${ctvcAdded} new from CTVC, ${totalSignals} total signals (${today})`
      : `FusionPark Climate Intel — ${totalSignals} updates (${today})`;
  await sendEmail(subject, formatEmailHtml(allChanges, today, ctvcResult, data.startups.length));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
