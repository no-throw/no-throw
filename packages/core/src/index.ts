export { analyzeSourceFile } from "./analyze.js";
export type { EntrySite, Finding } from "./analyze.js";
export { lookupBaselineEntry } from "./baseline/data.js";
export {
  libTargetOfFileName,
  memberKey,
  symbolMemberName,
} from "./baseline/keys.js";
export { formatConditionPath, parseConditionPath } from "./baseline/paths.js";
export type { ParsedConditionPath, PathSegment } from "./baseline/paths.js";
export type {
  AccessorColors,
  AccessorFact,
  BaselineEntry,
  Color,
  ConditionPath,
} from "./baseline/types.js";
export type {
  ConsumptionReason,
  FloorReason,
  RejectionReason,
  RejectionSubject,
  Rejects,
  UndischargedReason,
} from "./colors.js";
export { emitManifest, manifestDrift } from "./emit.js";
export type {
  EmitOutcome,
  EmitRefusal,
  EmitSite,
  ManifestDocument,
} from "./emit.js";
export { findMarks } from "./marks.js";
export type { MarkProblem, MarkProblemKind, Marks, Span } from "./marks.js";
export type { HiddenCallee, TransferSite } from "./transfers.js";
export type {
  SignatureRef,
  SymbolRef,
  TypeFacts,
  TypeRef,
} from "./type-facts.js";
export { typeFactsOf } from "./type-facts/typescript.js";
