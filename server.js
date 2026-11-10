import 'dotenv/config'
import express from 'express'
import { Mppx, tempo } from 'mppx/express'
import { Store } from 'mppx/server'
import { Mppx as MppxClient, tempo as tempoClient } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const app = express()

app.set('trust proxy', true)

// ---------- MPP PAYMENT CONFIGURATION ----------

const CURRENCY = '0x20c0000000000000000000000000000000000000'
const PRICE = '0.02'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    tempo({
      currency: CURRENCY,
      recipient: process.env.RECIPIENT,
      testnet: true,
      store: Store.memory(),
    })
  ],
})

// ---------- GITHUB HELPER ----------

const GH = 'https://api.github.com'

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'repo-analyser',
  ...(process.env.GITHUB_TOKEN && {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
  }),
}

const cache = new Map()
const TTL = 10 * 60 * 1000

const gh = async (path) => {
  const hit = cache.get(path)

  if (hit && Date.now() - hit.t < TTL) return hit.v

  const r = await fetch(`${GH}${path}`, { headers: ghHeaders })

  if (r.status === 204) return []

  if (!r.ok) {
    throw Object.assign(new Error(`GitHub ${r.status}`), {
      status: r.status
    })
  }

  const v = await r.json()

  cache.set(path, {
    t: Date.now(),
    v
  })

  return v
}

// ---------- REPOSITORY ANALYSIS ----------

async function analyze(p, repo) {

  const [langs, contributors, commits, root, releases] =
    await Promise.all([
      gh(`/repos/${p}/languages`).catch(() => ({})),
      gh(`/repos/${p}/contributors?per_page=100`).catch(() => []),
      gh(`/repos/${p}/commits?per_page=100`).catch(() => []),
      gh(`/repos/${p}/contents/`).catch(() => []),
      gh(`/repos/${p}/releases?per_page=5`).catch(() => []),
    ])

  const list = (x) => Array.isArray(x) ? x : []

  const total =
    Object.values(langs).reduce((a, b) => a + b, 0) || 1

  const languages = Object.fromEntries(
    Object.entries(langs).map(([k, v]) => [
      k,
      +((v / total) * 100).toFixed(1)
    ])
  )

  const contribs = list(contributors)

  const sum =
    contribs.reduce((a, c) => a + c.contributions, 0) || 1

  let acc = 0
  let busFactor = 0

  for (const c of contribs) {
    acc += c.contributions
    busFactor++

    if (acc / sum >= 0.5) break
  }

  const daysSincePush = Math.floor(
    (Date.now() - new Date(repo.pushed_at)) / 864e5
  )

  const dates = list(commits).map(
    (c) => new Date(c.commit.author.date)
  )

  const spanDays = dates.length > 1
    ? Math.max(1, (dates[0] - dates[dates.length - 1]) / 864e5)
    : 1

  const commitsPerWeek = dates.length
    ? +((dates.length / spanDays) * 7).toFixed(1)
    : 0

  const names = list(root).map(
    (f) => f.name.toLowerCase()
  )

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

  score += Object.values(checks).filter(Boolean).length * 8
  score += daysSincePush < 30 ? 20 : daysSincePush < 180 ? 10 : 0
  score += busFactor >= 3 ? 16 : busFactor === 2 ? 8 : 0

  return {
    repo: repo.full_name,
    description: repo.description,
    stars: repo.stargazers_count,
    open_issues: repo.open_issues_count,
    languages,

    activity: {
      days_since_last_push: daysSincePush,
      commits_per_week: commitsPerWeek,
      latest_release: list(releases)[0]?.tag_name ?? null,
    },

    bus_factor: busFactor,
    checks,
    health_score: Math.min(100, score),

    missing: Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k),
  }
}

// ---------- VALIDATE REPOSITORY ----------

const validateRepo = async (req, res, next) => {

  const repo = String(req.query.repo || 'expressjs/express')

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return res.status(400).json({
      error: 'Use ?repo=owner/name'
    })
  }

  try {
    req.repoPath = repo
    req.repoData = await gh(`/repos/${repo}`)

    next()

  } catch (e) {

    res.status(e.status === 404 ? 404 : 502).json({
      error: e.status === 404
        ? 'Repository not found'
        : e.message
    })
  }
}

// ---------- ROUTES ----------

app.use(express.static('public'))

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true })
})

// ---------- FREE SAMPLE ----------

