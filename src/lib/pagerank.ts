export type PageRankNode = {
  id: string
}

export type PageRankEdge = {
  source: string
  target: string
}

export type PageRankOptions = {
  nodes: PageRankNode[]
  edges: PageRankEdge[]
  damping?: number
  maxIterations?: number
  tolerance?: number
}

export type PageRankIteration = {
  index: number
  scoresByNode: Record<string, number>
  delta: number
}

export type IncomingContribution = {
  source: string
  target: string
  value: number
}

export type PageRankResult = {
  scoresByNode: Record<string, number>
  rankedNodeIds: string[]
  iterations: PageRankIteration[]
  incomingContributionsByNode: Record<string, IncomingContribution[]>
}

const defaultDamping = 0.85
const defaultMaxIterations = 100
const defaultTolerance = 1e-6

export function runPageRank({
  nodes,
  edges,
  damping = defaultDamping,
  maxIterations = defaultMaxIterations,
  tolerance = defaultTolerance,
}: PageRankOptions): PageRankResult {
  validatePageRankInput(nodes, edges)

  if (damping <= 0 || damping >= 1) {
    throw new Error('PageRank damping must be greater than 0 and less than 1.')
  }

  if (maxIterations < 1) {
    throw new Error('PageRank maxIterations must be at least 1.')
  }

  if (tolerance <= 0) {
    throw new Error('PageRank tolerance must be greater than 0.')
  }

  const nodeIds = nodes.map((node) => node.id)
  const nodeCount = nodeIds.length
  const baseScore = 1 / nodeCount
  const outlinksByNode = buildOutlinks(nodeIds, edges)
  let scoresByNode = Object.fromEntries(nodeIds.map((id) => [id, baseScore])) as Record<
    string,
    number
  >
  const iterations: PageRankIteration[] = [
    {
      index: 0,
      scoresByNode: { ...scoresByNode },
      delta: 0,
    },
  ]

  for (let index = 1; index <= maxIterations; index += 1) {
    const nextScores = Object.fromEntries(
      nodeIds.map((id) => [id, (1 - damping) / nodeCount]),
    ) as Record<string, number>

    let danglingScore = 0

    for (const source of nodeIds) {
      const outlinks = outlinksByNode[source]

      if (outlinks.length === 0) {
        danglingScore += scoresByNode[source]
        continue
      }

      const contribution = (damping * scoresByNode[source]) / outlinks.length

      for (const target of outlinks) {
        nextScores[target] += contribution
      }
    }

    const danglingContribution = (damping * danglingScore) / nodeCount

    if (danglingContribution > 0) {
      for (const id of nodeIds) {
        nextScores[id] += danglingContribution
      }
    }

    const delta = nodeIds.reduce(
      (total, id) => total + Math.abs(nextScores[id] - scoresByNode[id]),
      0,
    )

    scoresByNode = nextScores
    iterations.push({
      index,
      scoresByNode: { ...scoresByNode },
      delta,
    })

    if (delta < tolerance) {
      break
    }
  }

  return {
    scoresByNode,
    rankedNodeIds: rankNodeIds(nodeIds, scoresByNode),
    iterations,
    incomingContributionsByNode: buildIncomingContributions(nodeIds, edges, outlinksByNode, scoresByNode, damping),
  }
}

export function validatePageRankInput(nodes: PageRankNode[], edges: PageRankEdge[]) {
  if (nodes.length === 0) {
    throw new Error('PageRank requires at least one node.')
  }

  const seenNodeIds = new Set<string>()

  for (const node of nodes) {
    if (!node.id.trim()) {
      throw new Error('PageRank node ids cannot be empty.')
    }

    if (seenNodeIds.has(node.id)) {
      throw new Error(`Duplicate PageRank node id: ${node.id}`)
    }

    seenNodeIds.add(node.id)
  }

  for (const edge of edges) {
    if (edge.source === edge.target) {
      throw new Error(`Self links are not supported in this demo: ${edge.source}`)
    }

    if (!seenNodeIds.has(edge.source)) {
      throw new Error(`PageRank edge source is missing from nodes: ${edge.source}`)
    }

    if (!seenNodeIds.has(edge.target)) {
      throw new Error(`PageRank edge target is missing from nodes: ${edge.target}`)
    }
  }
}

function buildOutlinks(nodeIds: string[], edges: PageRankEdge[]) {
  const outlinksByNode = Object.fromEntries(nodeIds.map((id) => [id, []])) as Record<
    string,
    string[]
  >

  for (const edge of edges) {
    outlinksByNode[edge.source].push(edge.target)
  }

  return outlinksByNode
}

function rankNodeIds(nodeIds: string[], scoresByNode: Record<string, number>) {
  const inputOrder = Object.fromEntries(nodeIds.map((id, index) => [id, index])) as Record<
    string,
    number
  >

  return [...nodeIds].sort((first, second) => {
    const scoreDifference = scoresByNode[second] - scoresByNode[first]

    if (Math.abs(scoreDifference) > Number.EPSILON) {
      return scoreDifference
    }

    return inputOrder[first] - inputOrder[second]
  })
}

function buildIncomingContributions(
  nodeIds: string[],
  edges: PageRankEdge[],
  outlinksByNode: Record<string, string[]>,
  scoresByNode: Record<string, number>,
  damping: number,
) {
  const incomingContributionsByNode = Object.fromEntries(nodeIds.map((id) => [id, []])) as Record<
    string,
    IncomingContribution[]
  >

  for (const edge of edges) {
    const sourceOutlinkCount = outlinksByNode[edge.source].length
    const value = sourceOutlinkCount === 0 ? 0 : (damping * scoresByNode[edge.source]) / sourceOutlinkCount
    incomingContributionsByNode[edge.target].push({
      source: edge.source,
      target: edge.target,
      value,
    })
  }

  for (const contributions of Object.values(incomingContributionsByNode)) {
    contributions.sort((first, second) => second.value - first.value)
  }

  return incomingContributionsByNode
}
