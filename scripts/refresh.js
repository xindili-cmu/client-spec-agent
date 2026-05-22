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

const EXA_API_KEY = process.env.EXA_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO || 'cindylips2001@gmail.com';
const DRY_RUN = process.env.DRY_RUN === 'true';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://climate-intel.pages.dev';
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

function formatChangelogMd(allChanges, today) {
  const newRounds = allChanges.filter(c => c.kind === 'new-round-candidate');
  const newsItems = allChanges.filter(c => c.kind === 'new-news');
  let md = `# FusionPark Climate Intel — Weekly Diff ${today}\n\n`;
  md += `## Summary\n\n- ${newRounds.length} potential new funding rounds (require review)\n- ${newsItems.length} new news events (last 30d)\n\n`;
  if (newRounds.length) {
    md += `## ⚡ Potential new funding rounds\n\n`;
    md += `> Candidates from Exa search — verify each before updating \`data.json\`.\n\n`;
    for (const c of newRounds) {
      md += `- **${c.startup}**: ${c.candidate.type} ${fmtAmount(c.candidate.amount)} · published ${c.candidate.publishedDate}\n`;
      md += `  - Title: _${c.candidate.title}_\n`;
      md += `  - Source: ${c.candidate.url}\n\n`;
    }
  }
  if (newsItems.length) {
    md += `## 📰 New news events\n\n`;
    for (const n of newsItems) {
      md += `- **${n.startup}** · ${n.date} — ${n.title}\n  - ${n.url}\n\n`;
    }
  }
  if (allChanges.length === 0) {
    md += `## No changes detected this week\n\nAll 26 startups checked. No new rounds or relevant news found.\n`;
  }
  return md;
}

function formatEmailHtml(allChanges, today) {
  const newRounds = allChanges.filter(c => c.kind === 'new-round-candidate');
  const newsItems = allChanges.filter(c => c.kind === 'new-news');
  let html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;color:#0f172a;line-height:1.5">`;
  html += `<h2 style="color:#4f46e5;margin-bottom:4px">FusionPark Climate Intel</h2>`;
  html += `<p style="color:#64748b;margin-top:0">Weekly refresh · ${today}</p>`;
  if (allChanges.length === 0) {
    html += `<p style="color:#475569;padding:16px;background:#f4f5f7;border-radius:8px">No changes detected across 26 startups this week. All clear.</p>`;
  } else {
    html += `<p><strong>${newRounds.length}</strong> potential new rounds · <strong>${newsItems.length}</strong> news events</p>`;
    if (newRounds.length) {
      html += `<h3 style="color:#059669;margin-top:24px">⚡ Potential new funding rounds</h3>`;
      html += `<p style="color:#64748b;font-size:13px;font-style:italic">Candidates from Exa search — verify before updating data.json</p>`;
      html += `<ul style="padding-left:18px">`;
      for (const c of newRounds) {
        html += `<li style="margin-bottom:10px"><strong>${c.startup}</strong>: ${c.candidate.type} ${fmtAmount(c.candidate.amount)} <span style="color:#94a3b8">(${c.candidate.publishedDate})</span><br><span style="font-size:12px;color:#475569">${c.candidate.title || ''}</span><br><a href="${c.candidate.url}" style="font-size:12px">Source ↗</a></li>`;
      }
      html += `</ul>`;
    }
    if (newsItems.length) {
      html += `<h3 style="color:#0284c7;margin-top:24px">📰 New news (last 30d)</h3>`;
      html += `<ul style="padding-left:18px">`;
      for (const n of newsItems) {
        html += `<li style="margin-bottom:8px"><strong>${n.startup}</strong> · ${n.date}<br>${n.title}<br><a href="${n.url}" style="font-size:12px">Source ↗</a></li>`;
      }
      html += `</ul>`;
    }
  }
  html += `<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb">`;
  html += `<p style="color:#94a3b8;font-size:11px">Dashboard: <a href="${DASHBOARD_URL}" style="color:#94a3b8">${DASHBOARD_URL}</a> · Auto-refresh: every Monday 9am UTC · 26 startups · 143 VCs</p>`;
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

  console.log(`[refresh] ${allChanges.length} change candidates detected`);

  // Write changelog
  await fs.mkdir(CHANGELOG_DIR, { recursive: true });
  const changelogPath = path.join(CHANGELOG_DIR, `changelog_${today}.md`);
  await fs.writeFile(changelogPath, formatChangelogMd(allChanges, today));
  console.log(`[refresh] Wrote ${changelogPath}`);

  // Update dataAsOf only
  data.dataAsOf = today;
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`[refresh] Updated ${DATA_PATH} (dataAsOf=${today})`);

  // Email
  const subject = allChanges.length === 0
    ? `FusionPark Climate Intel — No changes (${today})`
    : `FusionPark Climate Intel — ${allChanges.length} updates (${today})`;
  await sendEmail(subject, formatEmailHtml(allChanges, today));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
