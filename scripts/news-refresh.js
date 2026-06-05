/**
 * CEH News Refresh — Curated Climate · Energy · Hardware News Feed
 * 
 * 6 CEH Verticals:
 *   1. Clean Power        — solar, wind, nuclear (SMR/fusion), geothermal
 *   2. Electrification    — EVs, heat pumps, building efficiency, data centers
 *   3. Industrial Decarb  — CCS/DAC, green steel/cement, hydrogen, CBAM
 *   4. Grid Tech          — storage, transmission, grid software, microgrids
 *   5. Robotics & AI      — humanoid robots, industrial automation, physical AI
 *   6. Ag & Foods         — alt protein, precision ag, fertilizer alternatives
 * 
 * Pipeline: Exa search → deduplicate → Claude curation → news.json
 * 
 * Env vars:
 *   EXA_API_KEY, ANTHROPIC_API_KEY
 * 
 * Usage:
 *   node scripts/news-refresh.js
 *   DRY_RUN=true node scripts/news-refresh.js
 */

const fs = require('fs');
const path = require('path');

const EXA_API_KEY = process.env.EXA_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY_RUN = process.env.DRY_RUN === 'true';

const NEWS_PATH = path.join(__dirname, '..', 'news.json');
const MAX_ITEMS = 30;
const LOOKBACK_DAYS = 3;
const CURATE_TOP_N = 25;

// ── CEH Category Queries ────────────────────────────────────────────────────

const CATEGORY_QUERIES = [
  {
    category: 'clean-power',
    queries: [
      'small modular reactor SMR nuclear fusion startup funding 2026',
      'solar wind renewable energy project financing 2026',
      'geothermal enhanced energy startup investment'
    ]
  },
  {
    category: 'electrification',
    queries: [
      'electric vehicle EV charging infrastructure investment 2026',
      'heat pump building electrification efficiency startup',
      'data center energy demand power procurement'
    ]
  },
  {
    category: 'industrial-decarb',
    queries: [
      'carbon capture CCUS direct air capture startup funding 2026',
      'green hydrogen electrolyzer production investment',
      'green steel cement industrial decarbonization'
    ]
  },
  {
    category: 'grid-tech',
    queries: [
      'grid-scale battery storage long duration energy startup 2026',
      'transmission grid modernization FERC policy',
      'virtual power plant microgrid distributed energy'
    ]
  },
  {
    category: 'robotics-ai',
    queries: [
      'humanoid robot manufacturing automation startup funding 2026',
      'industrial robotics physical AI infrastructure construction',
      'autonomous drone inspection energy infrastructure'
    ]
  },
  {
    category: 'ag-foods',
    queries: [
      'alternative protein cultivated meat startup funding 2026',
      'precision agriculture agtech climate smart farming',
      'fertilizer alternative biotech agricultural decarbonization'
    ]
  }
];

// ── Exa API ─────────────────────────────────────────────────────────────────

async function searchExa(query, numResults = 5) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - LOOKBACK_DAYS);

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': EXA_API_KEY
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults,
      startPublishedDate: startDate.toISOString().split('T')[0],
      useAutoprompt: true,
      contents: {
        text: { maxCharacters: 800 },
        highlights: { numSentences: 2 }
      }
    })
  });

  if (!res.ok) {
    console.error(`  Exa error for "${query}": ${res.status}`);
    return [];
  }

  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    text: r.text || '',
    highlights: (r.highlights || []).join(' '),
    publishedDate: r.publishedDate || new Date().toISOString(),
    score: r.score || 0,
    source: extractDomain(r.url)
  }));
}

function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    const map = {
      'reuters.com': 'Reuters', 'bloomberg.com': 'Bloomberg',
      'ft.com': 'Financial Times', 'nytimes.com': 'NYT',
      'wsj.com': 'WSJ', 'canarymedia.com': 'Canary Media',
      'utilitydive.com': 'Utility Dive', 'techcrunch.com': 'TechCrunch',
      'axios.com': 'Axios', 'politico.com': 'Politico',
      'energy.gov': 'DOE', 'nature.com': 'Nature',
      'agfunder.com': 'AgFunder', 'therobotreport.com': 'Robot Report',
      'greentechmedia.com': 'GTM', 'spglobal.com': 'S&P Global'
    };
    return map[hostname] || hostname;
  } catch { return 'Unknown'; }
}

// ── Claude Curation ─────────────────────────────────────────────────────────

