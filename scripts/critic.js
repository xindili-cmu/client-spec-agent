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