app.get('/api/sample', async (req, res) => {

  try {
    const repo = await gh('/repos/expressjs/express')

    res.status(200).json(
      await analyze('expressjs/express', repo)
    )

  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// ---------- PAID ANALYSIS ENDPOINT ----------

app.get(
  '/api/analyze',
  validateRepo,
  mppx.charge({ amount: PRICE }),

  async (req, res) => {

    try {

      const report = await analyze(req.repoPath, req.repoData)

      res.status(200).json({
        status: 200,
        message: 'Payment successful. Repository analysis completed.',
        report
      })

    } catch (e) {

      res.status(e.status === 404 ? 404 : 502).json({
        error: e.message
      })
    }
  }
)

// ---------- DEMO AGENT ----------

let demoClient

const getDemoClient = () => (
  demoClient ??= MppxClient.create({
    polyfill: false,

    methods: [
      tempoClient({
        account: privateKeyToAccount(
          process.env.DEMO_PAYER_KEY
        )
      })
    ],
  })
)

let demoHits = []

app.post('/demo/agent', async (req, res) => {

  if (!process.env.DEMO_PAYER_KEY) {
    return res.status(503).json({
      error: 'Demo agent not configured (DEMO_PAYER_KEY missing)'
    })
  }

  const repo = String(req.query.repo || '')

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return res.status(400).json({
      error: 'Use ?repo=owner/name'
    })
  }

  const now = Date.now()

  demoHits = demoHits.filter(
    (t) => now - t < 60_000
  )

  if (demoHits.length >= 10) {
    return res.status(429).json({
      error: 'Demo agent is busy. Try again in a minute.'
    })
  }

  demoHits.push(now)

  try {

    const base =
      process.env.PUBLIC_URL ||
      `${req.protocol}://${req.get('host')}`

    const r = await getDemoClient().fetch(
      `${base}/api/analyze?repo=${encodeURIComponent(repo)}`
    )

    const report = await r.json().catch(() => null)

    const paymentHeaders = Object.fromEntries(
      [...r.headers].filter(
        ([k]) => /payment|receipt/i.test(k)
      )
    )

    res.status(r.ok ? 200 : r.status).json({
      status: r.status,
      paymentHeaders,
      report,
    })

  } catch (e) {

    res.status(502).json({
      error: 'Demo payment failed: ' + e.message
    })
  }
})

// ---------- MPP DISCOVERY: OPENAPI ----------

app.get('/openapi.json', (req, res) => {

  res.status(200).json({

    openapi: '3.1.0',

    info: {
      title: 'Repo Analyser',
      version: '1.0.0',

      description:
        `Health report for any public GitHub repo: hygiene checks, bus factor, activity and a 0-100 score. Costs ${PRICE} USD per call, paid over MPP (HTTP 402).`,
    },

    servers: [
      {
        url: 'https://mpp-hackathon-stripe.onrender.com'
      }
    ],

    'x-service-info': {

      categories: [
        'developer-tools',
        'compute'
      ],

      docs: {
        homepage:
          'https://mpp-hackathon-stripe.onrender.com',

        llms:
          'https://mpp-hackathon-stripe.onrender.com/llms.txt',

        apiReference:
          'https://mpp-hackathon-stripe.onrender.com/openapi.json'
      }
    },

    paths: {

      '/health': {
        get: {
          summary: 'Check service health',

          responses: {
            200: {
              description: 'Service is running'
            }
          }
        }
      },

      '/api/sample': {
        get: {
          summary: 'Get a free sample repository analysis',

          responses: {
            200: {
              description: 'Sample health report'
            }
          }
        }
      },

      '/api/analyze': {

        get: {

          summary: 'Analyze a GitHub repository',

          operationId: 'analyzeRepository',

          description:
            'Analyzes a public GitHub repository. Requires payment of 0.02 pathUSD on Tempo testnet.',

          parameters: [
            {
              name: 'repo',
              in: 'query',
              required: true,

              schema: {
                type: 'string',
                example: 'expressjs/express'
              },

              description:
                'GitHub repository in owner/name format'
            }
          ],

          'x-payment-info': {

            offers: [
              {
                intent: 'charge',
                method: 'tempo',
                amount: '20000',
                currency: CURRENCY,
                description: '0.02 pathUSD per repository analysis'
              }
            ]
          },

          responses: {

            200: {
              description: 'Payment successful. Repository health report returned.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: {
                        type: 'integer',
                        example: 200
                      },
                      message: {
                        type: 'string',
                        example: 'Payment successful. Repository analysis completed.'
                      },
                      report: {
                        type: 'object',
                        description: 'Repository health analysis'
                      }
                    }
                  }
                }
              }
            },

            400: {
              description: 'Invalid repository format. Not charged.'
            },

            402: {
              description: 'Payment Required. MPP payment challenge.'
            },

            404: {
              description: 'Repository not found. Not charged.'
            },

            502: {
              description: 'GitHub API error'
            }
          }
        }
      }
    }
  })
})

// ---------- LLMS.TXT ----------

app.get('/llms.txt', (req, res) => {

  res.type('text/plain').send(`
# Repo Analyser

A GitHub repository analysis API powered by Machine Payments Protocol (MPP).

## Description

Analyze public GitHub repositories and receive a repository health report.

## Features

- Repository health score (0-100)
- Programming language distribution
- Contributor bus factor
- Commit activity analysis
- Latest release information
- Repository hygiene checks
- Missing configuration detection

## API Endpoints

### GET /health

Checks whether the service is running.

### GET /api/sample

Returns a free sample analysis of expressjs/express.

### GET /api/analyze?repo=owner/name

Analyzes a public GitHub repository.

Payment required.

## Payment

- Protocol: Machine Payments Protocol (MPP)
- Method: Tempo
- Intent: charge
- Currency: pathUSD
- Network: Tempo testnet
- Price: 0.02 pathUSD per request

Unauthenticated requests receive HTTP 402 with an MPP payment challenge.

## Example

GET /api/analyze?repo=expressjs/express

## Discovery

OpenAPI specification:

https://mpp-hackathon-stripe.onrender.com/openapi.json
  `)
})

// ---------- START SERVER ----------

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})