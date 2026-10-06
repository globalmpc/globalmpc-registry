export {
  SOURCE_RESULT_DISPLAY,
  GRADE_DISPLAY,
  READINESS_DISPLAY,
  assertDisplayCoverage,
  type DesignToken,
  type StatusDisplay,
  type NotMeaning,
} from "./status-display.js";

export {
  PROHIBITED_PHRASES,
  REQUIRED_BOUNDARY_COPY,
  lintProhibitedLanguage,
  type ProhibitedPhrase,
  type LintFinding,
} from "./prohibited-language.js";

export {
  project,
  sharedFactsConsistent,
  type RecordDepth,
  type RecordView,
  type SharedRecordFacts,
  type ExplanationLayer,
  type ExpertLayer,
} from "./record-depth.js";
