export type WikiCorpusPage = {
  id: string
  title: string
  url: string
  summary: string
  outgoingIds: string[]
  terms: string[]
  pageRank: number
  year?: number | null
  citationCount?: number | null
}

export type WikiCorpusCheckpoint = {
  iteration: number
  scoresById: Record<string, number>
}

export type WikiCorpus = {
  capturedAt: string
  source: string
  generatorVersion: string
  settings: {
    actualPageCount: number
    targetPageCount: number
    damping: number
    maxIterations: number
    tolerance: number
    checkpointIterations: number[]
    seedTitles?: string[]
    dumpFiles?: Record<string, string>
  }
  pages: WikiCorpusPage[]
  pageRankCheckpoints: WikiCorpusCheckpoint[]
}

export type PageAttributes = {
  recencyScore: number
  credibilityScore: number
}

export type SearchResult = WikiCorpusPage & {
  textScore: number
  normalizedTextScore: number
  normalizedPageRank: number
  combinedScore: number
  resultRank: number
  recencyScore: number
  credibilityScore: number
}

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
  'how',
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
  'what',
  'which',
  'with',
])

export function computePageAttributes(corpus: WikiCorpus): Map<string, PageAttributes> {
  // Prefer real year/citationCount fields (arXiv corpus) over derived proxies
  const years = corpus.pages.map((p) => p.year ?? 0).filter((y) => y > 1900)
  const hasRealYears = years.length > corpus.pages.length * 0.5
  const minYear = hasRealYears ? Math.min(...years) : 0
  const maxYear = hasRealYears ? Math.max(...years) : 0

  const counts = corpus.pages.map((p) => p.citationCount ?? 0)
  const hasRealCitations = counts.some((c) => c > 0)
  const maxCitations = hasRealCitations ? Math.max(...counts, 1) : 1

  // Fall back to inlink count (from link graph) when citation counts aren't available
  const inlinkCounts = new Map<string, number>()

  if (!hasRealCitations) {
    for (const page of corpus.pages) {
      for (const targetId of page.outgoingIds) {
        inlinkCounts.set(targetId, (inlinkCounts.get(targetId) ?? 0) + 1)
      }
    }
  }

  const maxInlinks = Math.max(...inlinkCounts.values(), 1)
  const attrs = new Map<string, PageAttributes>()

  for (const page of corpus.pages) {
    const recencyScore = hasRealYears && page.year
      ? maxYear > minYear ? (page.year - minYear) / (maxYear - minYear) : 0.5
      : fnvHash(page.id)

    const credibilityScore = hasRealCitations
      ? (page.citationCount ?? 0) / maxCitations
      : (inlinkCounts.get(page.id) ?? 0) / maxInlinks

    attrs.set(page.id, { recencyScore, credibilityScore })
  }

  return attrs
}

