import { describe, expect, it } from 'vitest';
import { buildDependencyGraph, detectCycle, topologicalWaves, DependencyCycleError } from '../src/dependencies/dag.js';

function graphOf(edges: Record<string, string[]>) {
  return buildDependencyGraph(Object.entries(edges).map(([id, dependencies]) => ({ id, dependencies })));
}

describe('buildDependencyGraph', () => {
  it('drops dependency ids that are not in the given node set', () => {
    const graph = graphOf({ A: ['B', 'ghost'], B: [] });
    expect(graph.get('A')).toEqual(['B']);
  });
});

describe('detectCycle', () => {
  it('returns null for an acyclic graph', () => {
    const graph = graphOf({ A: [], B: ['A'], C: ['A', 'B'] });
    expect(detectCycle(graph)).toBeNull();
  });

  it('detects a direct two-node cycle', () => {
    const graph = graphOf({ A: ['B'], B: ['A'] });
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(['A', 'B']));
  });

  it('detects a longer transitive cycle', () => {
    const graph = graphOf({ A: ['B'], B: ['C'], C: ['A'] });
    const cycle = detectCycle(graph);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(['A', 'B', 'C']));
  });

  it('a self-dependency is its own cycle', () => {
    const graph = graphOf({ A: ['A'] });
    expect(detectCycle(graph)).toEqual(['A']);
  });

  it('ignores an unrelated disconnected cyclic component is still found', () => {
    const graph = graphOf({ A: [], B: ['C'], C: ['B'] });
    expect(detectCycle(graph)).not.toBeNull();
  });
});

/**
 * Dedicated coverage for dependencies/dag.ts — this module exists specifically because a cycle
 * of tickets depending on each other previously had no explicit detection at all: the Ready gate
 * alone would just have every ticket in the cycle perpetually BLOCKED, forever, with nothing
 * surfacing "this is a cycle, fix your ticket graph" specifically.
 */
describe('topologicalWaves', () => {
  it('a diamond (A,B -> D; C -> E; D,E -> F) batches correctly by level', () => {
    // Matches the shape from the task's own worked example:
    // A ─┐
    // B ─┼→ D ─┐
    // C ─────→ E ─┼→ F
    const graph = graphOf({ A: [], B: [], C: [], D: ['A', 'B'], E: ['C'], F: ['D', 'E'] });
    const waves = topologicalWaves(graph);
    expect(waves).toEqual([['A', 'B', 'C'], ['D', 'E'], ['F']]);
  });

  it('a simple A, B independent; C depends on A+B: C only in the final wave', () => {
    const graph = graphOf({ A: [], B: [], C: ['A', 'B'] });
    const waves = topologicalWaves(graph);
    expect(waves).toEqual([['A', 'B'], ['C']]);
  });

  it('an isolated ticket with no dependents or dependencies is its own wave-0 member', () => {
    const graph = graphOf({ A: [], B: ['A'], ISOLATED: [] });
    const waves = topologicalWaves(graph);
    expect(waves[0]).toContain('ISOLATED');
  });

  it('throws DependencyCycleError instead of silently producing a wrong or partial answer', () => {
    const graph = graphOf({ A: ['B'], B: ['A'] });
    expect(() => topologicalWaves(graph)).toThrow(DependencyCycleError);
  });
});
