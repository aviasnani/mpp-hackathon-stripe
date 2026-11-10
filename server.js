import 'dotenv/config'
import express from 'express'
import { Mppx, tempo, Store } from 'mppx/express'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const app = express()
app.set('trust proxy', true) // correct host/protocol behind Render/Railway/Fly

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [tempo({
    currency: '0x20c0000000000000000000000000000000000000', // pathUSD (testnet)
    recipient: process.env.RECIPIENT,
    testnet: true,
    store: Store.memory()
  })],
})

const PRICE = '0.02'

// ---------- GitHub helper (with a small cache to protect rate limits) ----------
const GH = 'https://api.github.com'
const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'repo-analyser',
  ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
}
const cache = new Map()
const TTL = 10 * 60 * 1000
const gh = async (path) => {
  const hit = cache.get(path)
  if (hit && Date.now() - hit.t < TTL) return hit.v
  const r = await fetch(`${GH}${path}`, { headers: ghHeaders })
  if (r.status === 204) return []
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}`), { status: r.status })
  const v = await r.json()
  cache.set(path, { t: Date.now(), v })
  return v
}

// ---------- analysis ----------
async function analyze(p, repo) {
  const [langs, contributors, commits, root, releases] = await Promise.all([
    gh(`/repos/${p}/languages`).catch(() => ({})),
    gh(`/repos/${p}/contributors?per_page=100`).catch(() => []),
    gh(`/repos/${p}/commits?per_page=100`).catch(() => []),
    gh(`/repos/${p}/contents/`).catch(() => []),
    gh(`/repos/${p}/releases?per_page=5`).catch(() => []),
  ])
  const list = (x) => (Array.isArray(x) ? x : [])

  const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1
  const languages = Object.fromEntries(
    Object.entries(langs).map(([k, v]) => [k, +((v / total) * 100).toFixed(1)])
  )

  const contribs = list(contributors)
  const sum = contribs.reduce((a, c) => a + c.contributions, 0) || 1
  let acc = 0, busFactor = 0
  for (const c of contribs) { acc += c.contributions; busFactor++; if (acc / sum >= 0.5) break }

  const daysSincePush = Math.floor((Date.now() - new Date(repo.pushed_at)) / 864e5)
  const dates = list(commits).map((c) => new Date(c.commit.author.date))
  const spanDays = dates.length > 1 ? Math.max(1, (dates[0] - dates[dates.length - 1]) / 864e5) : 1
  const commitsPerWeek = dates.length ? +((dates.length / spanDays) * 7).toFixed(1) : 0

  const names = list(root).map((f) => f.name.toLowerCase())
  const has = (re) => names.some((n) => re.test(n))
  const checks = {
    license: !!repo.license,
    readme: has(/^readme/),
    ci: names.includes('.github'),
    tests: has(/^(test|tests|__tests__|spec)$/),
    security_policy: has(/^security\.md$/),
    contributing: has(/^contributing/),
    dockerfile: names.includes('dockerfile'),
    lockfile: has(/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|cargo\.lock|go\.sum)$/),
  }

  let score = 0
  score += Object.values(checks).filter(Boolean).length * 8      // up to 64
  score += daysSincePush < 30 ? 20 : daysSincePush < 180 ? 10 : 0
  score += busFactor >= 3 ? 16 : busFactor === 2 ? 8 : 0

  return {
    repo: repo.full_name,
    description: repo.description,
    stars: repo.stargazers_count,
    open_issues: repo.open_issues_count,
    languages,
    activity: { days_since_last_push: daysSincePush, commits_per_week: commitsPerWeek, latest_release: list(releases)[0]?.tag_name ?? null },
    bus_factor: busFactor,
    checks,
    health_score: Math.min(100, score),
    missing: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k),
  }
}

// Runs BEFORE the paywall: bad input or a missing repo never costs the caller money.
const validateRepo = async (req, res, next) => {
  const repo = String(req.query.repo || '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return res.status(400).json({ error: 'Use ?repo=owner/name' })
  }
  try {
    req.repoPath = repo
    req.repoData = await gh(`/repos/${repo}`)
    next()
  } catch (e) {
    res.status(e.status === 404 ? 404 : 502).json({ error: e.status === 404 ? 'Repository not found' : e.message })
  }
}

// ---------- routes ----------
app.use(express.static('public'))

app.get('/health', (req, res) => res.json({ ok: true }))

// Free, fixed-repo sample so humans can see the output before agents pay
app.get('/api/sample', async (req, res) => {
  try {
    const repo = await gh('/repos/expressjs/express')
    res.json(await analyze('expressjs/express', repo))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// The paid endpoint
app.get('/api/analyze', validateRepo, mppx.charge({ amount: PRICE }), async (req, res) => {
  try {
    res.json(await analyze(req.repoPath, req.repoData))
  } catch (e) {
    res.status(e.status === 404 ? 404 : 502).json({ error: e.message })
  }
})


// ---------- Demo agent ----------
// Lets the web page trigger a REAL paid call. The server pays /api/analyze using a
// funded TESTNET key (DEMO_PAYER_KEY), exactly like an external agent would.
// Use a different account from RECIPIENT. Never put a mainnet key here.
let demoClient
const getDemoClient = () => (demoClient ??= MppxClient.create({
  polyfill: false, // use the bound mppx.fetch so the server's own GitHub fetches are untouched
  methods: [tempoClient({ account: privateKeyToAccount(process.env.DEMO_PAYER_KEY) })],
}))
let demoHits = []
app.post('/demo/agent', async (req, res) => {
  if (!process.env.DEMO_PAYER_KEY) return res.status(503).json({ error: 'Demo agent not configured (DEMO_PAYER_KEY missing)' })
  const repo = String(req.query.repo || '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.status(400).json({ error: 'Use ?repo=owner/name' })
  const now = Date.now()
  demoHits = demoHits.filter((t) => now - t < 60_000)
  if (demoHits.length >= 10) return res.status(429).json({ error: 'Demo agent is busy. Try again in a minute.' })
  demoHits.push(now)
  try {
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`
    const r = await getDemoClient().fetch(`${base}/api/analyze?repo=${encodeURIComponent(repo)}`)
    const report = await r.json().catch(() => null)
    const paymentHeaders = Object.fromEntries([...r.headers].filter(([k]) => /payment|receipt/i.test(k)))
    res.status(r.ok ? 200 : r.status).json({ status: r.status, paymentHeaders, report })
  } catch (e) {
    res.status(502).json({ error: 'Demo payment failed: ' + e.message })
  }
})

// Machine-readable description so agents can find and understand the service.
// TODO: check mpp.dev docs for the exact payment-discovery fields and add them here.
app.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Repo Analyser',
      version: '1.0.0',
      description: `Health report for any public GitHub repo: hygiene checks, bus factor, activity and a 0-100 score. Costs ${PRICE} USD per call, paid over MPP (HTTP 402).`,
    },
    paths: {
      '/api/analyze': {
        get: {
          summary: 'Analyze a GitHub repository',
          parameters: [{ name: 'repo', in: 'query', required: true, schema: { type: 'string', example: 'expressjs/express' }, description: 'owner/name' }],
          responses: {
            200: { description: 'Health report (JSON)' },
            400: { description: 'Bad repo format. Not charged.' },
            402: { description: 'Payment required (MPP challenge)' },
            404: { description: 'Repository not found. Not charged.' },
          },
        },
      },
    },
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`))