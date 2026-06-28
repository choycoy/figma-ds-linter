/// <reference types="@figma/plugin-typings" />
import type {
  PluginToUi,
  UiToPlugin,
  Violation,
  ViolationType,
  ScanScope,
} from "./shared";

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 560;

figma.showUI(__html__, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, themeColors: true });

function post(msg: PluginToUi) {
  figma.ui.postMessage(msg);
}

figma.ui.onmessage = async (msg: UiToPlugin) => {
  try {
    if (msg.type === "scan") {
      await runScan(msg.scope, msg.checks);
    } else if (msg.type === "select-node") {
      await selectNode(msg.nodeId);
    } else if (msg.type === "resize") {
      figma.ui.resize(Math.max(320, msg.width), Math.max(400, msg.height));
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

async function selectNode(nodeId: string) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (node && "type" in node && node.type !== "PAGE" && node.type !== "DOCUMENT") {
    const sceneNode = node as SceneNode;
    figma.currentPage.selection = [sceneNode];
    figma.viewport.scrollAndZoomIntoView([sceneNode]);
  }
}

async function runScan(scope: ScanScope, checks: Record<ViolationType, boolean>) {
  post({ type: "scan-started" });

  const roots: readonly SceneNode[] =
    scope === "selection" && figma.currentPage.selection.length > 0
      ? figma.currentPage.selection
      : figma.currentPage.children;

  // Collect every descendant (plus the roots themselves).
  const nodes: SceneNode[] = [];
  for (const root of roots) {
    nodes.push(root);
    if ("findAll" in root) {
      nodes.push(...(root as ChildrenMixin & SceneNode).findAll(() => true));
    }
  }

  const violations: Violation[] = [];
  let scanned = 0;

  for (const node of nodes) {
    if (checks.color) violations.push(...checkColor(node));
    if (checks.typography && node.type === "TEXT") violations.push(...checkTypography(node));
    if (checks.detached && node.type === "INSTANCE") {
      violations.push(...(await checkDetached(node)));
    }

    scanned++;
    // Yield periodically so the UI thread stays responsive on big pages.
    if (scanned % 500 === 0) {
      post({ type: "scan-progress", scanned });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  post({ type: "scan-result", violations, scannedCount: nodes.length, scope });
}

/** A solid paint is compliant only if it is bound to a variable or comes from a paint style. */
function paintIsTokenized(paint: Paint): boolean {
  if (paint.type !== "SOLID") return true; // gradients/images are out of scope here
  const bound = (paint as SolidPaint).boundVariables;
  return Boolean(bound && bound.color);
}

function rgbToHex(c: RGB): string {
  const to = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`.toUpperCase();
}

function checkColor(node: SceneNode): Violation[] {
  const out: Violation[] = [];

  // Fills
  if ("fills" in node) {
    const fills = node.fills;
    const styleId = "fillStyleId" in node ? node.fillStyleId : "";
    const hasStyle = typeof styleId === "string" && styleId !== "";
    if (fills !== figma.mixed && Array.isArray(fills) && !hasStyle) {
      for (const paint of fills) {
        if (paint.type === "SOLID" && paint.visible !== false && !paintIsTokenized(paint)) {
          out.push({
            nodeId: node.id,
            nodeName: node.name,
            nodeType: node.type,
            type: "color",
            message: "Fill 색상이 변수/스타일에 연결되어 있지 않습니다.",
            detail: rgbToHex((paint as SolidPaint).color),
          });
          break; // one violation per node fill is enough
        }
      }
    }
  }

  // Strokes
  if ("strokes" in node) {
    const strokes = node.strokes;
    const styleId = "strokeStyleId" in node ? node.strokeStyleId : "";
    const hasStyle = typeof styleId === "string" && styleId !== "";
    if (Array.isArray(strokes) && strokes.length > 0 && !hasStyle) {
      for (const paint of strokes) {
        if (paint.type === "SOLID" && paint.visible !== false && !paintIsTokenized(paint)) {
          out.push({
            nodeId: node.id,
            nodeName: node.name,
            nodeType: node.type,
            type: "color",
            message: "Stroke 색상이 변수/스타일에 연결되어 있지 않습니다.",
            detail: rgbToHex((paint as SolidPaint).color),
          });
          break;
        }
      }
    }
  }

  return out;
}

function checkTypography(node: TextNode): Violation[] {
  const styleId = node.textStyleId;

  // Mixed style -> the text uses more than one (or partial) text style.
  if (styleId === figma.mixed) {
    return [
      {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        type: "typography",
        message: "텍스트에 혼합된(부분 적용) text style이 사용되었습니다.",
      },
    ];
  }

  if (styleId === "") {
    const font = node.fontName;
    const size = node.fontSize;
    const detail =
      font !== figma.mixed && size !== figma.mixed
        ? `${(font as FontName).family} ${(font as FontName).style} · ${size as number}px`
        : "mixed";
    return [
      {
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        type: "typography",
        message: "텍스트가 text style에 연결되어 있지 않습니다.",
        detail,
      },
    ];
  }

  return [];
}

/**
 * Figma has no API to know a node was *detached* after the fact. As a pragmatic
 * proxy for "drifted from the design system" we flag instances that override
 * their main component's visual properties (fills, strokes, text, characters).
 */
async function checkDetached(node: InstanceNode): Promise<Violation[]> {
  const overrides = node.overrides || [];
  if (overrides.length === 0) return [];

  const visualFields = new Set([
    "fills",
    "strokes",
    "characters",
    "fontName",
    "fontSize",
    "textStyleId",
    "fillStyleId",
    "strokeStyleId",
  ]);

  const overriddenVisual = overrides.some((o) =>
    (o.overriddenFields || []).some((f) => visualFields.has(f as string))
  );

  if (!overriddenVisual) return [];

  let mainName = "(unknown)";
  try {
    const main = await node.getMainComponentAsync();
    if (main) mainName = main.name;
  } catch {
    /* ignore */
  }

  return [
    {
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      type: "detached",
      message: "컴포넌트 인스턴스가 디자인 시스템 값에서 override(분리)되었습니다.",
      detail: `main: ${mainName}`,
    },
  ];
}
