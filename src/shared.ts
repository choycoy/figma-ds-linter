// Types shared between the plugin main thread (code.ts) and the UI (React).

export type ViolationType = "color" | "typography" | "spelling";

/** Which paint list a color violation came from. */
export type PaintField = "fill" | "stroke";

export interface Violation {
  /** Stable node id, used to select/zoom the node in Figma. */
  nodeId: string;
  nodeName: string;
  nodeType: string;
  type: ViolationType;
  /** Human-readable explanation of what is wrong. */
  message: string;
  /** Optional detail, e.g. the raw hex color or font that was used. */
  detail?: string;
  /**
   * Machine-readable context the AI + the apply step need.
   * Present for fixable violations (color / typography).
   */
  fix?: ColorFixContext | TypographyFixContext | SpellingFixContext;
}

export interface ColorFixContext {
  kind: "color";
  field: PaintField;
  /** Raw color the user applied, e.g. "#FFFFFF". */
  hex: string;
}

/** Mirrors Figma's own LineHeight type (value omitted when unit is "AUTO"). */
export interface LineHeightSpec {
  unit: "PIXELS" | "PERCENT" | "AUTO";
  value?: number;
}

/** Mirrors Figma's own LetterSpacing type. */
export interface LetterSpacingSpec {
  unit: "PIXELS" | "PERCENT";
  value: number;
}

export interface TypographyFixContext {
  kind: "typography";
  /** "Inter Regular · 16px" style summary, or "mixed". */
  summary: string;
  /** Font family/style/size, present unless the run is "mixed" (can't create a style for that). */
  family?: string;
  style?: string;
  size?: number;
  /** Present alongside family/style/size — lets a new style/spec card match the raw text exactly. */
  lineHeight?: LineHeightSpec;
  letterSpacing?: LetterSpacingSpec;
}

export interface SpellingFixContext {
  kind: "spelling";
  /** Original text as found on the node. */
  original: string;
  /** Suggested corrected text. */
  corrected: string;
}

/** A text node's raw characters, sent to the UI so it can be spell-checked via the OpenAI call. */
export interface SpellingCandidate {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  text: string;
}

/** A token the file actually defines — given to the AI so it recommends real tokens. */
export interface TokenRef {
  id: string;
  name: string;
  /** Hex for color tokens; empty for aliases/non-solid. */
  hex?: string;
  /** Style summary for text styles. */
  summary?: string;
  /** Font family/style/size for text styles (lets nearest-match compare numerically, not just by string). */
  family?: string;
  style?: string;
  size?: number;
}

export interface TokenCatalog {
  colorVariables: TokenRef[];
  paintStyles: TokenRef[];
  textStyles: TokenRef[];
}

/** One AI recommendation, attached to a violation in the UI by nodeId+type+field. */
export interface Recommendation {
  /** Short rationale shown under the item (Korean). */
  text: string;
  /** Optional one-click fix. Absent => advisory only. */
  action?: FixAction;
}

export type FixAction =
  | { kind: "bind-variable"; field: PaintField; variableId: string; tokenName: string; hex: string }
  | { kind: "create-variable"; field: PaintField; tokenName: string; hex: string }
  | { kind: "apply-paint-style"; field: PaintField; styleId: string; styleName: string }
  | { kind: "apply-text-style"; styleId: string; styleName: string }
  | {
      kind: "create-text-style";
      tokenName: string;
      family: string;
      style: string;
      size: number;
      lineHeight?: LineHeightSpec;
      letterSpacing?: LetterSpacingSpec;
    }
  | { kind: "apply-spelling"; original: string; corrected: string };

export type ScanScope = "selection" | "page";

/** Stable per-violation key (survives re-scans as long as the node isn't deleted) — used both
 *  to line AI recommendations back up in the UI and to persist the user's ignore list. */
export function violationKey(v: Violation): string {
  const field = v.fix && v.fix.kind === "color" ? v.fix.field : "";
  return `${v.nodeId}::${v.type}::${field}`;
}

/** Messages sent UI -> main thread. */
export type UiToPlugin =
  | { type: "scan"; scope: ScanScope; checks: Record<ViolationType, boolean> }
  | { type: "select-node"; nodeId: string }
  | { type: "select-nodes"; nodeIds: string[] }
  | { type: "resize"; width: number; height: number }
  | { type: "apply"; nodeId: string; action: FixAction }
  | { type: "apply-bulk"; nodeIds: string[]; action: FixAction }
  | { type: "set-card-template"; kind: "color" | "typography" }
  | { type: "get-card-template"; kind: "color" | "typography" }
  | { type: "generate-all-cards"; kind: "color" | "typography" }
  | { type: "set-token-source"; kind: "color" | "typography" }
  | { type: "clear-token-source"; kind: "color" | "typography" }
  | { type: "get-token-source"; kind: "color" | "typography" }
  | { type: "get-api-key" }
  | { type: "set-api-key"; key: string }
  | { type: "clear-api-key" }
  | { type: "ignore-violation"; key: string }
  | { type: "clear-ignored" };

/** Messages sent main thread -> UI. */
export type PluginToUi =
  | { type: "scan-started" }
  | { type: "scan-progress"; scanned: number }
  | {
      type: "scan-result";
      violations: Violation[];
      scannedCount: number;
      scope: ScanScope;
      catalog: TokenCatalog;
      /** Raw text of every scanned TEXT node, present only when the spelling check is enabled. */
      spellingCandidates: SpellingCandidate[];
      /** How many would-be violations were filtered out by the user's persisted ignore list. */
      ignoredCount: number;
    }
  | { type: "card-template"; kind: "color" | "typography"; name: string | null }
  | { type: "token-source"; kind: "color" | "typography"; name: string | null }
  | { type: "api-key"; key: string | null }
  | { type: "generate-result"; kind: "color" | "typography"; ok: boolean; message: string }
  | {
      type: "apply-result";
      nodeId: string;
      ok: boolean;
      message: string;
      /** All nodes touched by a bulk color apply (so the UI can mark them done). */
      appliedNodeIds?: string[];
    }
  | { type: "error"; message: string };
