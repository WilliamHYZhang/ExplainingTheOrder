import { runPageRank, type IncomingContribution, type PageRankEdge, type PageRankResult } from './pagerank'
import type { SearchResult } from './wikiSearch'

export type RankingWeights = {
  textRelevance: number
  linkAuthority: number
  globalPageRank: number
  recency: number
  credibility: number
  damping: number
}

export const defaultRankingWeights: RankingWeights = {
  textRelevance: 0.5,
  linkAuthority: 0.3,
  globalPageRank: 0.1,
  recency: 0.05,
  credibility: 0.05,
  damping: 0.85,
}

export type QueryRankedPage = SearchResult & {
  queryPageRankScore: number
  queryPageRankRank: number
  blendedScore: number
  baselineRank: number
  rankDelta: number
}

export type QueryPageRankGraph = {
  relevantPages: QueryRankedPage[]
  rankedPages: QueryRankedPage[]
  edges: PageRankEdge[]
  pageRankResult: PageRankResult | null
  hasInternalLinks: boolean
  incomingContributionsByNode: Record<string, IncomingContribution[]>
}

const maxIterations = 48
const tolerance = 1e-7

export function buildQueryPageRankGraph(
  scoredPages: SearchResult[],
  weights: RankingWeights = defaultRankingWeights,
): QueryPageRankGraph {
  const relevantPages = scoredPages.filter((page) => page.normalizedTextScore > 0)
  const relevantIdSet = new Set(relevantPages.map((page) => page.id))
  const edges = buildFilteredEdges(relevantPages, relevantIdSet)

  if (relevantPages.length === 0) {
    return {
      relevantPages: [],
      rankedPages: [],
      edges: [],
      pageRankResult: null,
      hasInternalLinks: false,
      incomingContributionsByNode: {},
    }
  }

  const pageRankResult = runPageRank({
    nodes: relevantPages.map((page) => ({ id: page.id })),
    edges,
    damping: weights.damping,
    maxIterations,
    tolerance,
  })
  const rankedPages = rankQueryPages(relevantPages, pageRankResult.scoresByNode, weights)

  return {
    relevantPages: rankedPages,
    rankedPages,
    edges,
    pageRankResult,
    hasInternalLinks: edges.length > 0,
    incomingContributionsByNode: pageRankResult.incomingContributionsByNode,
  }
}

export function buildFilteredEdges(pages: SearchResult[], pageIds: Set<string>) {
  const edges: PageRankEdge[] = []
  const seenEdgeKeys = new Set<string>()

  for (const page of pages) {
    for (const targetId of page.outgoingIds) {
      if (!pageIds.has(targetId)) {
        continue
      }

      const edgeKey = getEdgeKey(page.id, targetId)

      if (seenEdgeKeys.has(edgeKey)) {
        continue
      }

      seenEdgeKeys.add(edgeKey)
      edges.push({ source: page.id, target: targetId })
    }
  }

  return edges
}

export function scaleRadius(value: number, maxValue: number, minRadius: number, maxRadius: number) {
  if (maxValue <= 0 || value <= 0) {
    return minRadius
  }

  return minRadius + Math.sqrt(value / maxValue) * (maxRadius - minRadius)
}

function rankQueryPages(
  pages: SearchResult[],
  scoresByNode: Record<string, number>,
  weights: RankingWeights,
): QueryRankedPage[] {
  const maxPR = Math.max(...pages.map((p) => scoresByNode[p.id] ?? 0), Number.EPSILON)

  const signalSum =
    weights.textRelevance +
    weights.linkAuthority +
    weights.globalPageRank +
    weights.recency +
    weights.credibility
  const s = signalSum > 0 ? signalSum : 1
  const w = {
    text: weights.textRelevance / s,
    pr: weights.linkAuthority / s,
    global: weights.globalPageRank / s,
    recency: weights.recency / s,
    cred: weights.credibility / s,
  }

  const withScores = pages.map((page) => {
    const queryPR = scoresByNode[page.id] ?? 0
    const normalizedPR = maxPR > 0 ? queryPR / maxPR : 0
    const blendedScore =
      w.text * page.normalizedTextScore +
      w.pr * normalizedPR +
      w.global * page.normalizedPageRank +
      w.recency * (page.recencyScore ?? 0) +
      w.cred * (page.credibilityScore ?? 0)

    return { ...page, queryPageRankScore: queryPR, blendedScore }
  })

  const sortedByBlended = [...withScores].sort((a, b) => {
    const diff = b.blendedScore - a.blendedScore
    if (Math.abs(diff) > Number.EPSILON) return diff
    return a.title.localeCompare(b.title)
  })

  const sortedByPR = [...withScores].sort((a, b) => {
    const diff = (scoresByNode[b.id] ?? 0) - (scoresByNode[a.id] ?? 0)
    if (Math.abs(diff) > 1e-10) return diff
    return b.normalizedTextScore - a.normalizedTextScore
  })
  const baselineRankById = Object.fromEntries(sortedByPR.map((p, i) => [p.id, i + 1])) as Record<
    string,
    number
  >

  return sortedByBlended.map((page, index) => {
    const currentRank = index + 1
    const baselineRank = baselineRankById[page.id] ?? currentRank
    return {
      ...page,
      queryPageRankRank: currentRank,
      baselineRank,
      rankDelta: baselineRank - currentRank,
    }
  })
}

function getEdgeKey(source: string, target: string) {
  return `${source}->${target}`
}
