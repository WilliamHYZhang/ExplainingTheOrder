import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { scaleRadius, type QueryRankedPage } from './lib/queryGraph'
import type { PageRankEdge } from './lib/pagerank'
import type { SearchResult } from './lib/wikiSearch'

export type PlaybackStage = 'corpus' | 'filtering' | 'relevance' | 'pagerank' | 'final'

type PageRankGraphProps = {
  allPages: SearchResult[]
  relevantPages: QueryRankedPage[]
  rankedPages: QueryRankedPage[]
  edges: PageRankEdge[]
  currentPageRankScores: Record<string, number>
  selectedId: string
  highlightedEdgeKeys: Set<string>
  highlightedNodeIds: Set<string>
  playbackStage: PlaybackStage
  filterProgress: number
  zoomProgress: number
  rankingProgress: number
  finalProgress: number
  onSelect: (id: string) => void
}

type Point = {
  x: number
  y: number
}

type CorpusPoint = Point & {
  id: string
  isRelevant: boolean
}

const width = 920
const height = 620
const centerX = width / 2
const centerY = 220
const graphColor = '#1a73e8'
const corpusRadius = 2.25
const maxDisplayedEdges = 800

export function PageRankGraph({
  allPages,
  relevantPages,
  rankedPages,
  edges,
  currentPageRankScores,
  selectedId,
  highlightedEdgeKeys,
  highlightedNodeIds,
  playbackStage,
  filterProgress,
  zoomProgress,
  rankingProgress,
  finalProgress,
  onSelect,
}: PageRankGraphProps) {
  const [hoveredId, setHoveredId] = useState('')
  const relevantPageById = useMemo(
    () => new Map(relevantPages.map((page) => [page.id, page])),
    [relevantPages],
  )
  const corpusIndexById = useMemo(() => {
    const ordered = [...allPages].sort((first, second) => second.pageRank - first.pageRank)
    return new Map(ordered.map((page, index) => [page.id, index]))
  }, [allPages])
  const corpusPoints = useMemo(() => {
    return allPages.map((page) => {
      const point = getCorpusPosition(corpusIndexById.get(page.id) ?? 0, allPages.length)

      return {
        id: page.id,
        isRelevant: relevantPageById.has(page.id),
        x: point.x,
        y: point.y,
      }
    })
  }, [allPages, corpusIndexById, relevantPageById])
  const relevanceIndexById = useMemo(() => {
    const ordered = [...relevantPages].sort((first, second) => {
      const relevanceDifference = second.normalizedTextScore - first.normalizedTextScore
      return Math.abs(relevanceDifference) > Number.EPSILON
        ? relevanceDifference
        : first.title.localeCompare(second.title)
    })

    return new Map(ordered.map((page, index) => [page.id, index]))
  }, [relevantPages])
  const finalIndexById = useMemo(
    () => new Map(rankedPages.map((page, index) => [page.id, index])),
    [rankedPages],
  )
  const currentRankById = useMemo(
    () =>
      new Map(
        [...relevantPages]
          .sort((first, second) => {
            const scoreDifference =
              (currentPageRankScores[second.id] ?? 0) - (currentPageRankScores[first.id] ?? 0)

            if (Math.abs(scoreDifference) > 1e-10) {
              return scoreDifference
            }

            return second.normalizedTextScore - first.normalizedTextScore
          })
          .map((page, index) => [page.id, index + 1]),
      ),
    [currentPageRankScores, relevantPages],
  )
  const maxCurrentPageRank = Math.max(
    ...relevantPages.map((page) => currentPageRankScores[page.id] ?? page.queryPageRankScore),
    0,
  )
  const positionById = useMemo(() => {
    return new Map(
      relevantPages.map((page) => {
        const corpusPosition = getCorpusPosition(corpusIndexById.get(page.id) ?? 0, allPages.length)
        const relevanceIndex = relevanceIndexById.get(page.id) ?? 0
        const relevancePosition = getRelevancePosition(relevanceIndex, relevantPages.length)
        const finalPosition = getFinalPosition(finalIndexById.get(page.id) ?? 0, rankedPages.length)
        const zoomedPosition =
          playbackStage === 'corpus' || playbackStage === 'filtering'
            ? corpusPosition
            : interpolatePoint(corpusPosition, relevancePosition, easeOutCubic(zoomProgress))
        const position =
          playbackStage === 'final'
            ? interpolatePoint(relevancePosition, finalPosition, easeOutCubic(finalProgress))
            : zoomedPosition

        return [page.id, position]
      }),
    )
  }, [
    allPages,
    corpusIndexById,
    finalIndexById,
    finalProgress,
    playbackStage,
    rankedPages.length,
    relevanceIndexById,
    relevantPages,
    zoomProgress,
  ])
  const displayEdges = useMemo(() => {
    return [...edges]
      .sort((first, second) => {
        const firstHighlight = highlightedEdgeKeys.has(getEdgeKey(first.source, first.target)) ? 0 : 1
        const secondHighlight = highlightedEdgeKeys.has(getEdgeKey(second.source, second.target)) ? 0 : 1

        if (firstHighlight !== secondHighlight) {
          return firstHighlight - secondHighlight
        }

        return (finalIndexById.get(first.target) ?? 9999) - (finalIndexById.get(second.target) ?? 9999)
      })
      .slice(0, maxDisplayedEdges)
  }, [edges, finalIndexById, highlightedEdgeKeys])

  return (
    <div className="rank-graph-stage">
      <CorpusCanvas
        points={corpusPoints}
        playbackStage={playbackStage}
        filterProgress={filterProgress}
      />
      <svg className="rank-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="PageRank staged graph">
        <defs>
          <marker id="edge-arrow" viewBox="0 0 8 8" markerWidth="7" markerHeight="7" refX="6.8" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>

        <g className="corpus-guide-layer" aria-hidden="true">
          <circle cx={centerX} cy={centerY} r="68" />
          <circle cx={centerX} cy={centerY} r="150" />
          <circle cx={centerX} cy={centerY} r="232" />
          <circle cx={centerX} cy={centerY} r="314" />
        </g>

        <g className="edge-layer">
          {displayEdges.map((edge, index) => {
            const source = positionById.get(edge.source)
            const target = positionById.get(edge.target)

            if (!source || !target) {
              return null
            }

            const edgeKey = getEdgeKey(edge.source, edge.target)
            const isHighlighted = highlightedEdgeKeys.has(edgeKey)
            const isDimmed = selectedId && !isHighlighted && !highlightedNodeIds.has(edge.source)
            const edgeProgress =
              playbackStage === 'pagerank'
                ? rankingProgress
                : playbackStage === 'final'
                  ? 1
                  : 0

            return (
              <path
                key={edgeKey}
                className={`graph-edge${isHighlighted ? ' is-highlighted' : ''}${isDimmed ? ' is-dimmed' : ''}`}
                d={buildEdgePath(source, target, index)}
                markerEnd="url(#edge-arrow)"
                style={{
                  color: graphColor,
                  opacity: edgeProgress * (isHighlighted ? 0.82 : 0.18),
                  strokeDashoffset: 1 - edgeProgress,
                }}
              />
            )
          })}
        </g>

        <g className="node-layer">
          {relevantPages.map((page) => {
            const point = positionById.get(page.id) ?? { x: centerX, y: centerY }
            const rank = currentRankById.get(page.id) ?? page.queryPageRankRank
            const radius = getNodeRadius({
              page,
              stage: playbackStage,
              rankingProgress,
              zoomProgress,
              currentPageRankScore: currentPageRankScores[page.id] ?? page.queryPageRankScore,
              maxCurrentPageRank,
            })
            const opacity = getRelevantNodeOpacity(playbackStage, filterProgress)
            const canEmphasizeNode = playbackStage !== 'corpus' && playbackStage !== 'filtering'
            const isSelected = canEmphasizeNode && page.id === selectedId
            const isHighlighted = canEmphasizeNode && highlightedNodeIds.has(page.id)
            const showLabel =
              canEmphasizeNode &&
              (hoveredId === page.id || isSelected || isHighlighted || (rank > 0 && rank <= 8))

            return (
              <g
                key={page.id}
                className={`graph-node is-relevant${isSelected ? ' is-selected' : ''}${isHighlighted ? ' is-highlighted' : ''}`}
                transform={`translate(${point.x}, ${point.y})`}
                role="button"
                tabIndex={0}
                aria-label={`Select ${page.title}`}
                onClick={() => {
                  onSelect(page.id)
                }}
                onMouseEnter={() => setHoveredId(page.id)}
                onMouseLeave={() => setHoveredId('')}
                onFocus={() => setHoveredId(page.id)}
                onBlur={() => setHoveredId('')}
                onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(page.id)
                  }
                }}
                style={{ opacity, pointerEvents: opacity > 0.05 ? 'auto' : 'none' }}
              >
                <circle r={isSelected ? radius + 2.5 : radius} />
                {rank > 0 && radius >= 8 && (rank <= 20 || isSelected || hoveredId === page.id) ? (
                  <text className="node-rank" y={4}>
                    {rank}
                  </text>
                ) : null}
                {showLabel ? (
                  <text className="node-label" y={radius + 16}>
                    {shortenTitle(page.title)}
                  </text>
                ) : null}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

function CorpusCanvas({
  points,
  playbackStage,
  filterProgress,
}: {
  points: CorpusPoint[]
  playbackStage: PlaybackStage
  filterProgress: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const context = canvas.getContext('2d')

    if (!context) {
      return
    }

    const pixelRatio = window.devicePixelRatio || 1
    canvas.width = width * pixelRatio
    canvas.height = height * pixelRatio
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, width, height)

    if (playbackStage !== 'corpus' && playbackStage !== 'filtering') {
      return
    }

    const easedFilterProgress = easeOutCubic(filterProgress)
    context.fillStyle = graphColor

    for (const point of points) {
      const opacity =
        playbackStage === 'corpus'
          ? 0.82
          : point.isRelevant
            ? 0.62 + 0.3 * easedFilterProgress
            : 0.82 * (1 - easedFilterProgress)

      if (opacity <= 0.01) {
        continue
      }

      context.globalAlpha = opacity
      context.beginPath()
      context.arc(point.x, point.y, corpusRadius, 0, Math.PI * 2)
      context.fill()
    }

    context.globalAlpha = 1
  }, [filterProgress, playbackStage, points])

  return <canvas className="rank-corpus-canvas" ref={canvasRef} aria-hidden="true" />
}

function getNodeRadius({
  page,
  stage,
  rankingProgress,
  zoomProgress,
  currentPageRankScore,
  maxCurrentPageRank,
}: {
  page: QueryRankedPage | undefined
  stage: PlaybackStage
  rankingProgress: number
  zoomProgress: number
  currentPageRankScore: number
  maxCurrentPageRank: number
}) {
  if (!page) {
    return corpusRadius
  }

  const relevanceRadius = scaleRadius(page.normalizedTextScore, 1, 4.5, 20)
  const pageRankRadius = scaleRadius(currentPageRankScore, maxCurrentPageRank, 4, 26)

  if (stage === 'corpus' || stage === 'filtering') {
    return corpusRadius
  }

  if (stage === 'relevance') {
    return interpolateNumber(corpusRadius, relevanceRadius, easeOutCubic(zoomProgress))
  }

  if (stage === 'pagerank') {
    return interpolateNumber(relevanceRadius, pageRankRadius, easeOutCubic(rankingProgress))
  }

  return pageRankRadius
}

function getRelevantNodeOpacity(stage: PlaybackStage, filterProgress: number) {
  if (stage === 'corpus' || stage === 'filtering') {
    return 0
  }

  if (stage === 'relevance') {
    return 0.62 + 0.32 * easeOutCubic(filterProgress)
  }

  return 0.94
}

function getCorpusPosition(index: number, total: number): Point {
  const angle = index * Math.PI * (3 - Math.sqrt(5))
  const ring = Math.sqrt((index + 0.5) / Math.max(1, total))
  const radiusX = 360 * ring
  const radiusY = 250 * ring

  return {
    x: centerX + Math.cos(angle) * radiusX,
    y: centerY + Math.sin(angle) * radiusY,
  }
}

function getRelevancePosition(index: number, total: number): Point {
  if (total <= 1) {
    return { x: centerX, y: centerY }
  }

  const angle = index * Math.PI * (3 - Math.sqrt(5))
  const ring = Math.sqrt((index + 0.5) / total)
  const radiusX = Math.min(335, 34 + total * 4.5) * ring
  const radiusY = Math.min(230, 28 + total * 3.5) * ring

  return {
    x: centerX + Math.cos(angle) * radiusX,
    y: centerY + Math.sin(angle) * radiusY,
  }
}

function getFinalPosition(index: number, total: number): Point {
  if (total <= 1 || index === 0) {
    return { x: centerX, y: centerY }
  }

  const angle = index * Math.PI * (3 - Math.sqrt(5)) - Math.PI / 2
  const rankProgress = Math.sqrt(index / Math.max(1, total - 1))
  const radius = 30 + rankProgress * 278

  return {
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius * 0.78,
  }
}

function interpolatePoint(start: Point, end: Point, progress: number): Point {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
  }
}

function interpolateNumber(start: number, end: number, progress: number) {
  return start + (end - start) * progress
}

function buildEdgePath(source: Point, target: Point, index: number) {
  const midpointX = (source.x + target.x) / 2
  const midpointY = (source.y + target.y) / 2
  const dx = target.x - source.x
  const dy = target.y - source.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const bend = index % 2 === 0 ? 18 : -18
  const controlX = midpointX + (-dy / length) * bend
  const controlY = midpointY + (dx / length) * bend

  return `M ${source.x.toFixed(2)} ${source.y.toFixed(2)} Q ${controlX.toFixed(2)} ${controlY.toFixed(2)} ${target.x.toFixed(2)} ${target.y.toFixed(2)}`
}

function shortenTitle(title: string) {
  return title.length > 22 ? `${title.slice(0, 20)}...` : title
}

function getEdgeKey(source: string, target: string) {
  return `${source}->${target}`
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3)
}
