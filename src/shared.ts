// Types shared between the plugin main thread (code.ts) and the UI (React).

export type ViolationType = "color" | "typography" | "detached";

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
}

export type ScanScope = "selection" | "page";

/** Messages sent UI -> main thread. */
export type UiToPlugin =
  | { type: "scan"; scope: ScanScope; checks: Record<ViolationType, boolean> }
  | { type: "select-node"; nodeId: string }
  | { type: "resize"; width: number; height: number };

/** Messages sent main thread -> UI. */
export type PluginToUi =
  | { type: "scan-started" }
  | { type: "scan-progress"; scanned: number }
  | { type: "scan-result"; violations: Violation[]; scannedCount: number; scope: ScanScope }
  | { type: "error"; message: string };
