#!/usr/bin/env node
/**
 * CTVC newsletter parser
 *
 * Extracts structured deal records from CTVC "Deals of the Week" section.
 * Format (consistent across all issues):
 *   [emoji] [Company], a/an [HQ]-based [tech description], raised$[amount][m|bn] in [Round type] funding from [Investor list].
 *
 * Plus IPO + Acquisition format from Exits section.
 *
 * Usage:
 *   node ctvc-parser.js <text-file>
 *   echo "..." | node ctvc-parser.js -   (stdin)
 */

import fs from 'fs/promises';

// --- Emoji → sector mapping ---
const EMOJI_TO_SECTOR = {
  '⚡': 'energy',          // generic energy — needs context refinement
  '🔋': 'storage',
  '⚒️': 'minerals',
  '☀️': 'solar',
  '💨': 'wind',
  '🏠': 'buildings',
  '🚗': 'transport',
  '🛵': 'transport',
  '🚆': 'transport',
  '🚴': 'transport',
  '🌾': 'ag',
  '🌱': 'ag',
  '🥩': 'food',
  '🍎': 'food',
  '💧': 'water',
  '👕': 'circular',
  '♻️': 'circular',
  '🧬': 'biotech',
  '🏭': 'industrial',
  '🛰': 'space',
  '⚙️': 'engineering',
  '🏗': 'buildings',
  '🌍': 'climate', '🌎': 'climate', '🌏': 'climate',
};

// Refine ⚡ based on tech keywords
function refineSector(emojiSector, tech) {
  if (emojiSector !== 'energy') return emojiSector;
  const t = tech.toLowerCase();
  if (/nuclear|smr|reactor|fission|fusion/.test(t)) return 'nuclear';
  if (/hydrogen|electrolyzer|h2/.test(t)) return 'hydrogen';
  if (/battery|storage|cell/.test(t)) return 'storage';
  if (/solar|pv/.test(t)) return 'solar';
  if (/grid|transmission/.test(t)) return 'grid';
  if (/ev|charging/.test(t)) return 'transport';
  if (/renewable|clean energy/.test(t)) return 'renewable';
  return 'energy';
}

// --- Parser regexes ---
// VC / PF / Debt deal format
const DEAL_RE = /^\s*([^A-Za-z0-9]+?)\s+([^,]+?),\s+(?:a|an)\s+(.+?)-based\s+(.+?),\s+raised\s*\$?([\d.]+)\s*([mb])n?\s+in\s+(.+?)\s+funding\s+from\s+(.+?)\.?\s*$/iu;

// IPO format: "announced an IPO at $Xbn on [Exchange] under ticker [Y]"
const IPO_RE = /^\s*([^A-Za-z0-9]+?)\s+([^,]+?),\s+(?:a|an)\s+(.+?)-based\s+(.+?),\s+announced\s+an\s+IPO\s+at\s+\$?([\d.]+)\s*([mb])n?\s+on\s+(\w+)(?:\s+under\s+ticker\s+(\w+))?/iu;

// Acquisition: "was acquired by [X] for [amount or 'an undisclosed amount']"
const ACQ_RE = /^\s*([^A-Za-z0-9]+?)\s+([^,]+?),\s+(?:a|an)\s+(.+?)-based\s+(.+?),\s+was\s+acquired\s+by\s+(.+?)(?:\s+for\s+(.+?))?\.?\s*$/iu;

function parseInvestorList(raw) {
  return raw
    .replace(/\s+and\s+others\.?$/i, '')
    .replace(/\s+and\s+other\s+investors\.?$/i, '')
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map(s => s.trim())
    .filter(s => s && !/^(others?|other investors?)$/i.test(s));
}

function parseLine(line) {
  // IPO?
  let m = line.match(IPO_RE);
  if (m) {
    const [, emoji, name, hq, tech, amt, unit, exchange, ticker] = m;
    return {
      kind: 'ipo',
      emoji: emoji.trim(),
      sector: refineSector(EMOJI_TO_SECTOR[emoji.trim()] || 'other', tech),
      name: name.trim(),
      hq: hq.trim(),
      tech: tech.trim(),
      amount: parseFloat(amt) * (unit.toLowerCase() === 'b' ? 1000 : 1),
      exchange,
      ticker,
    };
  }
  // Acquisition?
  m = line.match(ACQ_RE);
  if (m) {
    const [, emoji, name, hq, tech, acquirer, price] = m;
    return {
      kind: 'acquisition',
      emoji: emoji.trim(),
      sector: refineSector(EMOJI_TO_SECTOR[emoji.trim()] || 'other', tech),
      name: name.trim(),
      hq: hq.trim(),
      tech: tech.trim(),
      acquirer: acquirer.trim(),
      price: price ? price.trim() : 'undisclosed',
    };
  }
  // Funding deal?
  m = line.match(DEAL_RE);
  if (m) {
    const [, emoji, name, hq, tech, amt, unit, roundType, investors] = m;
    const investorList = parseInvestorList(investors);
    return {
      kind: 'funding',
      emoji: emoji.trim(),
      sector: refineSector(EMOJI_TO_SECTOR[emoji.trim()] || 'other', tech),
      name: name.trim(),
      hq: hq.trim(),
      tech: tech.trim(),
      amount: parseFloat(amt) * (unit.toLowerCase() === 'b' ? 1000 : 1),
      roundType: roundType.trim(),
      leadInvestor: investorList[0] || null,
      investors: investorList,
    };
  }
  return null;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node ctvc-parser.js <file> | echo "..." | node ctvc-parser.js -');
    process.exit(1);
  }
  const text = arg === '-' ? await new Promise(r => { let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>r(s)); }) : await fs.readFile(arg, 'utf-8');
  const lines = text.split(/\n+/).filter(l => l.trim().length > 20);
  const parsed = lines.map(parseLine).filter(Boolean);
  console.log(JSON.stringify(parsed, null, 2));
  console.error(`\nParsed ${parsed.length}/${lines.length} lines`);
  console.error(`  funding:      ${parsed.filter(p=>p.kind==='funding').length}`);
  console.error(`  ipo:          ${parsed.filter(p=>p.kind==='ipo').length}`);
  console.error(`  acquisition:  ${parsed.filter(p=>p.kind==='acquisition').length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
