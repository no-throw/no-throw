export { analyzeSourceFile } from "./analyze.js";
export type { Finding, FindingKind } from "./analyze.js";
export { lookupBaselineEntry } from "./baseline/data.js";
export {
  globalKey,
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
