import { describe, expect, it } from 'vitest'
import { runPageRank } from './pagerank'

describe('runPageRank', () => {
  it('ranks the end of a simple chain highest', () => {
    const result = runPageRank({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ],
    })

    expect(result.rankedNodeIds[0]).toBe('c')
    expect(result.scoresByNode.c).toBeGreaterThan(result.scoresByNode.b)
    expect(result.scoresByNode.b).toBeGreaterThan(result.scoresByNode.a)
  })

  it('finds a clear central authority', () => {
    const result = runPageRank({
      nodes: [{ id: 'hub' }, { id: 'left' }, { id: 'right' }, { id: 'tail' }],
      edges: [
        { source: 'left', target: 'hub' },
        { source: 'right', target: 'hub' },
        { source: 'tail', target: 'hub' },
        { source: 'hub', target: 'left' },
      ],
    })

    expect(result.rankedNodeIds[0]).toBe('hub')
    expect(result.incomingContributionsByNode.hub).toHaveLength(3)
  })

  it('redistributes dangling node score', () => {
    const result = runPageRank({
      nodes: [{ id: 'source' }, { id: 'authority' }, { id: 'dangling' }],
      edges: [{ source: 'source', target: 'authority' }],
    })
    const totalScore = Object.values(result.scoresByNode).reduce((total, score) => total + score, 0)

    expect(totalScore).toBeCloseTo(1, 6)
    expect(result.scoresByNode.dangling).toBeGreaterThan(0)
    expect(result.rankedNodeIds[0]).toBe('authority')
  })

  it('keeps deterministic ordering for the demo graph', () => {
    const result = runPageRank({
      nodes: [
        { id: 'complete-guide' },
        { id: 'extension-basics' },
        { id: 'research-review' },
        { id: 'safety-checklist' },
        { id: 'tools-roundup' },
        { id: 'forum-thread' },
      ],
      edges: [
        { source: 'extension-basics', target: 'complete-guide' },
        { source: 'research-review', target: 'complete-guide' },
        { source: 'safety-checklist', target: 'complete-guide' },
        { source: 'tools-roundup', target: 'extension-basics' },
        { source: 'forum-thread', target: 'extension-basics' },
        { source: 'forum-thread', target: 'complete-guide' },
      ],
    })

    expect(result.rankedNodeIds.slice(0, 3)).toEqual([
      'complete-guide',
      'extension-basics',
      'research-review',
    ])
  })

  it('rejects invalid graph data', () => {
    expect(() =>
      runPageRank({
        nodes: [{ id: 'a' }, { id: 'a' }],
        edges: [],
      }),
    ).toThrow(/Duplicate/)

    expect(() =>
      runPageRank({
        nodes: [{ id: 'a' }],
        edges: [{ source: 'a', target: 'missing' }],
      }),
    ).toThrow(/target/)

    expect(() =>
      runPageRank({
        nodes: [{ id: 'a' }],
        edges: [{ source: 'a', target: 'a' }],
      }),
    ).toThrow(/Self links/)
  })
})
