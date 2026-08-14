export { analyzeSourceFile } from "./analyze.js";
export type { EntrySite, Finding } from "./analyze.js";
export { lookupBaselineEntry } from "./baseline/data.js";
export type { BaselineSource } from "./baseline/data.js";
export {
  libTargetOfFileName,
  memberKey,
  symbolMemberName,
} from "./baseline/keys.js";
export { PACKAGE_SOURCE } from "./baseline/rung.js";
export { formatConditionPath, parseConditionPath } from "./baseline/paths.js";
export type { ParsedConditionPath, PathSegment } from "./baseline/paths.js";
export type {
  AccessorColors,
  AccessorFact,
  BaselineEntry,
  Color,
  ConditionPath,
} from "./baseline/types.js";
export { OverridesError } from "./carrier/overrides.js";
export { packageHomeOf } from "./carrier/packages.js";
export type { PackageHome } from "./carrier/packages.js";
export { checkCarriers, reachesNothing } from "./check.js";
export type {
  CarrierProblem,
  CheckedCarrier,
  CheckedEntry,
  CheckOutcome,
  EntryKey,
} from "./check.js";
export type {
  AbsenceReason,
  ConsumptionReason,
  FloorReason,
  FloorSource,
  RejectionReason,
  RejectionSubject,
  Rejects,
  UndischargedReason,
} from "./colors.js";
export { emitManifest, manifestDrift } from "./emit.js";
export type {
  EmitOutcome,
  EmitSite,
  ManifestDocument,
  MarkRefusal,
} from "./emit.js";
export { findMarks } from "./marks.js";
export type { MarkProblem, MarkProblemKind, Marks, Span } from "./marks.js";
export type { HiddenCallee, TransferSite } from "./transfers.js";
