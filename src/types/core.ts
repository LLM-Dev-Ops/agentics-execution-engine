import type { ExecutionError } from './errors.js';

export interface ResolvedCore {
  readonly name: string;
  readonly version: string;
  readonly endpoint: string;
  readonly capabilities: readonly string[];
  readonly contract_hash: string;
}

export interface CoreExecutionResult {
  readonly core_name: string;
  readonly core_version: string;
  readonly status: 'success' | 'partial' | 'failed';
  readonly agents_executed: readonly AgentRecord[];
  readonly repos_touched: readonly RepoRecord[];
  readonly artifacts_generated: readonly ArtifactRecord[];
  readonly evidence_refs: readonly EvidenceRef[];
  readonly duration_ms: number;
  readonly error?: ExecutionError;
}

export interface AgentRecord {
  readonly agent_id: string;
  readonly agent_type: string;
  readonly task_description: string;
  readonly status: 'completed' | 'failed' | 'skipped';
  readonly duration_ms: number;
}

export interface RepoRecord {
  readonly repo_uri: string;
  readonly branch: string;
  readonly commits: readonly string[];
  readonly files_changed: readonly string[];
}

export interface ArtifactRecord {
  readonly artifact_id: string;
  readonly artifact_type: string;
  readonly uri: string;
  readonly checksum: string;
  readonly size_bytes: number;
}

export interface EvidenceRef {
  readonly evidence_type: string;
  readonly evidence_id: string;
  readonly uri: string;
  readonly produced_by: string;
  readonly timestamp: string;
  readonly verifiable: boolean;
}
