import { describe, it, expect } from 'vitest';
import { buildDependencyGraph, topologicalSort, type CoreEntry } from '../src/utils/dependency_graph.js';

function makeEntry(name: string, inputs: Record<string, unknown> = {}): CoreEntry {
  return {
    requirement: {
      core_name: name,
      version_constraint: '^1.0.0',
      inputs,
      evidence_required: [],
    },
    resolved: {
      name,
      version: '1.0.0',
      endpoint: `https://core-${name}.example.com`,
      capabilities: [],
      contract_hash: 'abc123',
    },
  };
}

describe('buildDependencyGraph', () => {
  it('creates empty dep sets for independent cores', () => {
    const cores = [makeEntry('A'), makeEntry('B'), makeEntry('C')];
    const graph = buildDependencyGraph(cores);

    expect(graph.get('A')!.size).toBe(0);
    expect(graph.get('B')!.size).toBe(0);
    expect(graph.get('C')!.size).toBe(0);
  });

  it('detects from_core dependencies', () => {
    const cores = [
      makeEntry('A'),
      makeEntry('B', { spec: { from_core: 'A', output_key: 'result' } }),
    ];
    const graph = buildDependencyGraph(cores);

    expect(graph.get('A')!.size).toBe(0);
    expect(graph.get('B')!.has('A')).toBe(true);
  });
});

describe('topologicalSort', () => {
  it('puts independent cores in one batch', () => {
    const cores = [makeEntry('A'), makeEntry('B'), makeEntry('C')];
    const graph = buildDependencyGraph(cores);
    const order = topologicalSort(cores, graph);

    expect(order.hasCycle).toBe(false);
    expect(order.batches).toHaveLength(1);
    expect(order.batches[0]).toHaveLength(3);
  });

  it('sequences dependent cores into multiple batches', () => {
    const cores = [
      makeEntry('A'),
      makeEntry('B', { data: { from_core: 'A', output_key: 'x' } }),
      makeEntry('C', { data: { from_core: 'B', output_key: 'y' } }),
    ];
    const graph = buildDependencyGraph(cores);
    const order = topologicalSort(cores, graph);

    expect(order.hasCycle).toBe(false);
    expect(order.batches).toHaveLength(3);
    expect(order.batches[0].map((e) => e.requirement.core_name)).toEqual(['A']);
    expect(order.batches[1].map((e) => e.requirement.core_name)).toEqual(['B']);
    expect(order.batches[2].map((e) => e.requirement.core_name)).toEqual(['C']);
  });

  it('parallelizes independent cores within a batch', () => {
    // A is root, B and C depend on A, D depends on B and C
    const cores = [
      makeEntry('A'),
      makeEntry('B', { in1: { from_core: 'A', output_key: 'x' } }),
      makeEntry('C', { in1: { from_core: 'A', output_key: 'y' } }),
      makeEntry('D', {
        in1: { from_core: 'B', output_key: 'x' },
        in2: { from_core: 'C', output_key: 'y' },
      }),
    ];
    const graph = buildDependencyGraph(cores);
    const order = topologicalSort(cores, graph);

    expect(order.hasCycle).toBe(false);
    expect(order.batches).toHaveLength(3);
    expect(order.batches[0]).toHaveLength(1); // A
    expect(order.batches[1]).toHaveLength(2); // B, C in parallel
    expect(order.batches[2]).toHaveLength(1); // D
  });

  it('detects cycles', () => {
    const cores = [
      makeEntry('A', { dep: { from_core: 'B', output_key: 'x' } }),
      makeEntry('B', { dep: { from_core: 'A', output_key: 'y' } }),
    ];
    const graph = buildDependencyGraph(cores);
    const order = topologicalSort(cores, graph);

    expect(order.hasCycle).toBe(true);
  });
});
