import type { CoreExecutionResult } from './core.js';
import type { EvidenceSummary } from './evidence.js';

export type ExecutionStatus = 'completed' | 'partial_failure' | 'failed';
export type NodeType = 'core_dispatch' | 'evidence_validation' | 'intent_resolution' | 'aggregation';
export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed';
export type EdgeType = 'depends_on' | 'produces' | 'validates' | 'triggers';

export interface ExecutionGraph {
  readonly execution_id: string;
  readonly intent_id: string;
  readonly status: ExecutionStatus;
  readonly started_at: string;
  readonly completed_at: string;
  readonly total_duration_ms: number;
  readonly nodes: readonly ExecutionNode[];
  readonly edges: readonly ExecutionEdge[];
  readonly core_results: readonly CoreExecutionResult[];
  readonly evidence_summary: EvidenceSummary;
}

export interface ExecutionNode {
  readonly node_id: string;
  readonly node_type: NodeType;
  readonly core_name?: string;
  readonly status: NodeStatus;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly duration_ms?: number;
}

export interface ExecutionEdge {
  readonly from_node: string;
  readonly to_node: string;
  readonly edge_type: EdgeType;
}
