import { randomUUID } from 'node:crypto';
import type { ExecutionIntent } from './types/intent.js';
import type { CoreExecutionResult, ResolvedCore } from './types/core.js';
import type { EvidenceSummary } from './types/evidence.js';
import type { ExecutionGraph, ExecutionStatus } from './types/graph.js';
import type { ExecutionError } from './types/errors.js';
import { makeError } from './types/errors.js';
import { validateIntent } from './utils/validation.js';
import {
  buildDependencyGraph,
  topologicalSort,
  type CoreEntry,
} from './utils/dependency_graph.js';
import { ExecutionTrace, type IdGenerator, type Clock } from './execution_trace.js';
import { EvidenceValidator } from './evidence_validator.js';
import { CoreAdapter } from './core_adapter.js';

export interface DispatcherDeps {
  readonly coreAdapter: CoreAdapter;
  readonly evidenceValidator: EvidenceValidator;
  readonly idGenerator?: IdGenerator;
  readonly clock?: Clock;
}

export class ExecutionDispatcher {
  private readonly coreAdapter: CoreAdapter;
  private readonly evidenceValidator: EvidenceValidator;
  private readonly idGen: IdGenerator;
  private readonly clock: Clock;

  constructor(deps: DispatcherDeps) {
    this.coreAdapter = deps.coreAdapter;
    this.evidenceValidator = deps.evidenceValidator;
    this.idGen = deps.idGenerator ?? { generate: () => randomUUID() };
    this.clock = deps.clock ?? { now: () => new Date().toISOString() };
  }

  async dispatchExecution(intent: ExecutionIntent): Promise<ExecutionGraph> {
    const startedAt = this.clock.now();

    // Phase 1: Validate intent
    const validation = validateIntent(intent);
    if (!validation.valid) {
      return this.failedGraph(intent, startedAt, validation.errors);
    }

    // Phase 2: Resolve cores
    const resolvedCores: CoreEntry[] = [];
    for (const requirement of intent.cores_required) {
      try {
        const resolved = await this.coreAdapter.resolveCore(
          requirement.core_name,
          requirement.version_constraint,
        );
        if (!resolved) {
          return this.failedGraph(intent, startedAt, [
            makeError('CORE_NOT_FOUND', `Core not found: ${requirement.core_name}`),
          ]);
        }
        resolvedCores.push({ requirement, resolved });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return this.failedGraph(intent, startedAt, [
          makeError('REGISTRY_UNAVAILABLE', message, true),
        ]);
      }
    }

    // Phase 3: Build dependency graph
    const depGraph = buildDependencyGraph(resolvedCores);
    const executionOrder = topologicalSort(resolvedCores, depGraph);

    if (executionOrder.hasCycle) {
      return this.failedGraph(intent, startedAt, [
        makeError('CYCLE_DETECTED', 'Circular dependency detected among Cores'),
      ]);
    }

    // Phase 4: Dispatch in batch order
    const trace = ExecutionTrace.create(intent, this.idGen, this.clock);
    const coreResults = new Map<string, CoreExecutionResult>();
    const failedCores = new Set<string>();

    for (const batch of executionOrder.batches) {
      const batchPromises = batch.map(async (entry) => {
        // Check if any dependency of this core has failed
        const deps = depGraph.get(entry.requirement.core_name) ?? new Set();
        for (const dep of deps) {
          if (failedCores.has(dep)) {
            const skipResult: CoreExecutionResult = {
              core_name: entry.requirement.core_name,
              core_version: entry.resolved.version,
              status: 'failed',
              agents_executed: [],
              repos_touched: [],
              artifacts_generated: [],
              evidence_refs: [],
              duration_ms: 0,
              error: makeError(
                'DEPENDENCY_FAILED',
                `Skipped: dependency ${dep} failed`,
              ),
            };
            return { entry, result: skipResult };
          }
        }

        trace.recordDispatch(entry.resolved);

        const result = await this.coreAdapter.dispatch(
          entry.resolved,
          entry.requirement.inputs,
          intent.timeout_ms,
        );

        trace.recordResult(entry.resolved, result);
        return { entry, result };
      });

      const batchResults = await Promise.all(batchPromises);

      for (const { entry, result } of batchResults) {
        coreResults.set(entry.requirement.core_name, result);
        if (result.status === 'failed' && (!result.error || !result.error.recoverable)) {
          failedCores.add(entry.requirement.core_name);
        }
      }
    }

    // Phase 5: Validate evidence
    const evidenceSummary = this.evidenceValidator.validate(intent, coreResults);
    trace.recordEvidenceValidation(evidenceSummary);

    let executionFailed = false;
    if (intent.evidence_policy.fail_on_missing && !evidenceSummary.all_satisfied) {
      trace.markFailed('Missing required evidence');
      executionFailed = true;
    } else {
      trace.markCompleted();
    }

    // Phase 6: Build execution graph
    const status = this.deriveStatus(executionFailed, failedCores, evidenceSummary);
    const nodes = trace.toNodes();
    const edges = trace.toEdges();
    trace.seal();

    const completedAt = this.clock.now();

    return {
      execution_id: trace.execution_id,
      intent_id: intent.intent_id,
      status,
      started_at: startedAt,
      completed_at: completedAt,
      total_duration_ms: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      nodes,
      edges,
      core_results: [...coreResults.values()],
      evidence_summary: evidenceSummary,
    };
  }

  private deriveStatus(
    executionFailed: boolean,
    failedCores: Set<string>,
    evidenceSummary: EvidenceSummary,
  ): ExecutionStatus {
    if (executionFailed) return 'failed';
    if (failedCores.size > 0 || !evidenceSummary.all_satisfied) return 'partial_failure';
    return 'completed';
  }

  private failedGraph(
    intent: ExecutionIntent,
    startedAt: string,
    errors: readonly ExecutionError[],
  ): ExecutionGraph {
    const completedAt = this.clock.now();
    const executionId = this.idGen.generate();

    return {
      execution_id: executionId,
      intent_id: intent.intent_id,
      status: 'failed',
      started_at: startedAt,
      completed_at: completedAt,
      total_duration_ms: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      nodes: [
        {
          node_id: this.idGen.generate(),
          node_type: 'intent_resolution',
          status: 'failed',
          started_at: startedAt,
          completed_at: completedAt,
        },
        {
          node_id: this.idGen.generate(),
          node_type: 'aggregation',
          status: 'failed',
          started_at: completedAt,
          completed_at: completedAt,
        },
      ],
      edges: [],
      core_results: [],
      evidence_summary: {
        total_required: 0,
        total_provided: 0,
        total_missing: errors.length,
        missing_evidence: errors.map((e) => ({
          core_name: '_system',
          evidence_type: e.code,
          reason: e.message,
        })),
        all_satisfied: false,
      },
    };
  }
}
