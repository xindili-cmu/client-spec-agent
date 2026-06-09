// GreenStack UI kit — main feed screen + composition root.
const { NewsCard, CategoryTabs, Button, Icon } = window;

// Day labels computed from real Date so they update with the calendar.
const _fmtDayLabel = (offset, prefix) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  const dow = d.toLocaleDateString('en-US', { weekday: 'long' });
  const mon = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${prefix} — ${dow}, ${mon}`;
};
const DAY_LABELS = {
  today:     _fmtDayLabel(0, 'Today'),
  yesterday: _fmtDayLabel(1, 'Yesterday'),
  older:     'Earlier this week',
};

function FeedToolbar({ view, count }) {
  const meta = {
    curated: { title: 'Curated', sub: 'AI-selected ESG signal · updated 08:10' },
    all: { title: 'All stories', sub: 'Full firehose across every source' },
    daily: { title: 'Daily brief', sub: 'Yesterday, packaged into eight sections' },
    sources: { title: 'Sources', sub: 'Outlets GreenStack monitors' },
    saved: { title: 'Saved', sub: 'Stories you bookmarked' },
  }[view] || { title: 'Curated', sub: '' };
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-3xl)', letterSpacing: '-0.015em', color: 'var(--text-primary)' }}>{meta.title}</h1>
        <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--text-tertiary)' }}>{meta.sub}</p>
      </div>
      <span style={{ flex: 1 }} />
      <Button variant="ghost" size="sm" iconStart="arrow-down-wide-narrow">Signal score</Button>
    </div>
  );
}

function FeedApp() {
  const [view, setView] = React.useState('curated');
  const [category, setCategory] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState('s3');

  const compact = view === 'all';
  const q = query.trim().toLowerCase();

  let stories = window.GS_STORIES.filter((s) => {
    if (category !== 'all' && s.category !== category) return false;
    if (q && !(s.title.toLowerCase().includes(q) || s.source.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q))) return false;
    return true;
  });

  const days = ['today', 'yesterday', 'older'];
  const grouped = days.map((d) => ({ day: d, items: stories.filter((s) => s.day === d) })).filter((g) => g.items.length);
  // lead = top-scoring story in the first visible day, curated view only
  const leadId = (!compact && grouped.length && grouped[0].items.length)
    ? [...grouped[0].items].sort((a, b) => b.score - a.score)[0].id : null;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-page)' }}>
      <AppHeader query={query} onQuery={setQuery} />
      <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto', display: 'flex', alignItems: 'flex-start', gap: 24, padding: '0 24px' }}>
        <NavRail view={view} onView={setView} sources={window.GS_SOURCES} />

        <main style={{ flex: 1, minWidth: 0, maxWidth: 'var(--feed-column)', padding: '24px 0 64px' }}>
          <FeedToolbar view={view} count={stories.length} />

          <div style={{ position: 'sticky', top: 'var(--header-height)', zIndex: 10, padding: '10px 0', margin: '0 0 8px',
            background: 'linear-gradient(var(--surface-page) 72%, transparent)' }}>
            <CategoryTabs value={category} onChange={setCategory} />
          </div>

          {grouped.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>
              <Icon name="search-x" size={28} style={{ color: 'var(--ink-300)', margin: '0 auto 10px' }} />
              <div>No stories match “{query}”.</div>
            </div>
          )}

          {grouped.map((g) => (
            <section key={g.day} style={{ marginBottom: 26 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 14px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>{DAY_LABELS[g.day]}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>{g.items.length} stories</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {g.items.map((s) => (
                  <NewsCard key={s.id}
                    variant={s.id === leadId ? 'lead' : (compact ? 'compact' : 'default')}
                    category={s.category} score={s.score} source={s.source} time={s.time} date={s.date}
                    title={s.title} summary={s.summary} whyItMatters={compact ? null : s.why}
                    selected={selected === s.id}
                    onClick={() => setSelected(s.id)} />
                ))}
              </div>
            </section>
          ))}
        </main>

        <DigestRail stories={window.GS_STORIES.filter((s) => s.day === 'today')} onPick={setSelected} />
      </div>
    </div>
  );
}

// Wait for news.json to load (via app.data.jsx's GS_DATA_READY promise) before
// first render so the feed doesn't flash empty. If app.data.jsx didn't expose a
// promise (older revisions), render immediately as a graceful fallback.
const _gsRender = () => ReactDOM.createRoot(document.getElementById('root')).render(<FeedApp />);
if (window.GS_DATA_READY && typeof window.GS_DATA_READY.then === 'function') {
  window.GS_DATA_READY.then(_gsRender);
} else {
  _gsRender();
}