async function curateWithClaude(rawItems) {
  const items = rawItems.slice(0, CURATE_TOP_N).map((item, i) => ({
    index: i,
    title: item.title,
    text: item.text?.substring(0, 400),
    category: item.category,
    source: item.source
  }));

  const systemPrompt = `你是 Fusion Park 的 CEH (Climate · Energy · Hardware) 新闻策展 AI。

Fusion Park 是一家专注清洁能源和硬科技的战略与资本顾问公司，帮助 CEH 公司从商业化就绪走向 FOAK 和上市。

6 个 CEH 垂直领域：
1. Clean Power (clean-power) — 太阳能、风电、核能(SMR/聚变)、地热
2. Electrification & Efficiency (electrification) — EV、热泵、建筑能效、数据中心
3. Industrial Decarbonization (industrial-decarb) — CCS/DAC、绿钢/绿色水泥、氢能、碳关税
4. Grid Tech (grid-tech) — 储能、输电、电网软件、微网
5. Robotics & Physical AI (robotics-ai) — 人形机器人、工业自动化、物理AI
6. Agriculture & Foods (ag-foods) — 替代蛋白、精准农业、生物肥料

评分标准（以对 CEH 公司融资/上市/FOAK 的影响力为核心）：
- 90+ = 行业里程碑，直接影响投资决策
- 80-89 = 重要进展，值得深度跟踪
- 70-79 = 有参考价值
- 60-69 = 一般动态
- <60 = 噪音

请只返回 JSON 数组（不要 markdown 代码块），格式：
[{"index":0,"curatedScore":85,"curatedReason":"中文推荐理由（一句话，点明对CEH公司/投资者的影响）","tags":["tag1","tag2"],"summary":"One-line English summary"}]

只保留 curatedScore >= 65 的条目。`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20241022',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `请策展以下 ${items.length} 条新闻：\n\n${JSON.stringify(items, null, 2)}` }]
    })
  });

  if (!res.ok) {
    console.error(`  Claude error: ${res.status}`);
    return [];
  }

  const data = await res.json();
  const text = data.content?.map(c => c.text || '').join('') || '';
  try {
    return JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch (e) {
    console.error('  Parse error:', e.message);
    return [];
  }
}

// ── Dedup ───────────────────────────────────────────────────────────────────

function dedup(items) {
  const seen = new Map();
  return items.filter(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').substring(0, 60);
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n⚡ CEH News Refresh — ${new Date().toISOString()}`);
  if (DRY_RUN) { console.log('  DRY_RUN mode\n'); return; }
  if (!EXA_API_KEY || !ANTHROPIC_API_KEY) { console.error('❌ Missing API keys'); process.exit(1); }

  let raw = [];
  for (const cat of CATEGORY_QUERIES) {
    console.log(`📡 ${cat.category}`);
    for (const q of cat.queries) {
      const r = await searchExa(q, 4);
      raw.push(...r.map(x => ({ ...x, category: cat.category })));
      console.log(`   "${q}" → ${r.length}`);
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`\n📊 Raw: ${raw.length}`);
  const unique = dedup(raw);
  unique.sort((a, b) => (b.score || 0) - (a.score || 0));
  console.log(`   Unique: ${unique.length}`);

  console.log(`\n🤖 Curating with Claude...`);
  const curated = await curateWithClaude(unique);
  console.log(`   Curated: ${curated.length} items`);

  const final = curated.map(c => {
    const o = unique[c.index];
    if (!o) return null;
    return {
      id: `news-${Date.now()}-${c.index}`,
      title: o.title,
      summary: c.summary || o.highlights || o.text?.substring(0, 200),
      category: o.category,
      source: o.source,
      sourceUrl: o.url,
      publishedAt: o.publishedDate,
      curatedScore: c.curatedScore,
      curatedReason: c.curatedReason,
      tags: c.tags || []
    };
  }).filter(Boolean).sort((a, b) => b.curatedScore - a.curatedScore);

  // Merge with existing (keep 7 days)
  let existing = [];
  try {
    const old = JSON.parse(fs.readFileSync(NEWS_PATH, 'utf8'));
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    existing = (old.items || []).filter(i => new Date(i.publishedAt) > cutoff);
  } catch {}

  const merged = dedup([...final, ...existing]).slice(0, MAX_ITEMS);

  fs.writeFileSync(NEWS_PATH, JSON.stringify({
    meta: {
      lastUpdated: new Date().toISOString(),
      totalItems: merged.length,
      categories: ['clean-power', 'electrification', 'industrial-decarb', 'grid-tech', 'robotics-ai', 'ag-foods']
    },
    items: merged
  }, null, 2));

  console.log(`\n✅ ${merged.length} items → news.json`);
  return { newItems: final.length, totalItems: merged.length,
    headlines: merged.slice(0, 5).map(i => `[${i.curatedScore}] ${i.title}`) };
}

main().then(s => {
  if (s) { console.log('\n📰 Top:'); s.headlines.forEach(h => console.log(`   ${h}`)); }
  console.log('Done.\n');
}).catch(e => { console.error('❌', e); process.exit(1); });

module.exports = { main };
