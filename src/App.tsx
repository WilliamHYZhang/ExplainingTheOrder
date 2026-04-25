import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MutableRefObject } from 'react'
import { PageRankGraph, type PlaybackStage } from './PageRankGraph'
import corpusData from './data/wikiCorpus.json'
import type { IncomingContribution, PageRankResult } from './lib/pagerank'
import {
  buildQueryPageRankGraph,
  defaultRankingWeights,
  type QueryRankedPage,
  type RankingWeights,
} from './lib/queryGraph'
import {
  computePageAttributes,
  scoreWikiCorpus,
  type WikiCorpus,
  type WikiCorpusPage,
} from './lib/wikiSearch'
import './App.css'

const corpus = corpusData as WikiCorpus
const defaultQuery = 'abraham lincoln'
const resultLimit = 80

function App() {
  const [queryDraft, setQueryDraft] = useState(defaultQuery)
  const [activeQuery, setActiveQuery] = useState(defaultQuery)
  const [selectedId, setSelectedId] = useState('')
  const [playbackStage, setPlaybackStage] = useState<PlaybackStage>('corpus')
  const [filterProgress, setFilterProgress] = useState(0)
  const [zoomProgress, setZoomProgress] = useState(0)
  const [rankingProgress, setRankingProgress] = useState(0)
  const [finalProgress, setFinalProgress] = useState(0)
  const [weights, setWeights] = useState<RankingWeights>(defaultRankingWeights)

  const timeoutIdsRef = useRef<number[]>([])
  const animationFrameRef = useRef<number | null>(null)

  const pageAttributes = useMemo(() => computePageAttributes(corpus), [])
  const pagesById = useMemo(
    () => Object.fromEntries(corpus.pages.map((page) => [page.id, page])) as Record<string, WikiCorpusPage>,
    [],
  )
  const allScoredPages = useMemo(
    () => scoreWikiCorpus(corpus, activeQuery, pageAttributes),
    [activeQuery, pageAttributes],
  )
  const queryGraph = useMemo(
    () => buildQueryPageRankGraph(allScoredPages, weights),
    [allScoredPages, weights],
  )
  const currentPageRankScores = getCurrentQueryPageRankScores(
    queryGraph.pageRankResult,
    playbackStage,
    rankingProgress,
  )
  const currentIteration = getCurrentIteration(queryGraph.pageRankResult, playbackStage, rankingProgress)
  const resultPages = queryGraph.rankedPages.slice(0, resultLimit)
  const maxQueryPageRank = Math.max(...queryGraph.rankedPages.map((page) => page.queryPageRankScore), 0)
  const selectedPage =
    queryGraph.rankedPages.find((page) => page.id === selectedId) ?? queryGraph.rankedPages[0]
  const incomingContributions = selectedPage
    ? queryGraph.incomingContributionsByNode[selectedPage.id] ?? []
    : []
  const highlightedEdgeKeys = new Set(
    incomingContributions.slice(0, 8).map((contribution) => getEdgeKey(contribution.source, contribution.target)),
  )
  const highlightedNodeIds = new Set<string>([selectedPage?.id ?? ''])

  incomingContributions.slice(0, 8).forEach((contribution) => highlightedNodeIds.add(contribution.source))

  useEffect(() => {
    setSelectedId(queryGraph.rankedPages[0]?.id ?? '')
  }, [queryGraph.rankedPages])

  useEffect(() => {
    return () => {
      clearPlayback(timeoutIdsRef, animationFrameRef)
    }
  }, [])

  const selectedContributionTotal = incomingContributions.reduce(
    (sum, contribution) => sum + contribution.value,
    0,
  )
  const statusText = getStatusText({
    stage: playbackStage,
    query: activeQuery,
    relevantCount: queryGraph.relevantPages.length,
    edgeCount: queryGraph.edges.length,
    iteration: currentIteration,
    hasInternalLinks: queryGraph.hasInternalLinks,
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextQuery = normalizeQuery(queryDraft)
    setQueryDraft(nextQuery)
    setActiveQuery(nextQuery)
    startPlayback()
  }

  const handleExportCsv = () => {
    const headers = [
      'Rank',
      'Title',
      'URL',
      'Blended Score',
      'Text Relevance',
      'Query PageRank',
      'Global PageRank',
      'Recency',
      'Credibility',
      'Baseline Rank (PR only)',
      'Rank Delta',
    ]
    const rows = queryGraph.rankedPages.map((page) => [
      page.queryPageRankRank,
      `"${page.title.replace(/"/g, '""')}"`,
      page.url,
      page.blendedScore.toFixed(6),
      page.normalizedTextScore.toFixed(4),
      page.queryPageRankScore.toFixed(6),
      page.normalizedPageRank.toFixed(6),
      page.recencyScore.toFixed(4),
      page.credibilityScore.toFixed(4),
      page.baselineRank,
      page.rankDelta,
    ])
    const csv = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n')
    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `pagerank-${activeQuery.replace(/\s+/g, '-')}.csv`,
    )
  }

  const handleExportPng = () => {
    const svgEl = document.querySelector<SVGSVGElement>('.rank-graph')
    if (!svgEl) return

    const svgClone = svgEl.cloneNode(true) as SVGSVGElement
    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
    styleEl.textContent = `
      .graph-node circle { fill: #1a73e8; stroke: #fff; stroke-width: 2.5; }
      .graph-node.is-selected circle, .graph-node.is-highlighted circle { stroke-width: 5; }
      .node-rank { fill: #fff; font-size: 12px; font-weight: 800; text-anchor: middle; font-family: Arial, sans-serif; }
      .node-label { fill: #3c4043; font-size: 12px; font-weight: 700; text-anchor: middle; font-family: Arial, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 5px; }
      .graph-edge { fill: none; stroke: #1a73e8; stroke-width: 1.4; stroke-linecap: round; }
      .graph-edge.is-highlighted { stroke-width: 3; }
      .corpus-guide-layer circle { fill: none; stroke: #e8eaed; stroke-width: 1; stroke-dasharray: 4 12; }
      #edge-arrow path { fill: #1a73e8; }
    `
    svgClone.insertBefore(styleEl, svgClone.firstChild)

    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('width', '100%')
    bg.setAttribute('height', '100%')
    bg.setAttribute('fill', '#ffffff')
    svgClone.insertBefore(bg, svgClone.firstChild)

    const serializer = new XMLSerializer()
    const svgStr = serializer.serializeToString(svgClone)
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)

    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = 920 * 2
      canvas.height = 620 * 2
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(2, 2)
      ctx.drawImage(img, 0, 0, 920, 620)
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) return
        downloadBlob(pngBlob, `pagerank-graph-${activeQuery.replace(/\s+/g, '-')}.png`)
      })
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  return (
    <main className="app-shell">
      <section className="hero-section" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow">Simplified PageRank-era search demo</p>
          <h1 id="page-title" className="brand-mark" aria-label="Explaining the Order">
            <span>Explaining</span>
            <span>the</span>
            <span>Order</span>
          </h1>
          <p className="hero-summary">
            Search a frozen 5,000-page Wikipedia corpus. Relevance narrows the universe; local
            PageRank explains authority inside the matching pages.
          </p>
          <form className="search-form" onSubmit={handleSubmit}>
            <label className="search-label" htmlFor="query-input">
              Search query
            </label>
            <div className="search-row">
              <span className="search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                id="query-input"
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
                placeholder="Try: world war, chemistry, computer science"
              />
              <button type="submit">Search</button>
            </div>
          </form>
          <p className="corpus-note">
            Fixed source: {corpus.source}, {corpus.pages.length.toLocaleString()} real article pages,
            captured {formatDate(corpus.capturedAt)}.
          </p>
        </div>
      </section>

      <section className="params-section" aria-label="Ranking parameters">
        <ParametersPanel
          weights={weights}
          onChange={setWeights}
          onExportCsv={handleExportCsv}
          onExportPng={handleExportPng}
        />
      </section>

      <section className="workspace" aria-label="PageRank search demo">
        <aside className="results-panel" aria-label="Ranked results">
          <div className="panel-heading">
            <p>Ranked results</p>
            <span>{queryGraph.relevantPages.length} matches</span>
          </div>
          <div className="results-list">
            {resultPages.length > 0 ? (
              resultPages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  className={`result-row${page.id === selectedPage?.id ? ' is-selected' : ''}`}
                  onClick={() => setSelectedId(page.id)}
                >
                  <span className="result-rank">
                    #{page.queryPageRankRank}
                    {page.rankDelta !== 0 && (
                      <span className={`rank-delta ${page.rankDelta > 0 ? 'is-up' : 'is-down'}`}>
                        {page.rankDelta > 0 ? `↑${page.rankDelta}` : `↓${Math.abs(page.rankDelta)}`}
                      </span>
                    )}
                  </span>
                  <span className="result-body">
                    <span className="result-title">{page.title}</span>
                    <span className="result-url">{page.url}</span>
                    <span className="result-snippet">{page.summary}</span>
                    <span className="result-meta">
                      Relevance {formatPercent(page.normalizedTextScore)} · Query PageRank{' '}
                      {formatScore(page.queryPageRankScore)}
                    </span>
                  </span>
                  <span className="result-score">{formatPercent(page.blendedScore)}</span>
                </button>
              ))
            ) : (
              <p className="empty-state results-empty">
                No pages in the fixed corpus match this query. Try a broader topic.
              </p>
            )}
          </div>
        </aside>

        <section className="graph-panel" aria-label="Computed PageRank graph">
          <div className="graph-header">
            <div>
              <p className="graph-label">Query</p>
              <h2>{activeQuery}</h2>
            </div>
            <div className="status-strip" aria-label="Animation status">
              <span className={playbackStage === 'corpus' ? 'is-active' : ''}>Corpus</span>
              <span className={playbackStage === 'filtering' || playbackStage === 'relevance' ? 'is-active' : ''}>
                Filter
              </span>
              <span className={playbackStage === 'pagerank' ? 'is-active' : ''}>PageRank</span>
              <span className={playbackStage === 'final' ? 'is-active' : ''}>Final</span>
            </div>
          </div>

          <p className="stage-status">{statusText}</p>

          <PageRankGraph
            allPages={allScoredPages}
            relevantPages={queryGraph.relevantPages}
            rankedPages={queryGraph.rankedPages}
            edges={queryGraph.edges}
            currentPageRankScores={currentPageRankScores}
            selectedId={selectedPage?.id ?? ''}
            highlightedEdgeKeys={highlightedEdgeKeys}
            highlightedNodeIds={highlightedNodeIds}
            playbackStage={playbackStage}
            filterProgress={filterProgress}
            zoomProgress={zoomProgress}
            rankingProgress={rankingProgress}
            finalProgress={finalProgress}
            onSelect={setSelectedId}
          />
        </section>

        <aside className="inspector-panel" aria-label="Selected result explanation">
          {selectedPage ? (
            <>
              <div className="panel-heading">
                <p>Why this rank?</p>
                <span>#{selectedPage.queryPageRankRank}</span>
              </div>
              <h3>{selectedPage.title}</h3>
              <p className="inspector-url">{selectedPage.url}</p>
              <p className="inspector-summary">{selectedPage.summary}</p>
              <div className="score-stack">
                <span>Blended {formatPercent(selectedPage.blendedScore)}</span>
                <span>Relevance {formatPercent(selectedPage.normalizedTextScore)}</span>
                <span>Query PR {formatScore(selectedPage.queryPageRankScore)}</span>
                <span>Global PR {formatScore(selectedPage.pageRank)}</span>
                <span>Recency {formatPercent(selectedPage.recencyScore)}</span>
                <span>Credibility {formatPercent(selectedPage.credibilityScore)}</span>
              </div>

              <SignalBreakdown
                page={selectedPage}
                weights={weights}
                maxQueryPageRank={maxQueryPageRank}
              />

              <p className="inspector-explanation">
                Inside the pages that matched this query, this page receives about{' '}
                <strong>{formatScore(selectedContributionTotal)}</strong> PageRank from incoming
                links. Pages contribute more when they have authority and fewer outgoing links in
                the filtered graph.
              </p>
              <div className="contribution-list">
                {incomingContributions.length > 0 ? (
                  incomingContributions.slice(0, 6).map((contribution) => (
                    <ContributionRow
                      key={getEdgeKey(contribution.source, contribution.target)}
                      contribution={contribution}
                      source={pagesById[contribution.source]}
                      maxContribution={incomingContributions[0]?.value ?? 1}
                    />
                  ))
                ) : (
                  <p className="empty-state">
                    This page has no incoming links from the other pages that matched the query.
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="empty-state results-empty">Run a broader query to inspect a matching page.</p>
          )}
        </aside>
      </section>
    </main>
  )

  function startPlayback() {
    clearPlayback(timeoutIdsRef, animationFrameRef)
    setFilterProgress(0)
    setZoomProgress(0)
    setRankingProgress(0)
    setFinalProgress(0)
    setPlaybackStage('filtering')

    animateValue(animationFrameRef, setFilterProgress, 2100, () => {
      setPlaybackStage('relevance')
      animateValue(animationFrameRef, setZoomProgress, 2300, () => {
        setPlaybackStage('pagerank')
        animateValue(animationFrameRef, setRankingProgress, 6200, () => {
          setPlaybackStage('final')
          animateValue(animationFrameRef, setFinalProgress, 1800, () => {
            setFinalProgress(1)
          })
        })
      })
    })
  }
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ParametersPanel({
  weights,
  onChange,
  onExportCsv,
  onExportPng,
}: {
  weights: RankingWeights
  onChange: (weights: RankingWeights) => void
  onExportCsv: () => void
  onExportPng: () => void
}) {
  const isDefault = (Object.keys(defaultRankingWeights) as (keyof RankingWeights)[]).every(
    (k) => Math.abs(weights[k] - defaultRankingWeights[k]) < 0.001,
  )

  const handleChange = (key: keyof RankingWeights, value: number) => {
    onChange({ ...weights, [key]: value })
  }

  return (
    <div className="params-panel">
      <div className="params-header">
        <p className="params-title">Ranking weights</p>
        <div className="params-actions">
          {!isDefault && (
            <button
              type="button"
              className="params-btn params-btn--reset"
              onClick={() => onChange(defaultRankingWeights)}
            >
              Reset
            </button>
          )}
          <button type="button" className="params-btn" onClick={onExportCsv}>
            Export CSV
          </button>
          <button type="button" className="params-btn" onClick={onExportPng}>
            Export PNG
          </button>
        </div>
      </div>
      <div className="params-grid">
        <WeightSlider
          label="Text relevance"
          value={weights.textRelevance}
          color="#1a73e8"
          onChange={(v) => handleChange('textRelevance', v)}
        />
        <WeightSlider
          label="Link authority"
          value={weights.linkAuthority}
          color="#34a853"
          onChange={(v) => handleChange('linkAuthority', v)}
        />
        <WeightSlider
          label="Global PageRank"
          value={weights.globalPageRank}
          color="#fbbc04"
          onChange={(v) => handleChange('globalPageRank', v)}
        />
        <WeightSlider
          label="Recency"
          value={weights.recency}
          color="#ea4335"
          onChange={(v) => handleChange('recency', v)}
        />
        <WeightSlider
          label="Credibility"
          value={weights.credibility}
          color="#9c27b0"
          onChange={(v) => handleChange('credibility', v)}
        />
        <WeightSlider
          label="Damping factor"
          value={weights.damping}
          color="#5f6368"
          min={0.5}
          max={0.99}
          formatValue={(v) => v.toFixed(2)}
          onChange={(v) => handleChange('damping', v)}
        />
      </div>
    </div>
  )
}

function WeightSlider({
  label,
  value,
  color,
  min = 0,
  max = 1,
  step = 0.01,
  formatValue = (v: number) => `${Math.round(v * 100)}%`,
  onChange,
}: {
  label: string
  value: number
  color: string
  min?: number
  max?: number
  step?: number
  formatValue?: (v: number) => string
  onChange: (v: number) => void
}) {
  const fillPct = `${Math.round(((value - min) / (max - min)) * 100)}%`

  return (
    <div className="weight-slider">
      <div className="weight-slider-header">
        <span className="weight-label">{label}</span>
        <span className="weight-value" style={{ color }}>
          {formatValue(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="weight-input"
        style={{ '--fill': fillPct, '--color': color } as React.CSSProperties}
        aria-label={label}
      />
    </div>
  )
}

function SignalBreakdown({
  page,
  weights,
  maxQueryPageRank,
}: {
  page: QueryRankedPage
  weights: RankingWeights
  maxQueryPageRank: number
}) {
  const signalSum =
    weights.textRelevance +
    weights.linkAuthority +
    weights.globalPageRank +
    weights.recency +
    weights.credibility
  const s = signalSum > 0 ? signalSum : 1
  const normalizedPR = maxQueryPageRank > 0 ? page.queryPageRankScore / maxQueryPageRank : 0

  const signals = [
    {
      label: 'Text relevance',
      color: '#1a73e8',
      weight: weights.textRelevance / s,
      value: page.normalizedTextScore,
    },
    {
      label: 'Link authority',
      color: '#34a853',
      weight: weights.linkAuthority / s,
      value: normalizedPR,
    },
    {
      label: 'Global PageRank',
      color: '#fbbc04',
      weight: weights.globalPageRank / s,
      value: page.normalizedPageRank,
    },
    {
      label: page.year ? `Recency (${page.year})` : 'Recency',
      color: '#ea4335',
      weight: weights.recency / s,
      value: page.recencyScore,
    },
    {
      label: page.citationCount != null ? `Credibility (${page.citationCount.toLocaleString()} cites)` : 'Credibility',
      color: '#9c27b0',
      weight: weights.credibility / s,
      value: page.credibilityScore,
    },
  ]

  return (
    <div className="signal-breakdown">
      <p className="signal-breakdown-title">Signal contributions</p>
      {signals.map(({ label, color, weight, value }) => (
        <div key={label} className="signal-row">
          <div className="signal-header">
            <span className="signal-label" style={{ color }}>
              {label}
            </span>
            <span className="signal-value">
              {formatPercent(value)} × {formatPercent(weight)} ={' '}
              {formatScore(weight * value)}
            </span>
          </div>
          <div className="signal-bar" aria-hidden="true">
            <span style={{ width: `${value * 100}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function ContributionRow({
  contribution,
  source,
  maxContribution,
}: {
  contribution: IncomingContribution
  source: WikiCorpusPage
  maxContribution: number
}) {
  const width = `${Math.max(10, (contribution.value / maxContribution) * 100)}%`

  return (
    <div className="contribution-row">
      <div>
        <span>{source.title}</span>
        <strong>{formatScore(contribution.value)}</strong>
      </div>
      <div className="contribution-bar" aria-hidden="true">
        <span style={{ width }} />
      </div>
    </div>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentQueryPageRankScores(
  pageRankResult: PageRankResult | null,
  playbackStage: PlaybackStage,
  rankingProgress: number,
) {
  if (!pageRankResult) {
    return {}
  }

  if (playbackStage === 'final') {
    return pageRankResult.scoresByNode
  }

  const iterations = pageRankResult.iterations
  const index =
    playbackStage === 'pagerank'
      ? Math.min(iterations.length - 1, Math.round(rankingProgress * (iterations.length - 1)))
      : 0

  return iterations[index]?.scoresByNode ?? iterations[0]?.scoresByNode ?? {}
}

function getCurrentIteration(
  pageRankResult: PageRankResult | null,
  playbackStage: PlaybackStage,
  rankingProgress: number,
) {
  if (!pageRankResult || playbackStage !== 'pagerank') {
    return 0
  }

  const iterations = pageRankResult.iterations
  const index = Math.min(iterations.length - 1, Math.round(rankingProgress * (iterations.length - 1)))
  return iterations[index]?.index ?? 0
}

function animateValue(
  animationFrameRef: MutableRefObject<number | null>,
  setter: (value: number) => void,
  duration: number,
  onComplete: () => void,
) {
  const startedAt = performance.now()

  const step = (now: number) => {
    const rawProgress = Math.min(1, (now - startedAt) / duration)
    setter(easeOutCubic(rawProgress))

    if (rawProgress < 1) {
      animationFrameRef.current = window.requestAnimationFrame(step)
      return
    }

    animationFrameRef.current = null
    onComplete()
  }

  animationFrameRef.current = window.requestAnimationFrame(step)
}

function clearPlayback(
  timeoutIdsRef: MutableRefObject<number[]>,
  animationFrameRef: MutableRefObject<number | null>,
) {
  timeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId))
  timeoutIdsRef.current = []

  if (animationFrameRef.current !== null) {
    window.cancelAnimationFrame(animationFrameRef.current)
    animationFrameRef.current = null
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function getStatusText({
  stage,
  query,
  relevantCount,
  edgeCount,
  iteration,
  hasInternalLinks,
}: {
  stage: PlaybackStage
  query: string
  relevantCount: number
  edgeCount: number
  iteration: number
  hasInternalLinks: boolean
}) {
  const n = corpus.pages.length.toLocaleString()

  if (stage === 'corpus') {
    return `All ${n} corpus pages start as equal tiny dots. Search to reveal which pages are relevant.`
  }

  if (stage === 'filtering') {
    return `Filtering ${n} pages for "${query}". Pages with zero relevance disappear.`
  }

  if (stage === 'relevance') {
    return `Zooming to ${relevantCount} relevant pages. Dot size now means text relevance.`
  }

  if (stage === 'pagerank') {
    return hasInternalLinks
      ? `Running query-local PageRank over ${relevantCount} pages and ${edgeCount} links. Iteration ${iteration}.`
      : 'No internal links among these matches; PageRank stays nearly even.'
  }

  return hasInternalLinks
    ? 'Final radial map: strongest query-local PageRank pages are largest and closest to the center.'
    : 'Final relevance map: no internal links were available, so authority stays nearly even.'
}

function getEdgeKey(source: string, target: string) {
  return `${source}->${target}`
}

function normalizeQuery(query: string) {
  const trimmed = query.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : defaultQuery
}

function formatScore(score: number) {
  return score.toFixed(6)
}

function formatPercent(score: number) {
  return `${Math.round(score * 100)}%`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3)
}

export default App