function fnvHash(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

export function searchWikiCorpus(
  corpus: WikiCorpus,
  query: string,
  limit = 80,
  pageAttributes?: Map<string, PageAttributes>,
): SearchResult[] {
  return scoreWikiCorpus(corpus, query, pageAttributes).slice(0, limit)
}

export function scoreWikiCorpus(
  corpus: WikiCorpus,
  query: string,
  pageAttributes?: Map<string, PageAttributes>,
): SearchResult[] {
  const attrs = pageAttributes ?? computePageAttributes(corpus)
  const queryTerms = tokenize(query)
  const maxPageRank = Math.max(...corpus.pages.map((page) => page.pageRank))
  const scoredPages = corpus.pages.map((page) => ({
    page,
    textScore: scorePageText(page, queryTerms),
    normalizedPageRank: maxPageRank === 0 ? 0 : page.pageRank / maxPageRank,
  }))
  const maxTextScore = Math.max(...scoredPages.map((page) => page.textScore))
  const hasTextMatches = maxTextScore > 0

  return scoredPages
    .map(({ page, textScore, normalizedPageRank }) => {
      const normalizedTextScore = hasTextMatches ? textScore / maxTextScore : 0
      const combinedScore = hasTextMatches
        ? normalizedTextScore * 0.78 + normalizedPageRank * 0.22
        : normalizedPageRank
      const { recencyScore = 0, credibilityScore = 0 } = attrs.get(page.id) ?? {}

      return {
        ...page,
        textScore,
        normalizedTextScore,
        normalizedPageRank,
        combinedScore,
        resultRank: 0,
        recencyScore,
        credibilityScore,
      }
    })
    .sort((first, second) => {
      const combinedDifference = second.combinedScore - first.combinedScore

      if (Math.abs(combinedDifference) > Number.EPSILON) {
        return combinedDifference
      }

      const rankDifference = second.pageRank - first.pageRank

      if (Math.abs(rankDifference) > Number.EPSILON) {
        return rankDifference
      }

      return first.title.localeCompare(second.title)
    })
    .map((result, index) => ({
      ...result,
      resultRank: index + 1,
    }))
}

export function buildIncomingIdsByPage(pages: WikiCorpusPage[]) {
  const pageIds = new Set(pages.map((page) => page.id))
  const incomingIdsByPage = Object.fromEntries(pages.map((page) => [page.id, []])) as Record<
    string,
    string[]
  >

  for (const page of pages) {
    for (const targetId of page.outgoingIds) {
      if (pageIds.has(targetId)) {
        incomingIdsByPage[targetId].push(page.id)
      }
    }
  }

  return incomingIdsByPage
}

export function validateWikiCorpus(corpus: WikiCorpus, minimumPageCount = 5000) {
  if (corpus.pages.length < minimumPageCount) {
    throw new Error(`Expected at least ${minimumPageCount} pages, found ${corpus.pages.length}.`)
  }

  const pageIds = new Set<string>()

  for (const page of corpus.pages) {
    if (pageIds.has(page.id)) {
      throw new Error(`Duplicate page id: ${page.id}`)
    }

    if (!page.title.trim() || !page.url.startsWith('https://en.wikipedia.org/wiki/')) {
      throw new Error(`Invalid page metadata for ${page.id}`)
    }

    if (page.summary.trim().length < 80) {
      throw new Error(`Summary is too short for ${page.title}`)
    }

    pageIds.add(page.id)
  }

  for (const page of corpus.pages) {
    const outgoingIds = new Set<string>()

    for (const outgoingId of page.outgoingIds) {
      if (outgoingId === page.id) {
        throw new Error(`Self link found on ${page.title}`)
      }

      if (outgoingIds.has(outgoingId)) {
        throw new Error(`Duplicate outgoing id ${outgoingId} from ${page.title}`)
      }

      if (!pageIds.has(outgoingId)) {
        throw new Error(`Unresolved outgoing id ${outgoingId} from ${page.title}`)
      }

      outgoingIds.add(outgoingId)
    }
  }

  if (corpus.pageRankCheckpoints.length < 2) {
    throw new Error('Corpus must include PageRank replay checkpoints.')
  }
}

function scorePageText(page: WikiCorpusPage, queryTerms: string[]) {
  if (queryTerms.length === 0) {
    return 0
  }

  const titleTokens = new Set(tokenize(page.title))
  const pageTerms = new Set(page.terms)
  const summaryTokens = new Set(tokenize(page.summary))
  let score = 0

  for (const term of queryTerms) {
    if (titleTokens.has(term)) {
      score += 8
    }

    if (pageTerms.has(term)) {
      score += 3
    }

    if (summaryTokens.has(term)) {
      score += 1.5
    }

    if (page.title.toLowerCase().includes(term)) {
      score += 1
    }
  }

  return score / Math.sqrt(Math.max(1, titleTokens.size + pageTerms.size))
}

export function tokenize(text: string) {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((term) => term.length >= 3 && !stopWords.has(term)) ?? []
  )
}
