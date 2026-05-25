#!/usr/bin/env node
/**
 * Critic Agent — v3.2's first LLM-based reasoning layer
 *
 * Role: Internal Investment Committee for Cindy Li.
 * Mission: REJECT candidates by default. Approve only when clearly belonging.
 *
 * Replaces v3.1's regex sector classification + substring-based dedup.
 * Catches:
 *   - Semantic sector mismatches (Clarasight 🌱 was AI travel, not climate)
 *   - Name collision false positives (Verda ≠ Verdagy)
 *   - Sub-material rounds (small debt facilities, grants from CTVC noise)
 *   - Already-tracked companies (status updates routed differently)
 *
 * Cost: Anthropic Haiku 4.5 — ~$0.30/week for ~80 candidates.
 *
 * Environment:
 *   ANTHROPIC_API_KEY — required
 *   CRITIC_MODEL — optional, defaults to claude-haiku-4-5-20251001
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CRITIC_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `You are the Investment Committee critic for Cindy Li, a Climate/DeepTech SPAC advisor at Fusion Park. She's deciding whether to add candidate companies (from CTVC's weekly newsletter) to her startup watchlist.

YOUR JOB: REJECT candidates by default. Approve only when the candidate clearly belongs. Cindy values precision over recall — a polluted watchlist hurts her more than a missed candidate.

ACCEPTANCE CRITERIA (ALL must hold):
1. Genuinely in climate / energy / deeptech — not merely adjacent. "AI travel platform tagged 🌱" is REJECT.
2. NOT already in her watchlist. Beware close-but-different names (e.g., "Verda" Finnish AI cloud company is NOT "Verdagy" US hydrogen company).
3. Funding round is real and material (Series Seed+ ideally; $5M+ minimum unless company is otherwise exceptional).
4. Sector is one of Cindy's 7 priority sectors:
   - nuclear · fusion · storage · hydrogen · carbon · minerals · aviation
   OR a clearly adjacent climate/energy sector with strong investor signal:
   - renewable (solar, wind, geothermal) · grid · transport-ev · industrial-decarb · circular · biofuels · climate-adapt
   Reject if sector is: pure fintech · pure SaaS · ag/food (unless clear climate angle) · transport-bike/scooter · entertainment.

OUTPUT FORMAT — strict JSON only, no markdown, no commentary:
{
  "decision": "accept" | "reject" | "duplicate" | "needs_human",
  "confidence": 0.0,
  "reason": "one terse sentence",
  "suggested_sector": "...",
  "suggested_id": "kebab-case-id",
  "duplicate_of": "existing watchlist name"
}

DECISION RULES:
- "accept" — clearly fits, fill suggested_sector and suggested_id
- "reject" — sector mismatch / too small / too adjacent / clearly not Cindy's universe
- "duplicate" — name + tech + HQ matches existing entry; fill duplicate_of
- "needs_human" — ambiguous (large round but unclear sector relevance; sector-adjacent with strong signal)

EXAMPLES:
- "Clarasight, AI corporate travel platform, $12M Series A" → {"decision":"reject","confidence":0.95,"reason":"Pure SaaS travel, not climate despite 🌱 source tag"}
- "Verda, Helsinki, AI cloud-renewable energy, $117M Series B" → {"decision":"accept","confidence":0.7,"reason":"Renewable energy infrastructure, distinct from hydrogen co Verdagy","suggested_sector":"renewable","suggested_id":"verda"}
- "X-energy, IPO $1B on Nasdaq XE" → {"decision":"duplicate","confidence":1.0,"reason":"X-energy already tracked, this is a status change","duplicate_of":"X-energy"}
- "Halter, NZ cattle herd management, $220M Growth" → {"decision":"needs_human","confidence":0.4,"reason":"Large round + climate-adjacent ag-tech but not core sector"}
- "EnerVenue, nickel-hydrogen storage $300M Series B" → {"decision":"accept","confidence":0.95,"reason":"Clear storage sector, material round, Hong Kong Investment Corp backing","suggested_sector":"storage","suggested_id":"enervenue"}
- "Forest, London shared e-bike $36M Series B" → {"decision":"reject","confidence":0.85,"reason":"Bike-share is transport-adjacent but not Cindy's priority"}`;

export async function criticReview(candidate, context) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env var required for Critic Agent');
  }

  const existingList = (context.existingStartups || [])
    .map(s => `  ${s.id} :: ${s.name} (${s.sector}, ${s.hq})`)
    .join('\n');

  const vcUniverseSample = (context.vcUniverse || []).slice(0, 50).join(', ');
  const vcUniverseSize = (context.vcUniverse || []).length;

  const userPrompt = `## CANDIDATE (from CTVC ${context.issueDate || 'unknown date'})

\`\`\`json
${JSON.stringify(candidate, null, 2)}
\`\`\`

## EXISTING WATCHLIST (${(context.existingStartups || []).length} companies)

${existingList}

## CINDY'S TRACKED VC UNIVERSE (sample, ${vcUniverseSize} total)

${vcUniverseSample}

## DECISION

Output JSON only.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Critic returned empty content');

  // Extract JSON (Haiku usually returns clean JSON; be defensive)
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Critic returned non-JSON: ' + text.slice(0, 200));

  try {
    const verdict = JSON.parse(match[0]);
    // Validate required fields
    if (!['accept', 'reject', 'duplicate', 'needs_human'].includes(verdict.decision)) {
      throw new Error('Invalid decision: ' + verdict.decision);
    }
    return verdict;
  } catch (e) {
    throw new Error(`Failed to parse Critic JSON: ${e.message}\nRaw: ${match[0].slice(0, 200)}`);
  }
}

// ============================================================
// v3.3 — Critic for existing-watchlist round candidates
// ============================================================

const ROUND_CRITIC_SYSTEM = `You are the Investment Committee critic for Cindy Li, deciding what to do with candidate funding rounds detected for companies ALREADY in her watchlist.

CONTEXT: Per-startup Exa search returns 1-6 candidates per company. Most are NOISE:
- Same event reported by multiple sources (TechCrunch + BusinessWire + company PR)
- CBInsights aggregate pages showing TOTAL accumulated funding as one "round" (amount is usually 2-5x reality)
- Stale rounds already recorded in data.json (older publishedDate than current round)
- IPO events parsed as Series rounds (e.g., "X-energy raises $1B in IPO")
- DOE grants / debt facilities / ATM offerings miscategorized as equity rounds
- News articles about a startup's market sector ($350B South Korea SMR market) parsed as the startup's round

YOUR JOB: For ONE cluster of candidates representing possibly the same event for ONE startup, decide ONE action. REJECT-by-default. Cindy hates polluted data more than missed signals.

OUTPUT FORMAT — strict JSON only, no markdown, no commentary:
{
  "action": "update_round" | "update_status" | "merge_info" | "reject_stale" | "reject_aggregate" | "reject_ipo_only" | "reject_other" | "needs_human",
  "confidence": 0.0,
  "reason": "one terse sentence",
  "new_round": { "type": "Series X", "amount": 123, "date": "YYYY-MM-DD", "lead": "...", "source": "https://..." },
  "new_status": { "status": "public", "ticker": "XYZ" },
  "additional_info": { "newLeads": ["..."] },
  "chosen_source_index": 0
}

SCHEMA NOTES (match data.json exactly — wrong field names break the dashboard):
- Round field is "lead" (singular string), NOT "leadInvestor" — e.g., "Amazon Climate Pledge Fund (anchor)"
- "source" is the URL to the round's announcement; goes inside new_round (orchestrator writes it to startup.source top-level)
- Status is one of: "private", "public" — there is NO separate ipoDate field
- For IPO events, emit BOTH new_status AND new_round in the SAME verdict (IPO = the new "round"):
    new_status:{status:"public", ticker:"XE"} + new_round:{type:"IPO", amount:1000, date:"2026-04-24", lead:null, source:"..."}
- Use null (not empty string) when a field is genuinely absent

DECISION RULES (only fill the JSON keys relevant to your chosen action):
- update_round: cluster clearly represents a NEW round AFTER current round date; new_round = best canonical record, chosen_source_index = which candidate is most authoritative (official PR > businesswire > techcrunch > aggregator)
- update_status: cluster describes IPO/acquisition/delisting; new_status = extracted status + ticker; ALSO include new_round if it's an IPO with public amount + date
- merge_info: cluster describes THE SAME round as current data.json but with a new lead investor or better source URL; additional_info = what to merge
- reject_stale: cluster date is on or before current round date — data.json already has this round
- reject_aggregate: URL contains cbinsights.com/financials, wikipedia, tracxn, or amount is clearly cumulative (significantly larger than any single published round)
- reject_ipo_only: cluster is IPO market activity (ATM raise, secondary offering, price target news) for already-public company, NOT a primary equity round
- reject_other: misparsed market size, grant-only, contract value rather than financing
- needs_human: cluster is ambiguous (amounts differ 20-50%, dates 14+ days apart, sector hot but unsure if same event)

HEURISTICS:
- If startup current status is "public" and current round is Series A-D, candidates about "raised $XB" 0-3 months from current quarter are likely SEC filings / quarterly reports — reject_ipo_only or reject_other
- If candidate amount > 3x current round amount AND source is cbinsights/tracxn/aggregate → reject_aggregate
- If candidate amount > $5B for a private startup with existing round < $1B → reject_other (likely market size or deal value)
- If multiple candidates within ±5% amount AND ±14 days → SAME event, choose best source
- If candidate publishedDate within current round month → reject_stale (article about existing round)

EXAMPLES:

Current: X-energy {status:private, round: Series C-1 $700M, 2025-02-06}
Candidates: [
  {amount:700, type:"Series D", date:"2025-11-24", url:"businesswire.com", title:"X-energy Closes Oversubscribed $700M Series D"},
  {amount:700, type:"Series D", date:"2025-11-24", url:"techcrunch.com"},
  {amount:1400, type:"Series D", date:"2025-11-25", url:"techfundingnews.com", title:"X-energy tops $1.4B raised in a year"}
]
→ {"action":"update_round","confidence":0.95,"reason":"Same Nov 2025 Series D event from 3 sources; $1.4B variant is cumulative not new round","new_round":{"type":"Series D","amount":700,"date":"2025-11-24","lead":null,"source":"https://businesswire.com/..."},"chosen_source_index":0}

Current: X-energy {status:private, round: Series C-1 $700M, 2025-02-06}
Candidate: {amount:1000, type:"Series C-", date:"2026-04-24", url:"techcrunch.com/nuclear-startup-x-energy-raises-1b-in-data-center-driven-ipo"}
→ {"action":"update_status","confidence":0.92,"reason":"TechCrunch URL explicitly says IPO; emit both status change and IPO as new round","new_status":{"status":"public","ticker":"XE"},"new_round":{"type":"IPO","amount":1000,"date":"2026-04-24","lead":null,"source":"https://techcrunch.com/2026/04/24/nuclear-startup-x-energy-raises-1b-in-data-center-driven-ipo/"}}

Current: NuScale {status:public, round:Series C $198M 2023}
Candidate: {amount:350000, type:"Funding round", date:"2026-05-13", url:"ans.org/news/article-8028/south-korea-looks-to-southern-and-nuscale", title:"South Korea looks to Southern and NuScale"}
→ {"action":"reject_other","confidence":0.98,"reason":"$350B is South Korea SMR market opportunity, not NuScale funding"}

Current: Antora {status:private, round: Series A $150M, 2024-02-22}
Candidates: [
  {amount:276.43, type:"Series B", date:"2025-10-30", url:"cbinsights.com/company/antora-energy/financials"},
  {amount:276.43, type:"Funding round", date:"2025-10-30", url:"cbinsights.com/company/antora-energy/"}
]
→ {"action":"reject_aggregate","confidence":0.9,"reason":"Both CBInsights URLs; $276M is total funding aggregate, not a new Series B"}

Current: Climeworks {status:private, round: Funding round $162M, 2025-07-02}
Candidate: {amount:162, type:"Funding round", date:"2025-07-09", url:"intelligenthq.com"}
→ {"action":"reject_stale","confidence":0.95,"reason":"Same $162M July 2025 round already in data.json from 7 days earlier"}

Current: Climeworks {status:private, round: Funding round $162M, 2025-07-02}
Candidate: {amount:5.1, type:"Funding round", date:"2025-07-03", url:"finsmes.com/2025/07/climeworks-raises-usd-162m-in-funding"}
→ {"action":"reject_stale","confidence":0.85,"reason":"$5.1M misparsed from article URL referencing same $162M round"}

Current: Beta Technologies {status:private, round: Series C $318M, 2024-10}
Candidate: {amount:7400, type:"Funding round", date:"2026-02-27", url:"evtol.travel/...beta-technologies-ipo-7-billion-public-company"}
→ {"action":"update_status","confidence":0.95,"reason":"URL explicitly states IPO at $7.4B valuation","new_status":{"status":"public","ticker":"BETA"},"new_round":{"type":"IPO","amount":7400,"date":"2026-02-27","lead":null,"source":"https://evtol.travel/blogs/beta-technologies-ipo-7-billion-public-company"}}

Current: Last Energy {status:private, round: pre-Series C}
Candidates: [
  {amount:100, type:"Series C", date:"2025-12-16", url:"techcrunch.com/...last-energy-raises-100m"},
  {amount:100, type:"Series C", date:"2025-12-17", url:"haskell.com"},
  {amount:100, type:"Series C", date:"2026-01-07", url:"neimagazine.com"}
]
→ {"action":"update_round","confidence":0.92,"reason":"Three sources confirm Dec 2025 Series C $100M","new_round":{"type":"Series C","amount":100,"date":"2025-12-16","lead":null,"source":"https://techcrunch.com/..."},"chosen_source_index":0}`;

/**
 * Critic for ONE startup's cluster of round candidates.
 * @param {Object} startup - existing watchlist entry from data.json
 * @param {Array} candidates - 1+ candidates from extractRoundCandidate
 * @returns {Promise<Object>} Verdict
 */
