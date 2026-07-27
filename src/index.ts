export { ExecutionDispatcher, type DispatcherDeps, type DispatchOptions } from './execution_dispatcher.js';
export { RuvectorClient, type RuvectorClientOptions, type CursorStore, type EventHandler } from './ruvector_client.js';
export { ExecutionListener, type ExecutionListenerOptions } from './execution_listener.js';
export { FileCursorStore } from './utils/cursor_store.js';
export {
  parsePlanApprovedEvent,
  toExecutionIntent,
  planApprovedEventSchema,
  PlanApprovedValidationError,
  type PlanApprovedEvent,
  type PlanApprovedIssue,
} from './types/plan_approved.js';
export { CoreAdapter, type ContractRegistry, type ContractEntry, type ContractVersion, type HttpClient, type HttpResponse, type RetryPolicy } from './core_adapter.js';
export { EvidenceValidator } from './evidence_validator.js';
export { ExecutionTrace, type TraceEvent, type TraceEventType, type TraceStatus, type IdGenerator, type Clock } from './execution_trace.js';
export { buildDependencyGraph, topologicalSort, type CoreEntry, type BatchedExecutionOrder } from './utils/dependency_graph.js';
export { validateIntent, validateResultShape, isWellFormedEvidence, isValidIso8601 } from './utils/validation.js';

export type { ExecutionIntent, CoreRequirement, EvidencePolicy } from './types/intent.js';
export type { ResolvedCore, CoreExecutionResult, AgentRecord, RepoRecord, ArtifactRecord, EvidenceRef } from './types/core.js';
export type { EvidenceSummary, MissingEvidence } from './types/evidence.js';
export type { ExecutionGraph, ExecutionNode, ExecutionEdge, ExecutionStatus, NodeType, NodeStatus, EdgeType } from './types/graph.js';
export type { ExecutionError, ErrorCode, ValidationResult } from './types/errors.js';
export { makeError } from './types/errors.js';

// Pipeline contracts
export type {
  StepDefinition,
  StepOutput,
  PipelineDefinition,
  DecisionPacket,
  ExecutionFailure,
  ExecutionFailureCode,
  ServiceEndpointMap,
  PipelineRunStatus,
} from './types/pipeline.js';
export {
  IntentClassificationInputSchema,
  IntentClassificationOutputSchema,
  DataRetrievalInputSchema,
  DataRetrievalOutputSchema,
  AnalysisInputSchema,
  AnalysisOutputSchema,
  DecisionSynthesisInputSchema,
  DecisionPacketSchema,
} from './types/pipeline.js';

// Core runtime
export { ExecutionContext } from './core/ExecutionContext.js';
export { StepRunner, StepExecutionError } from './core/StepRunner.js';
export { MvpPipelineExecutor, MVP_REFERENCE_PIPELINE } from './core/MvpPipelineExecutor.js';
