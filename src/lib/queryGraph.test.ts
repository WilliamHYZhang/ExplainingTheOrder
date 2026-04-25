import { describe, expect, it } from 'vitest'
import { buildQueryPageRankGraph, scaleRadius } from './queryGraph'
import type { SearchResult } from './wikiSearch'

describe('buildQueryPageRankGraph', () => {
  it('keeps only relevant pages and edges between relevant pages', () => {
    const graph = buildQueryPageRankGraph([
      makePage('a', 1, ['b', 'c']),
      makePage('b', 0.6, ['a']),
      makePage('c', 0, ['a']),
    ])

    expect(graph.relevantPages.map((page) => page.id).sort()).toEqual(['a', 'b'])
    expect(graph.edges).toEqual([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ])
    expect(graph.rankedPages).toHaveLength(2)
  })

  it('handles no relevant pages', () => {
    const graph = buildQueryPageRankGraph([makePage('a', 0, [])])

    expect(graph.relevantPages).toEqual([])
    expect(graph.rankedPages).toEqual([])
    expect(graph.pageRankResult).toBeNull()
    expect(graph.hasInternalLinks).toBe(false)
  })

  it('keeps sparse matches visible even without internal links', () => {
    const graph = buildQueryPageRankGraph([makePage('a', 1, []), makePage('b', 0.4, [])])

    expect(graph.relevantPages).toHaveLength(2)
    expect(graph.edges).toEqual([])
    expect(graph.hasInternalLinks).toBe(false)
    expect(graph.rankedPages[0].normalizedTextScore).toBeGreaterThan(graph.rankedPages[1].normalizedTextScore)
  })
})

describe('scaleRadius', () => {
  it('makes higher scores larger', () => {
    expect(scaleRadius(0.9, 1, 2, 20)).toBeGreaterThan(scaleRadius(0.2, 1, 2, 20))
  })

  it('uses the minimum radius for zero scores', () => {
    expect(scaleRadius(0, 1, 2, 20)).toBe(2)
  })
})

function makePage(id: string, normalizedTextScore: number, outgoingIds: string[]): SearchResult {
  return {
    id,
    title: `Page ${id}`,
    url: `https://en.wikipedia.org/wiki/${id}`,
    summary: `Summary for page ${id}`,
    outgoingIds,
    terms: [id],
    pageRank: 0.1,
    textScore: normalizedTextScore,
    normalizedTextScore,
    normalizedPageRank: 0.1,
    combinedScore: normalizedTextScore,
    resultRank: 0,
    recencyScore: 0,
    credibilityScore: 0,
  }
}
