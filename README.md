# FusionPark Climate Tech Intelligence — Cloud Deploy

Cloud-hosted version of the climate-tech dashboard. Lives on Cloudflare Pages, refreshes weekly via GitHub Actions, sends email digest each Monday.

**What this is**

- `index.html` — the dashboard (loads data from `data.json`)
- `data.json` — single source of truth: 26 startups + 143 VCs
- `scripts/refresh.js` — Node.js script that runs weekly, queries Exa API, writes changelog, sends email
- `.github/workflows/refresh.yml` — GitHub Actions cron (every Monday 9am UTC)
- `package.json` — Node 20+ runtime config

**Architecture**

```
GitHub repo (private)
  ├── data.json ────────────────┐
  ├── index.html (fetches data) │ commits weekly
  └── refresh.js                ├──→ Cloudflare Pages ──→ climate-intel.pages.dev
                                │       (auto-deploys)         (protected by Cloudflare Access)
GitHub Actions cron (Mon 9am UTC)
  → runs refresh.js
  → calls Exa REST API × 26 startups
  → writes data/changelog_YYYY-MM-DD.md
  → sends email digest via Resend ──→ your inbox
  → commits + pushes
```

---

## Setup — one-time

### Step 1 — Get API keys

You'll need 2 API keys before starting:

