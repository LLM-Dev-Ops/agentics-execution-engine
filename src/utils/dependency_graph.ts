import type { CoreRequirement } from '../types/intent.js';
import type { ResolvedCore } from '../types/core.js';

export interface CoreEntry {
  readonly requirement: CoreRequirement;
  readonly resolved: ResolvedCore;
}

export interface BatchedExecutionOrder {
  readonly batches: readonly (readonly CoreEntry[])[];
  readonly hasCycle: boolean;
}

export function buildDependencyGraph(
  cores: readonly CoreEntry[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const entry of cores) {
    graph.set(entry.requirement.core_name, new Set());
  }

  const coreNames = new Set(cores.map((c) => c.requirement.core_name));

  for (const entry of cores) {
    const inputs = entry.requirement.inputs;
    for (const value of Object.values(inputs)) {
      if (isFromCoreRef(value)) {
        const depName = (value as { from_core: string }).from_core;
        if (coreNames.has(depName)) {
          graph.get(entry.requirement.core_name)!.add(depName);
        }
      }
    }
  }

  return graph;
}

export function topologicalSort(
  cores: readonly CoreEntry[],
  graph: Map<string, Set<string>>,
): BatchedExecutionOrder {
  const inDegree = new Map<string, number>();
  const coreMap = new Map<string, CoreEntry>();

  for (const entry of cores) {
    const name = entry.requirement.core_name;
    coreMap.set(name, entry);
    inDegree.set(name, 0);
  }

  for (const [node, deps] of graph) {
    // In our graph, deps = set of nodes that `node` depends on.
    // So the edge is dep → node, meaning dep must come before node.
    // inDegree of `node` += deps.size
    inDegree.set(node, deps.size);
  }

  const batches: CoreEntry[][] = [];
  const remaining = new Set(inDegree.keys());
  let processed = 0;

  while (remaining.size > 0) {
    const batch: CoreEntry[] = [];

    for (const name of remaining) {
      if (inDegree.get(name) === 0) {
        batch.push(coreMap.get(name)!);
      }
    }

    if (batch.length === 0) {
      return { batches, hasCycle: true };
    }

    for (const entry of batch) {
      const name = entry.requirement.core_name;
      remaining.delete(name);
      processed++;

      // Reduce in-degree of nodes that depend on this one
      for (const [otherName, deps] of graph) {
        if (deps.has(name)) {
          inDegree.set(otherName, inDegree.get(otherName)! - 1);
        }
      }
    }

    batches.push(batch);
  }

  return { batches, hasCycle: processed < cores.length };
}

function isFromCoreRef(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'from_core' in value &&
    typeof (value as Record<string, unknown>).from_core === 'string'
  );
}
