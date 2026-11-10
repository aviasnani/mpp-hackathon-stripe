// Standalone agent: finds the paywall, pays it, prints the report.
// Usage: node agent.js owner/name   (SERVICE_URL defaults to localhost)
import 'dotenv/config'
import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const base = process.env.SERVICE_URL || 'http://localhost:3000'
const repo = process.argv[2] || 'expressjs/express'

const mppx = Mppx.create({
  polyfill: false,
  methods: [tempo({ account: privateKeyToAccount(process.env.DEMO_PAYER_KEY) })],
})

const url = `${base}/api/analyze?repo=${encodeURIComponent(repo)}`
console.log('GET', url)
const res = await mppx.fetch(url) // handles 402 -> pay -> retry automatically
console.log('status:', res.status)
for (const [k, v] of res.headers) if (/payment|receipt/i.test(k)) console.log(k + ':', v)
console.log(JSON.stringify(await res.json(), null, 2))