1. **Exa REST API key**
   - Go to [exa.ai](https://exa.ai) → sign in → Dashboard → API Keys → Create new
   - Free tier: 1000 calls/month (weekly job uses ~80, plenty of room)
   - Copy the key, you'll add it to GitHub in Step 4

2. **Resend API key** (for email digest)
   - Go to [resend.com](https://resend.com) → sign up (free tier: 3000 emails/month)
   - Settings → API Keys → Create
   - No domain verification required if you use `onboarding@resend.dev` as sender (already configured in the script)
   - Copy the key

### Step 2 — Create GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Repository name: `fusionpark-climate-intel` (or whatever you prefer)
3. Set to **Private**
4. Don't initialize with README — we'll push these files
5. Create

### Step 3 — Push these files to the repo

Open Terminal:

```bash
cd "/Users/lilali/climate agent/cloud-deploy"
git init
git add .
git commit -m "Initial commit: v3.0 cloud deploy"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/fusionpark-climate-intel.git
git push -u origin main
```

Replace `YOUR-USERNAME` with your actual GitHub username.

### Step 4 — Add secrets to GitHub

In your new repo on github.com:

1. Settings → Secrets and variables → Actions → New repository secret
2. Add these 4 secrets one at a time:

| Name | Value |
|---|---|
| `EXA_API_KEY` | Your Exa API key from Step 1 |
| `RESEND_API_KEY` | Your Resend API key from Step 1 |
| `EMAIL_TO` | `cindylips2001@gmail.com` (or wherever you want digests) |
| `DASHBOARD_URL` | Leave empty for now — fill in after Step 6 |

### Step 5 — Test the workflow manually

1. Go to repo → Actions tab
2. Click `Weekly Climate Intel Refresh` in the left sidebar
3. Click **Run workflow** → Run workflow (green button)
4. Wait 2-3 minutes, then refresh
5. Click the run to see logs. You should see:
   - "Starting weekly refresh — 26 startups"
   - Each startup checked
   - "Email sent to ..."
6. Check your inbox for the digest email

If it fails: check the log for the failing step. Common issues:
- `EXA_API_KEY` not set or wrong → "Exa 401" error
- `RESEND_API_KEY` not set or wrong → "Resend 401" error (script will continue without email)
- No network → "fetch failed"

### Step 6 — Connect Cloudflare Pages

1. Sign up at [cloudflare.com](https://cloudflare.com) (free)
2. Dashboard → Workers & Pages → Create application → Pages → Connect to Git
3. Authorize Cloudflare to access your GitHub
4. Select the `fusionpark-climate-intel` repo
5. Build settings: leave all blank (no build step needed — it's a static site)
6. Save and Deploy
7. After deploy completes, you'll get a URL like `climate-intel-xyz.pages.dev`
8. Go back to GitHub repo → Settings → Secrets → edit `DASHBOARD_URL` and paste the URL

### Step 7 — Add Cloudflare Access (login protection)

By default, Cloudflare Pages URLs are public. To require login:

1. Cloudflare Dashboard → Zero Trust → Access → Applications
2. Add an application → Self-hosted
3. Application name: `FusionPark Climate Intel`
4. Application domain: paste your `*.pages.dev` URL
5. Add policy:
   - Action: Allow
   - Include: Emails → add your email (`cindylips2001@gmail.com`)
6. Save
7. Now visiting your dashboard URL will prompt for email-OTP login first

### Step 8 — (Optional) Custom domain

If you want `climate-intel.yourdomain.com`:

1. Cloudflare Pages project → Custom domains → Set up
2. Add your domain (must be on Cloudflare DNS)
3. Cloudflare auto-issues SSL cert
4. Update the `DASHBOARD_URL` GitHub secret with the new URL

---

## Daily / weekly usage

**Just view the dashboard**
- Open `https://your-pages-url.pages.dev` in any browser (logs in via Cloudflare Access first time per device)

**Get weekly updates**
- Every Monday 9am UTC, GitHub Actions runs `refresh.js`
- You receive an email digest with detected changes
- Dashboard auto-redeploys with updated `dataAsOf` date

**Manually trigger a refresh** (e.g., big news broke and you don't want to wait until Monday)
- Repo → Actions → Weekly Climate Intel Refresh → Run workflow

**Merge a candidate from the email into the dashboard**
1. Open `data.json` in the GitHub repo (or edit locally)
2. Find the startup, update `round` / `leadership` / `recentNews` fields
3. Commit (web UI: Edit → make changes → Commit changes)
4. Cloudflare auto-redeploys within ~30 seconds

**Add a new startup to the watchlist**
1. Open `data.json`, add a new entry to the `startups` array (copy the shape of an existing one)
2. Commit
3. Dashboard auto-updates

---

## Local testing

If you want to test changes before pushing:

```bash
cd "/Users/lilali/climate agent/cloud-deploy"

# Serve the static files (pick one)
npx serve                            # then open http://localhost:3000
# or
python3 -m http.server 8000         # then open http://localhost:8000

# Test the refresh script in DRY mode (no API calls, no email)
DRY_RUN=true node scripts/refresh.js

# Real test (requires env vars)
EXA_API_KEY=your_key EMAIL_TO=your@email.com node scripts/refresh.js
```

> **Don't open `index.html` directly via `file://`** — browsers block `fetch()` of local files for CORS reasons. Use a local server.

---

## Cost estimate

- **GitHub**: free (private repo + 2000 Actions minutes/month, weekly job uses ~5)
- **Cloudflare**: free (Pages + Access for personal use)
- **Exa**: free (1000 calls/month, weekly job uses ~80)
- **Resend**: free (3000 emails/month, weekly job sends 1)

**Total: $0/month** for this prototype scale.

If you scale up (more startups, more frequent refreshes), the bottleneck would be Exa calls — paid Exa tier starts at $5/month for higher quotas.

---

## Files reference

| Path | Purpose |
|---|---|
| `index.html` | Dashboard frontend. Fetches `data.json` on load. |
| `data.json` | Single source of truth: 26 startups + 143 VCs with verified Exa data. |
| `scripts/refresh.js` | Weekly cron logic: Exa search → diff → changelog → email. |
| `.github/workflows/refresh.yml` | GitHub Actions cron config + commit logic. |
| `package.json` | Node 20+ runtime (no npm dependencies — uses built-in fetch). |
| `data/changelog_YYYY-MM-DD.md` | Generated weekly — diff log for that week. |
| `.gitignore` | Ignore node_modules / .env / .DS_Store. |
| `README.md` | This file. |

---

## Troubleshooting

**Email not arriving**
- Check spam folder
- Verify `RESEND_API_KEY` secret is set correctly
- Try sending a test email via Resend dashboard
- Check Actions logs for "Resend 4xx" errors

**Cloudflare Access locking you out**
- Zero Trust → Access → Applications → edit your app → Authentication tab → check you have an Identity Provider configured (default: One-time PIN to email)

**Dashboard shows "Failed to load data.json"**
- Confirm `data.json` exists in repo root
- Cloudflare Pages deploy completed (check Pages dashboard)
- If running locally, you must use a server (`npx serve`), not `file://`

**GitHub Actions failing**
- Check Actions log for the specific error
- Most common: missing secret. Verify all 4 are set under Settings → Secrets

**Want to skip the cron for a week?**
- Repo → Actions → Weekly Climate Intel Refresh → "..." menu → Disable workflow
- Re-enable when ready

---

## Next versions

Roadmap parked for future:

- **v3.1**: Add `cindyTargets: true` flag for confidential targets (Ecor Energy etc.) — separate "internal vs external" xlsx export
- **v3.2**: SPAC Bridge module — pull SEC EDGAR for active climate SPACs, match to startups by sector
- **v3.3**: Smart parser using Claude API in refresh.js (instead of regex) — better candidate extraction
- **v3.4**: Multi-user — let team members log in via Cloudflare Access, with edit logs

---

Generated by Claude (Cowork) · 2026-05-21 · for Cindy Li / Fusion Park.