export async function criticRoundCandidate(startup, candidates) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env var required for Critic Agent');
  }

  const userPrompt = `## STARTUP (existing watchlist entry)

\`\`\`json
${JSON.stringify({
  name: startup.name,
  id: startup.id,
  sector: startup.sector,
  status: startup.status,
  hq: startup.hq,
  round: startup.round || null,
  ticker: startup.ticker || null,
}, null, 2)}
\`\`\`

## CANDIDATE CLUSTER (${candidates.length} source${candidates.length > 1 ? 's' : ''}, possibly same event)

\`\`\`json
${JSON.stringify(candidates.map((c, i) => ({
  index: i,
  amount: c.amount,
  type: c.type,
  publishedDate: c.publishedDate,
  url: c.url,
  title: c.title,
})), null, 2)}
\`\`\`

## DECISION

Output JSON only.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system: ROUND_CRITIC_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Round Critic returned empty content');

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Round Critic returned non-JSON: ' + text.slice(0, 200));

  const VALID_ACTIONS = ['update_round', 'update_status', 'merge_info', 'reject_stale', 'reject_aggregate', 'reject_ipo_only', 'reject_other', 'needs_human'];
  try {
    const verdict = JSON.parse(match[0]);
    if (!VALID_ACTIONS.includes(verdict.action)) {
      throw new Error('Invalid action: ' + verdict.action);
    }
    return verdict;
  } catch (e) {
    throw new Error(`Failed to parse Round Critic JSON: ${e.message}\nRaw: ${match[0].slice(0, 200)}`);
  }
}

// CLI test mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('fs/promises');
  const candidateFile = process.argv[2];
  if (!candidateFile) {
    console.error('Usage: node critic.js <candidate.json>');
    process.exit(1);
  }
  const candidate = JSON.parse(await fs.readFile(candidateFile, 'utf-8'));
  // Minimal context for CLI test — load real data.json if present
  let existingStartups = [], vcUniverse = [];
  try {
    const data = JSON.parse(await fs.readFile('./data.json', 'utf-8'));
    existingStartups = data.startups || [];
    vcUniverse = [...(data.vcs?.incubator || []), ...(data.vcs?.early || []), ...(data.vcs?.late || [])].map(v => v.name);
  } catch {
    console.warn('No data.json found, running with empty context');
  }
  const verdict = await criticReview(candidate, {
    issueDate: new Date().toISOString().slice(0, 10),
    existingStartups,
    vcUniverse,
  });
  console.log(JSON.stringify(verdict, null, 2));
}
