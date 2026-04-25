import { describe, expect, it } from 'vitest'
import corpusData from '../data/wikiCorpus.json'
import { searchWikiCorpus, validateWikiCorpus } from './wikiSearch'
import type { WikiCorpus } from './wikiSearch'

const corpus = corpusData as WikiCorpus

describe('wiki corpus', () => {
  it('contains a valid fixed Wikipedia snapshot', () => {
    validateWikiCorpus(corpus)
  })

  it('keeps PageRank score mass near 1', () => {
    const totalScore = corpus.pages.reduce((sum, page) => sum + page.pageRank, 0)

    expect(totalScore).toBeCloseTo(1, 5)
  })
})

describe('searchWikiCorpus', () => {
  it('returns deterministic matches for a known query', () => {
    const firstRun = searchWikiCorpus(corpus, 'solar energy', 10).map((page) => page.id)
    const secondRun = searchWikiCorpus(corpus, 'solar energy', 10).map((page) => page.id)

    expect(firstRun).toEqual(secondRun)
    expect(firstRun.length).toBe(10)
  })

  it('falls back to stable PageRank-led results for weak queries', () => {
    const results = searchWikiCorpus(corpus, 'zzzxxy totally absent query', 5)

    expect(results).toHaveLength(5)
    expect(results[0].combinedScore).toBeGreaterThanOrEqual(results[1].combinedScore)
  })

  it('combines text relevance and global PageRank', () => {
    const results = searchWikiCorpus(corpus, 'history', 20)

    expect(results.some((result) => result.textScore > 0)).toBe(true)
    expect(results.some((result) => result.normalizedPageRank > 0)).toBe(true)
    expect(results[0].combinedScore).toBeGreaterThan(0)
  })
})
