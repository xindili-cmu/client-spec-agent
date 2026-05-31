#!/usr/bin/env node
/**
 * v3.6 Pre-engagement Research Report Agent
 *
 * First use of Claude Agent SDK in the FusionPark stack — see [[reference-claude-agent-sdk]].
 *
 * Input:   target company name (CLI arg 1) + optional sector hint (CLI arg 2)
 * Output:  markdown report at <RESEARCH_OUTPUT_BASE>/research-reports/<slug>/research-report.md
 * Tools:   WebSearch, WebFetch, Read, Write, Bash (for mkdir)
 *
 * Per [[project-andrew-vision]] — Andrew's literal request: "Just have research reports for
 * [Chime] and [Sound]. Before I see the data room, I already have a thesis." Output is the
 * doorknock document for first-meeting outreach. Public info only.
 *
 * Per [[project-andrew-vdr-automation]] confidentiality tier — Layer 1 (public) only. Output
 * lives outside cloud-deploy/ git repo because it's per-target work product, not infra.
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required
 *   RESEARCH_OUTPUT_BASE  — optional, defaults to /Users/lilali/climate agent
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/research-agent/run.mjs "X-energy"
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/research-agent/run.mjs "Mantle8" hydrogen
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';

const target = process.argv[2];
const sectorHint = process.argv[3] || '';

if (!target) {
  console.error('Usage: node scripts/research-agent/run.mjs <target-name> [sector-hint]');
  console.error('Example: node scripts/research-agent/run.mjs "X-energy" nuclear');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

const slug = target
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const outputBase = process.env.RESEARCH_OUTPUT_BASE || '/Users/lilali/climate agent';
const outputRel = `research-reports/${slug}/research-report.md`;

const systemPrompt = `You are a pre-engagement research analyst for FusionPark Climate Intel — a SPAC advisory firm helping climate / deeptech target companies go public via SPAC merger.

Your output is a 1-2 page reach-out research report. It is used as a doorknock document when FP's principals (Cindy Li, Andrew) request a first meeting with the target's CEO.

HARD CONSTRAINTS:
- Public information ONLY. Do not speculate on private financials, deal terms, valuations, or anything you cannot cite a URL for.
- Cite every claim inline with the source URL.
- Be specific. "Strong leadership" is useless. "Founder X, ex-Tesla battery program lead 2015-2020, MIT PhD in electrochemistry" is useful.
- Frame for SPAC-readiness criteria (per Andrew's 2026-05-14 framework):
  - Market cap potential >= $100M (per Andrew: "the company cannot be too small")
  - Post-A round (Series A or later)
  - CEO comfortable conducting business in English (NASDAQ-ready)
  - Sector aligned with FP priorities: nuclear / fusion / hydrogen / storage / carbon / minerals / aviation / industrial-decarb
  - First-of-a-kind milestone reached if pre-commercial
- Output format: markdown with these sections in this order:
  1. **Snapshot** — 2-3 sentences: who they are, what they do, why interesting for SPAC
  2. **Technology / Product** — 1-2 paragraphs with cited claims
  3. **Funding History** — public rounds only, list with date / amount / lead investor / source
  4. **Leadership** — CEO + key co-founders with backgrounds (cite LinkedIn, press, company about page)
  5. **Sector Fit (FP lens)** — explicit YES / NO / UNKNOWN on each SPAC-readiness criterion with one-sentence justification
  6. **Open Questions for First Meeting** — 3-5 specific things to ask the CEO (gaps in public info that matter for SPAC fit)
  7. **Sources** — full URL list

AVOID:
- Marketing fluff from the company's own site framed as fact. If they say "world-leading", quote it with attribution, do not restate it as your judgment.
- Inferred valuations or deal speculation.
- Padding with generic climate-tech context the reader already knows.

When the report is complete, write it to disk via the Write tool, then say "Done." and stop.`;

const userPrompt = `Research the climate / deeptech target company: **${target}**${sectorHint ? `

Sector hint (Cindy's note, not necessarily definitive): ${sectorHint}` : ''}

Use WebSearch and WebFetch to gather public information about the company, its technology, funding, and leadership. Then write the structured research report (per the system prompt format) to this path:

\`${outputRel}\`

The cwd is set to \`${outputBase}\`. If the parent directory \`research-reports/${slug}/\` does not exist, create it first using Bash: \`mkdir -p "research-reports/${slug}"\`.

Begin research now.`;

console.log(`[research-agent] Target: ${target}`);
console.log(`[research-agent] Slug: ${slug}`);
console.log(`[research-agent] Sector hint: ${sectorHint || '(none)'}`);
console.log(`[research-agent] Output: ${path.join(outputBase, outputRel)}`);
console.log(`[research-agent] Starting Claude Agent SDK query...`);
console.log();

let turnCount = 0;
let toolCallCount = 0;
let textBudget = 0;

try {
  for await (const message of query({
    prompt: userPrompt,
    options: {
      systemPrompt,
      cwd: outputBase,
      allowedTools: ['WebSearch', 'WebFetch', 'Bash', 'Write', 'Read'],
      maxTurns: 30,
      permissionMode: 'acceptEdits',
    },
  })) {
    turnCount++;

    // Log informative messages, stay quiet on internal protocol noise
    const type = message?.type;
    if (type === 'assistant' || type === 'message') {
      const content = message.message?.content ?? message.content ?? [];
      const items = Array.isArray(content) ? content : [content];
      for (const item of items) {
        if (item?.type === 'text' && item.text) {
          const snippet = item.text.slice(0, 240).replace(/\s+/g, ' ');
          console.log(`[turn ${turnCount}] ${snippet}${item.text.length > 240 ? '…' : ''}`);
          textBudget += item.text.length;
        } else if (item?.type === 'tool_use') {
          toolCallCount++;
          const argsStr = JSON.stringify(item.input ?? {}).slice(0, 120);
          console.log(`[turn ${turnCount}] tool: ${item.name}  ${argsStr}`);
        }
      }
    } else if (type === 'result') {
      console.log(`[turn ${turnCount}] result: ${message.subtype || 'ok'}`);
    } else if (type === 'system') {
      // Skip system init noise
    } else if (type) {
      console.log(`[turn ${turnCount}] (${type})`);
    }
  }

  console.log();
  console.log(`✓ Research agent complete`);
  console.log(`  Output: ${path.join(outputBase, outputRel)}`);
  console.log(`  Total turns: ${turnCount}`);
  console.log(`  Tool calls: ${toolCallCount}`);
  console.log(`  Assistant text chars: ${textBudget}`);
} catch (err) {
  console.error('Fatal:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
}
