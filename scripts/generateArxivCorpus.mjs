/**
 * Generates an academic paper corpus using the Semantic Scholar API.
 *
 * Unlike Wikipedia, arXiv papers have real publication years (recency signal)
 * and real citation counts (credibility signal), making those ranking sliders
 * genuinely meaningful rather than simulated.
 *
 * Usage:
 *   node scripts/generateArxivCorpus.mjs
 *   S2_API_KEY=your_key node scripts/generateArxivCorpus.mjs   (higher rate limit)
 *   ARXIV_CORPUS_SIZE=3000 node scripts/generateArxivCorpus.mjs
 *
 * Without an API key: ~100 requests / 5 min. With a free key from
 * https://www.semanticscholar.org/product/api#api-key it goes to 1 req/sec.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)
const https = _require('https')

const outputPath = resolve('src/data/arxivCorpus.json')
const targetPageCount = Number(process.env.ARXIV_CORPUS_SIZE ?? 2000)
const apiKey = process.env.S2_API_KEY ?? ''
const source = 'arxiv.org + semanticscholar.org'
const generatorVersion = 'semantic-scholar-v1'
const damping = 0.85
const maxIterations = 48
const tolerance = 1e-9
const checkpointIterations = new Set([0, 1, 2, 4, 8, 16, 32])

// Delay between API calls — 3.5s without key stays safely under 100/5min
const requestDelayMs = apiKey ? 1100 : 3500

// Diverse academic fields to search across for a varied graph
const searchQueries = [
  'machine learning neural networks',
  'climate change global warming',
  'quantum computing physics',
  'evolutionary biology genetics',
  'economic inequality poverty',
  'social networks information diffusion',
  'computer vision image recognition',
  'natural language processing text',
  'renewable energy solar wind',
  'epidemiology infectious disease',
  'political polarization democracy',
  'neuroscience cognition brain',
  'materials science nanotechnology',
  'astronomy cosmology dark matter',
  'human computer interaction design',
]

const S2_FIELDS = 'paperId,externalIds,title,abstract,year,citationCount,references.paperId'
const S2_SEARCH = 'https://api.semanticscholar.org/graph/v1/paper/search'
const S2_BATCH  = 'https://api.semanticscholar.org/graph/v1/paper/batch'

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main() {
  console.log(`Building arXiv/S2 corpus: target ${targetPageCount} papers`)
  if (!apiKey) {
    console.log('No S2_API_KEY set — using public rate limit (~100 req/5min).')
    console.log('Get a free key at https://www.semanticscholar.org/product/api#api-key for 10× speed.\n')
  }

  const papersById = new Map()

  // ── Phase 1: seed papers from search ────────────────────────────────────────
  const papersPerQuery = Math.ceil(targetPageCount / searchQueries.length)
  console.log(`Phase 1: searching ${searchQueries.length} fields, ~${papersPerQuery} papers each...`)

  for (const query of searchQueries) {
    process.stdout.write(`  "${query}" ... `)
    const results = await searchPapers(query, Math.min(papersPerQuery, 100))

    let added = 0
    for (const paper of results) {
      if (paper.paperId && paper.title && paper.abstract && !papersById.has(paper.paperId)) {
        papersById.set(paper.paperId, paper)
        added++
      }
    }

    process.stdout.write(`${added} added (total: ${papersById.size})\n`)
    await sleep(requestDelayMs)
  }

  console.log(`\nPhase 1 complete: ${papersById.size} unique seed papers.`)

  // ── Phase 2: expand via references ──────────────────────────────────────────
  // Collect all reference IDs mentioned by seed papers, then batch-fetch
  // the ones not already in the corpus to increase graph density.
  if (papersById.size < targetPageCount) {
    console.log(`\nPhase 2: expanding via references to reach ${targetPageCount}...`)

    const referencedIds = new Set()
    for (const paper of papersById.values()) {
      for (const ref of paper.references ?? []) {
        if (ref.paperId && !papersById.has(ref.paperId)) {
          referencedIds.add(ref.paperId)
        }
      }
    }

    const needed = targetPageCount - papersById.size
    const candidateIds = [...referencedIds].slice(0, needed * 3) // fetch 3× and filter
    console.log(`  Batch-fetching ${candidateIds.length} referenced papers...`)

    const batchSize = 400
    for (let i = 0; i < candidateIds.length && papersById.size < targetPageCount; i += batchSize) {
      const batch = candidateIds.slice(i, i + batchSize)
      const fetched = await batchFetchPapers(batch)

      let added = 0
      for (const paper of fetched) {
        if (
          paper.paperId &&
          paper.title &&
          paper.abstract &&
          paper.abstract.length > 80 &&
          !papersById.has(paper.paperId) &&
          papersById.size < targetPageCount
        ) {
          papersById.set(paper.paperId, paper)
          added++
        }
      }

      process.stdout.write(`  batch ${Math.floor(i / batchSize) + 1}: +${added} (total: ${papersById.size})\n`)
      await sleep(requestDelayMs)
    }
  }

  // ── Phase 3: build corpus ────────────────────────────────────────────────────
  console.log(`\nPhase 3: building corpus from ${papersById.size} papers...`)

  const corpusIds = new Set(papersById.keys())
  const citationCounts = [...papersById.values()].map((p) => p.citationCount ?? 0)
  const maxCitations = Math.max(...citationCounts, 1)

  const pages = [...papersById.values()]
    .map((paper) => {
      const arxivId = paper.externalIds?.ArXiv
      const url = arxivId
        ? `https://arxiv.org/abs/${arxivId}`
        : `https://www.semanticscholar.org/paper/${paper.paperId}`

      const outgoingIds = (paper.references ?? [])
        .map((ref) => ref.paperId)
        .filter((id) => id && id !== paper.paperId && corpusIds.has(id))
        .filter((id, index, arr) => arr.indexOf(id) === index)
        .slice(0, 140)

      const summary = (paper.abstract ?? '').replace(/\s+/g, ' ').trim()

      return {
        id: paper.paperId,
        title: (paper.title ?? '').trim(),
        url,
        summary: summary.length > 680 ? summary.slice(0, 677) + '...' : summary,
        outgoingIds,
        terms: tokenize(`${paper.title} ${paper.abstract ?? ''}`).slice(0, 90),
        pageRank: 0,
        year: paper.year ?? null,
        citationCount: paper.citationCount ?? 0,
      }
    })
    .filter((page) => page.summary.length >= 80 && page.title.length > 0)
    .slice(0, targetPageCount)

  // Stats
  const withLinks = pages.filter((p) => p.outgoingIds.length > 0).length
  const totalEdges = pages.reduce((s, p) => s + p.outgoingIds.length, 0)
  console.log(`  ${pages.length} pages, ${totalEdges} citation edges, ${withLinks} pages with ≥1 in-corpus citation`)

  // ── Phase 4: PageRank ────────────────────────────────────────────────────────
  console.log(`\nPhase 4: computing PageRank over ${pages.length} papers...`)
  const pageRank = runPageRankWithCheckpoints(pages, damping, maxIterations, tolerance)

  for (const page of pages) {
    page.pageRank = roundScore(pageRank.finalScores[page.id] ?? 0)
  }

  // ── Write output ─────────────────────────────────────────────────────────────
  const corpus = {
    capturedAt: new Date().toISOString(),
    source,
    generatorVersion,
    settings: {
      targetPageCount,
      actualPageCount: pages.length,
      damping,
      maxIterations,
      tolerance,
      checkpointIterations: pageRank.checkpoints.map((c) => c.iteration),
      searchQueries,
    },
    pages,
    pageRankCheckpoints: pageRank.checkpoints.map((checkpoint) => ({
      iteration: checkpoint.iteration,
      scoresById: Object.fromEntries(
        Object.entries(checkpoint.scoresById).map(([id, score]) => [id, roundScore(score)]),
      ),
    })),
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(corpus)}\n`)
  console.log(`\nWrote ${pages.length} papers to ${outputPath}`)
}

// ── Semantic Scholar API helpers ───────────────────────────────────────────────

async function searchPapers(query, limit = 100) {
  const url = `${S2_SEARCH}?query=${encodeURIComponent(query)}&fields=${S2_FIELDS}&limit=${Math.min(limit, 100)}`
  const data = await s2Get(url)
  return data.data ?? []
}

async function batchFetchPapers(paperIds, attempt = 0) {
  if (paperIds.length === 0) return []

  const body = JSON.stringify({ ids: paperIds })
  const url = `${S2_BATCH}?fields=${S2_FIELDS}`

  const { status, result } = await new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    }

    const parsed = new URL(url)
    const req = https.request({ ...options, hostname: parsed.hostname, path: parsed.pathname + parsed.search }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          resolve({ status: res.statusCode, result })
        } catch {
          resolve({ status: res.statusCode, result: [] })
        }
      })
      res.on('error', reject)
    })

    req.on('error', reject)
    req.write(body)
    req.end()
  })

  if (status === 429) {
    if (attempt >= 4) throw new Error('Semantic Scholar rate limit persists after retries.')
    const wait = [65000, 90000, 120000, 180000][attempt]
    console.warn(`\n  Rate limited (batch). Waiting ${Math.round(wait / 1000)}s...`)
    await sleep(wait)
    return batchFetchPapers(paperIds, attempt + 1)
  }

  return Array.isArray(result) ? result : []
}

async function s2Get(url, attempt = 0) {
  const data = await new Promise((resolve, reject) => {
    const options = apiKey ? { headers: { 'x-api-key': apiKey } } : {}
    https.get(url, options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
      res.on('error', reject)
    }).on('error', reject)
  })

  if (data.status === 429) {
    if (attempt >= 4) throw new Error('Semantic Scholar rate limit persists after retries. Get a free key at https://www.semanticscholar.org/product/api#api-key-form')
    const wait = [65000, 90000, 120000, 180000][attempt]
    console.warn(`\n  Rate limited. Waiting ${Math.round(wait / 1000)}s before retry ${attempt + 1}/4...`)
    await sleep(wait)
    return s2Get(url, attempt + 1)
  }

  try {
    return JSON.parse(data.body)
  } catch {
    return {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── PageRank (same logic as wiki generator) ────────────────────────────────────

function runPageRankWithCheckpoints(pages, damping, maxIterations, tolerance) {
  const nodeIds = pages.map((page) => page.id)
  const nodeCount = nodeIds.length
  const outlinksById = Object.fromEntries(pages.map((page) => [page.id, page.outgoingIds]))
  let scoresById = Object.fromEntries(nodeIds.map((id) => [id, 1 / nodeCount]))
  const checkpoints = [{ iteration: 0, scoresById: { ...scoresById } }]

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const nextScores = Object.fromEntries(nodeIds.map((id) => [id, (1 - damping) / nodeCount]))
    let danglingScore = 0

    for (const id of nodeIds) {
      const outlinks = outlinksById[id]

      if (outlinks.length === 0) {
        danglingScore += scoresById[id]
        continue
      }

      const contribution = (damping * scoresById[id]) / outlinks.length

      for (const targetId of outlinks) {
        nextScores[targetId] += contribution
      }
    }

    const danglingContribution = (damping * danglingScore) / nodeCount

    if (danglingContribution > 0) {
      for (const id of nodeIds) {
        nextScores[id] += danglingContribution
      }
    }

    const delta = nodeIds.reduce((sum, id) => sum + Math.abs(nextScores[id] - scoresById[id]), 0)
    scoresById = nextScores

    if (checkpointIterations.has(iteration)) {
      checkpoints.push({ iteration, scoresById: { ...scoresById } })
    }

    if (delta < tolerance) {
      break
    }
  }

  if (checkpoints.at(-1)?.iteration !== maxIterations) {
    checkpoints.push({ iteration: maxIterations, scoresById: { ...scoresById } })
  }

  return { finalScores: scoresById, checkpoints }
}

function roundScore(score) {
  return Number(score.toFixed(10))
}

function tokenize(text) {
  const stopWords = new Set([
    'a', 'about', 'after', 'also', 'an', 'and', 'are', 'as', 'at',
    'be', 'by', 'for', 'from', 'has', 'in', 'into', 'is', 'it', 'its',
    'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'were',
    'which', 'with',
  ])
  const counts = new Map()

  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (term.length < 3 || stopWords.has(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => term)
}
