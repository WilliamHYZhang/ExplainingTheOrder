import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const _require = createRequire(import.meta.url)
const https = _require('https')
const http = _require('http')

const outputPath = resolve('src/data/wikiCorpus.json')
const dumpDir = resolve('.cache/wiki-dumps')
const wikiDumpBase = 'https://dumps.wikimedia.org/enwiki/latest/'
const wikiPageBaseUrl = 'https://en.wikipedia.org/wiki/'
const source = 'en.wikipedia.org'
const targetPageCount = Number(process.env.WIKI_CORPUS_SIZE ?? 5000)
const damping = 0.85
const maxIterations = 48
const tolerance = 1e-9
const checkpointIterations = new Set([0, 1, 2, 4, 8, 16, 32])
const generatorVersion = 'enwiki-article-dump-v2'

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main() {
  console.log(`Target: ${targetPageCount} pages`)
  const dumpParts = await discoverDumpParts()
  console.log(`Found ${dumpParts.length} article dump parts on Wikimedia.`)

  let candidatePages = []

  for (const partName of dumpParts) {
    const partPath = resolve(dumpDir, partName)
    await ensureFileExists(partPath, `${wikiDumpBase}${partName}`)

    console.log(`Parsing ${partName}...`)
    const partPages = await parseArticleDump(partPath)
    candidatePages = candidatePages.concat(partPages)
    console.log(`  Total candidates so far: ${candidatePages.length}`)

    if (candidatePages.length >= targetPageCount * 3) {
      break
    }
  }

  console.log(`\nSelecting ${targetPageCount} pages from ${candidatePages.length} candidates...`)
  const extractedPages = selectCorpusPages(candidatePages, targetPageCount)

  if (extractedPages.length < targetPageCount) {
    console.warn(`Warning: only found ${extractedPages.length} usable pages (target was ${targetPageCount}).`)
  }

  const pagesByTitleKey = new Map(extractedPages.map((page) => [normalizeTitleKey(page.title), page]))
  const pages = extractedPages.map((page) => {
    const outgoingIds = [...new Set(page.outgoingTitles)]
      .map((title) => pagesByTitleKey.get(normalizeTitleKey(title))?.id)
      .filter(Boolean)
      .filter((id) => id !== page.id)
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .slice(0, 140)

    return {
      id: page.id,
      title: page.title,
      url: `${wikiPageBaseUrl}${encodeTitle(page.title)}`,
      summary: page.summary,
      outgoingIds,
      terms: tokenize(`${page.title} ${page.summary}`).slice(0, 90),
      pageRank: 0,
    }
  })

  console.log(`Computing full-corpus PageRank over ${pages.length} pages...`)
  const pageRank = runPageRankWithCheckpoints(pages, damping, maxIterations, tolerance)

  for (const page of pages) {
    page.pageRank = roundScore(pageRank.finalScores[page.id] ?? 0)
  }

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
      checkpointIterations: pageRank.checkpoints.map((checkpoint) => checkpoint.iteration),
      dumpFiles: { articles: dumpParts.slice(0, 5).join(', ') },
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
  console.log(`Wrote ${pages.length} Wikipedia pages to ${outputPath}`)
}

async function discoverDumpParts() {
  console.log('Discovering available Wikipedia dump parts...')
  const html = await fetchText(wikiDumpBase)
  const pattern = /href="(enwiki-latest-pages-articles\d+\.xml-p\d+p\d+\.bz2)"/g
  const parts = []
  let match

  while ((match = pattern.exec(html)) !== null) {
    parts.push(match[1])
  }

  if (parts.length === 0) {
    throw new Error('Could not discover dump parts from Wikimedia index. Check your network.')
  }

  return parts.sort((a, b) => {
    const numA = parseInt(a.match(/articles(\d+)/)[1], 10)
    const numB = parseInt(b.match(/articles(\d+)/)[1], 10)
    return numA - numB
  })
}

