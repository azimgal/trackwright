/**
 * Dependency graph support for Trackwright's `dependencies` field (docs/architecture.md). The
 * Ready gate (workflow/engine.ts, executeReadyGate) already enforced simple readiness (every
 * dependency's status is "done") before this module existed; what did not exist at all was cycle
 * detection or a way to compute dependency-respecting execution batches ("waves") across more
 * than one ticket at a time — a cycle of tickets depending on each other would just perpetually
 * self-loop at Ready forever, with nothing ever flagging it as a cycle specifically.
 */
export class DependencyCycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`dependency cycle detected: ${cycle.join(' -> ')} -> ${cycle[0]}`);
    this.name = 'DependencyCycleError';
  }
}

/**
 * ticketId -> the ids it depends on, restricted to ids actually present in `tickets` (a
 * dependency on a ticket that doesn't exist, or doesn't exist *yet*, is a Ready-gate concern —
 * "unmet" — not a graph-shape concern; it can never participate in a cycle with something that
 * isn't there).
 */
export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

/** Minimal shape buildDependencyGraph needs — deliberately not the full Ticket type, so callers
 * (e.g. ticket-create.ts, checking a would-be graph before a new ticket is even saved) don't need
 * to construct a complete, valid Ticket just to ask "would this create a cycle." */
export interface DependencyGraphNode {
  id: string;
  dependencies: readonly string[];
}

export function buildDependencyGraph(nodes: readonly DependencyGraphNode[]): DependencyGraph {
  const known = new Set(nodes.map((n) => n.id));
  const graph = new Map<string, readonly string[]>();
  for (const n of nodes) {
    graph.set(n.id, n.dependencies.filter((d) => known.has(d)));
  }
  return graph;
}

/**
 * Three-colour DFS cycle detection. Returns the first cycle found, as an ordered list of ticket
 * ids (the caller is expected to render it as `a -> b -> c -> a`), or `null` if the graph is
 * acyclic. Deterministic: iterates `graph`'s own key order, which is itself ticket-id order via
 * buildDependencyGraph (Map preserves insertion order, and TicketStore.list() already sorts).
 */
export function detectCycle(graph: DependencyGraph): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  for (const id of graph.keys()) color.set(id, WHITE);

  function walkBack(from: string, to: string): string[] {
    const path = [to];
    let cur = from;
    while (cur !== to) {
      path.push(cur);
      cur = parent.get(cur)!;
    }
    return path.reverse();
  }

  function visit(id: string): string[] | null {
    color.set(id, GRAY);
    for (const dep of graph.get(id) ?? []) {
      const depColor = color.get(dep);
      if (depColor === GRAY) return walkBack(id, dep);
      if (depColor === WHITE) {
        parent.set(dep, id);
        const found = visit(dep);
        if (found) return found;
      }
    }
    color.set(id, BLACK);
    return null;
  }

  for (const id of graph.keys()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Kahn's algorithm, batched by level: wave 0 is every ticket with no (in-graph) dependencies,
 * wave N is every remaining ticket whose dependencies are all in waves < N. Each wave's own ids
 * are sorted for a deterministic, reproducible order. Throws DependencyCycleError up front —
 * waves are only a meaningful concept for a DAG; a cyclic graph has no valid topological order at
 * all, and silently producing a wrong answer would be worse than refusing outright.
 */
export function topologicalWaves(graph: DependencyGraph): string[][] {
  const cycle = detectCycle(graph);
  if (cycle) throw new DependencyCycleError(cycle);

  const remaining = new Map(graph);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.entries()]
      .filter(([, deps]) => deps.every((d) => !remaining.has(d)))
      .map(([id]) => id)
      .sort();
    /* istanbul ignore next -- unreachable once detectCycle has already ruled out a cycle */
    if (wave.length === 0) throw new Error('topologicalWaves: no progress possible despite an acyclic graph');
    for (const id of wave) remaining.delete(id);
    waves.push(wave);
  }
  return waves;
}
