/**
 * CTVC parser as a reusable library module.
 * Same parser as ctvc-parser.js (CLI) but exports for use by ctvc-ingest.js.
 */

const EMOJI_TO_SECTOR = {
  '⚡': 'energy', '🔋': 'storage', '⚒️': 'minerals', '☀️': 'solar', '💨': 'wind',
  '🏠': 'buildings', '🚗': 'transport', '🛵': 'transport', '🚆': 'transport', '🚴': 'transport',
  '🌾': 'ag', '🌱': 'ag', '🥩': 'food', '🍎': 'food', '💧': 'water', '👕': 'circular',
  '♻️': 'circular', '🧬': 'biotech', '🏭': 'industrial', '🛰': 'space', '⚙️': 'engineering',
  '🏗': 'buildings', '🌍': 'climate', '🌎': 'climate', '🌏': 'climate',
};

export function refineSector(emojiSector, tech) {
  if (emojiSector !== 'energy') return emojiSector;
  const t = (tech || '').toLowerCase();
  if (/\bnuclear\b|\bsmr\b|reactor|fission|fusion/.test(t)) return 'nuclear';
  if (/\bhydrogen\b|electrolyzer|\bh2\b/.test(t)) return 'hydrogen';
  if (/\bbattery\b|storage|\bcell\b/.test(t)) return 'storage';
  if (/\bsolar\b|\bpv\b/.test(t)) return 'solar';
  if (/\bgrid\b|transmission/.test(t)) return 'grid';
  if (/\bev\b|charging/.test(t)) return 'transport';
  if (/renewable|clean energy/.test(t)) return 'renewable';
  return 'energy';
}

const DEAL_RE = /^\s*([^A-Za-z0-9]+?)\s+([^,]+?),\s+(?:a|an)\s+(.+?)-based\s+(.+?),\s+raised\s*\$?([\d.]+)\s*([mb])n?\s+in\s+(.+?)\s+funding\s+from\s+(.+?)\.?\s*$/iu;
const IPO_RE = /^\s*([^A-Za-z0-9]+?)\s+([^,]+?),\s+(?:a|an)\s+(.+?)-based\s+(.+?),\s+announced\s+an\s+IPO\s+at\s+\$?([\d.]+)\s*([mb])n?\s+on\s+(\w+)(?:\s+under\s+ticker\s+(\w+))?/iu;
const ACQ_RE = /^\s*([^A-Za-z0-9]+?)\s+([^,]+?),\s+(?:a|an)\s+(.+?)-based\s+(.+?),\s+was\s+acquired\s+by\s+(.+?)(?:\s+for\s+(.+?))?\.?\s*$/iu;

function parseInvestorList(raw) {
  return raw
    .replace(/\s+and\s+others\.?$/i, '')
    .replace(/\s+and\s+other\s+investors\.?$/i, '')
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map(s => s.trim())
    .filter(s => s && !/^(others?|other investors?)$/i.test(s));
}

export function parseLine(line) {
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
      exchange, ticker,
    };
  }
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

export function splitIntoDealLines(text) {
  return text.split(/\n+/).filter(l => l.trim().length > 20);
}