function selectCorpusPages(candidatePages, limit) {
  const selectedById = new Map()
  const addPage = (page) => {
    if (selectedById.size < limit) {
      selectedById.set(page.id, page)
    }
  }
  const preferredTitleKeys = new Set(
    [
      'Abraham Lincoln',
      'Alabama',
      'Anarchism',
      'Art',
      'Chemistry',
      'Computer science',
      'Earth',
      'Europe',
      'Internet',
      'Mathematics',
      'Music',
      'Physics',
      'Science',
      'United States',
      'World War II',
    ].map(normalizeTitleKey),
  )

  for (const page of candidatePages) {
    if (preferredTitleKeys.has(normalizeTitleKey(page.title))) {
      addPage(page)
    }
  }

  for (const page of candidatePages.slice(0, Math.min(1800, candidatePages.length))) {
    addPage(page)
  }

  const remainingPages = candidatePages.filter((page) => !selectedById.has(page.id))
  const neededCount = limit - selectedById.size

  if (neededCount > 0) {
    for (let index = 0; index < neededCount; index += 1) {
      const sourceIndex = Math.floor((index * remainingPages.length) / neededCount)
      const page = remainingPages[sourceIndex]

      if (page) {
        addPage(page)
      }
    }
  }

  return [...selectedById.values()].slice(0, limit)
}

async function ensureFileExists(filePath, url) {
  try {
    await access(filePath)
    console.log(`  Using cached: ${filePath}`)
    return
  } catch {
    // not cached — download it
  }

  await mkdir(dumpDir, { recursive: true })
  const filename = filePath.split('/').pop()
  console.log(`  Downloading ${filename}...`)
  await downloadFile(url, filePath)
  console.log(`  Download complete.`)
}

async function parseArticleDump(dumpPath) {
  const pages = []
  const decompressed = spawn('bzip2', ['-dc', dumpPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = createInterface({
    input: decompressed.stdout ?? createReadStream(dumpPath),
    crlfDelay: Infinity,
  })
  let pageBuffer = []
  let insidePage = false

  for await (const line of lines) {
    if (line.includes('<page>')) {
      insidePage = true
      pageBuffer = [line]
      continue
    }

    if (!insidePage) {
      continue
    }

    pageBuffer.push(line)

    if (line.includes('</page>')) {
      insidePage = false
      const page = parsePageXml(pageBuffer.join('\n'))

      if (page) {
        pages.push(page)

        if (pages.length % 500 === 0) {
          process.stdout.write(`\r  Parsed: ${pages.length}`)
        }
      }
    }
  }

  process.stdout.write(`\r  Parsed: ${pages.length}\n`)

  if (decompressed.exitCode === null && !decompressed.killed) {
    await new Promise((resolvePromise, rejectPromise) => {
      decompressed.on('exit', (code) => {
        if (code === 0 || code === null) {
          resolvePromise()
          return
        }

        rejectPromise(new Error(`bzip2 exited with code ${code}`))
      })
    })
  }

  return pages
}

function parsePageXml(pageXml) {
  const title = decodeXml(pageXml.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim()
  const namespace = Number(pageXml.match(/<ns>(\d+)<\/ns>/)?.[1] ?? -1)
  const id = pageXml.match(/<id>(\d+)<\/id>/)?.[1] ?? ''

  if (
    namespace !== 0 ||
    !id ||
    pageXml.includes('<redirect ') ||
    !isArticleTitle(title) ||
    /\{\{\s*(disambiguation|disambig|set index article)/i.test(pageXml)
  ) {
    return null
  }

  const rawText = decodeXml(pageXml.match(/<text[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? '')
  const outgoingTitles = extractOutgoingTitles(rawText)
  const summary = extractSummary(rawText)

  if (summary.length < 100 || outgoingTitles.length < 2) {
    return null
  }

  return {
    id,
    title,
    summary,
    outgoingTitles,
  }
}

function extractOutgoingTitles(wikitext) {
  const titles = []
  const linkPattern = /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g
  let match = linkPattern.exec(wikitext)

  while (match) {
    const title = normalizeLinkedTitle(match[1])

    if (isArticleTitle(title)) {
      titles.push(title)
    }

    match = linkPattern.exec(wikitext)
  }

  return titles
}

function extractSummary(wikitext) {
  let text = removeMediaLinks(wikitext)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<ref\b[\s\S]*?<\/ref>/gi, ' ')
    .replace(/<ref\b[^/]*?\/>/gi, ' ')
    .replace(/\{\|[\s\S]*?\|\}/g, ' ')

  for (let pass = 0; pass < 8; pass += 1) {
    const nextText = text.replace(/\{\{[^{}]*\}\}/g, ' ')

    if (nextText === text) {
      break
    }

    text = nextText
  }

  text = text
    .replace(/\[\[Category:[^[\]]*\]\]/gi, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^=+.*?=+$/gm, ' ')
    .replace(/^\s*[|!].*$/gm, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const paragraph =
    text
      .split(/\n{2,}/)
      .map((candidate) => candidate.replace(/\s+/g, ' ').trim())
      .find(
        (candidate) =>
          candidate.length >= 100 &&
          !candidate.startsWith('#') &&
          !/^(thumb|right|left|center|upright)\b/i.test(candidate),
      ) ?? text.replace(/\s+/g, ' ').trim()
  const clipped = paragraph.length > 680 ? paragraph.slice(0, 680) : paragraph
  const sentenceEnd = clipped.lastIndexOf('. ')

  if (sentenceEnd > 220 && clipped.length > 360) {
    return finalizeSummary(clipped.slice(0, sentenceEnd + 1))
  }

  return finalizeSummary(clipped)
}

function removeMediaLinks(wikitext) {
  let output = ''
  let index = 0

  while (index < wikitext.length) {
    const lower = wikitext.slice(index, index + 8).toLowerCase()

    if (!lower.startsWith('[[file:') && !lower.startsWith('[[image')) {
      output += wikitext[index]
      index += 1
      continue
    }

    let depth = 0

    while (index < wikitext.length) {
      if (wikitext.slice(index, index + 2) === '[[') {
        depth += 1
        index += 2
        continue
      }

      if (wikitext.slice(index, index + 2) === ']]') {
        depth -= 1
        index += 2

        if (depth <= 0) {
          break
        }

        continue
      }

      index += 1
    }

    output += ' '
  }

  return output
}

function isArticleTitle(title) {
  return (
    typeof title === 'string' &&
    title.length > 1 &&
    !/^\d{1,4}$/.test(title) &&
    !title.includes(':') &&
    !title.startsWith('List of ') &&
    !title.includes('(disambiguation)') &&
    !title.startsWith('Index of ') &&
    !title.startsWith('Outline of ') &&
    !title.startsWith('Wikipedia')
  )
}

function finalizeSummary(summary) {
  return summary
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&[a-z][a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeLinkedTitle(title) {
  const normalized = title.replaceAll('_', ' ').replace(/\s+/g, ' ').trim()

  if (!normalized) {
    return normalized
  }

  return `${normalized[0].toUpperCase()}${normalized.slice(1)}`
}

function normalizeTitleKey(title) {
  return normalizeLinkedTitle(title).toLowerCase()
}

function encodeTitle(title) {
  return encodeURIComponent(title.replaceAll(' ', '_')).replaceAll('%2F', '/')
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, codePoint) => String.fromCodePoint(Number(codePoint)))
}

function tokenize(text) {
  const stopWords = new Set([
    'a',
    'about',
    'after',
    'also',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'has',
    'in',
    'into',
    'is',
    'it',
    'its',
    'of',
    'on',
    'or',
    'that',
    'the',
    'their',
    'this',
    'to',
    'was',
    'were',
    'which',
    'with',
  ])
  const counts = new Map()

  for (const term of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (term.length < 3 || stopWords.has(term)) {
      continue
    }

    counts.set(term, (counts.get(term) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([term]) => term)
}

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

  return {
    finalScores: scoresById,
    checkpoints,
  }
}

function roundScore(score) {
  return Number(score.toFixed(10))
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    client.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl, redirectCount) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'))
        return
      }

      const client = currentUrl.startsWith('https') ? https : http
      const request = client.get(currentUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          follow(response.headers.location, redirectCount + 1)
          return
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${currentUrl}`))
          return
        }

        const total = parseInt(response.headers['content-length'] ?? '0', 10)
        let downloaded = 0
        let lastPct = -1
        const out = createWriteStream(dest)

        response.on('data', (chunk) => {
          downloaded += chunk.length
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100)
            if (pct !== lastPct && pct % 5 === 0) {
              process.stdout.write(`\r  ${pct}% (${(downloaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`)
              lastPct = pct
            }
          }
        })

        response.pipe(out)
        out.on('finish', () => {
          process.stdout.write('\n')
          out.close(resolve)
        })
        out.on('error', reject)
        response.on('error', reject)
      })

      request.on('error', reject)
    }

    follow(url, 0)
  })
}
