/// <reference types="@figma/plugin-typings" />
import type {
  PluginToUi,
  UiToPlugin,
  Violation,
  ViolationType,
  ScanScope,
  TokenCatalog,
  TokenRef,
  FixAction,
  PaintField,
  LineHeightSpec,
  LetterSpacingSpec,
  SpellingCandidate,
} from "./shared";
import { violationKey } from "./shared";

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 560;

console.log("[ds-linter] plugin code loaded");

try {
  figma.showUI(__html__, { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, themeColors: true });
  console.log("[ds-linter] showUI ok");
} catch (e) {
  console.error("[ds-linter] showUI failed:", e);
}

function post(msg: PluginToUi) {
  figma.ui.postMessage(msg);
}

figma.ui.onmessage = async (msg: UiToPlugin) => {
  try {
    if (msg.type === "scan") {
      await runScan(msg.scope, msg.checks);
    } else if (msg.type === "select-node") {
      await selectNodes([msg.nodeId]);
    } else if (msg.type === "select-nodes") {
      await selectNodes(msg.nodeIds);
    } else if (msg.type === "clear-highlights") {
      clearHighlights();
      figma.currentPage.selection = [];
    } else if (msg.type === "resize") {
      figma.ui.resize(Math.max(320, msg.width), Math.max(400, msg.height));
    } else if (msg.type === "apply") {
      await applyFix(msg.nodeId, msg.action);
    } else if (msg.type === "apply-bulk") {
      await applyBulkFix(msg.nodeIds, msg.action);
    } else if (msg.type === "set-card-template") {
      const sel = figma.currentPage.selection;
      const label = msg.kind === "typography" ? "텍스트 스타일 카드" : "스와치 카드";
      if (sel.length !== 1) {
        figma.notify(`${label} 1개만 선택한 뒤 눌러주세요.`);
        post({ type: "card-template", kind: msg.kind, name: null });
      } else {
        await figma.clientStorage.setAsync(CARD_TEMPLATE_KEY[msg.kind], sel[0].id);
        figma.notify(`'${sel[0].name}'을(를) 카드 템플릿으로 지정했습니다.`);
        post({ type: "card-template", kind: msg.kind, name: sel[0].name });
      }
    } else if (msg.type === "clear-card-template") {
      await figma.clientStorage.deleteAsync(CARD_TEMPLATE_KEY[msg.kind]);
      figma.notify("카드 템플릿 지정을 해제했습니다.");
      post({ type: "card-template", kind: msg.kind, name: null });
    } else if (msg.type === "get-card-template") {
      const id = await getTemplateId(msg.kind);
      let name: string | null = null;
      if (id) {
        const n = await figma.getNodeByIdAsync(id);
        name = n ? n.name : null;
      }
      post({ type: "card-template", kind: msg.kind, name });
    } else if (msg.type === "generate-all-cards") {
      if (msg.kind === "typography") {
        await generateAllTypeCards();
      } else {
        await generateAllCards();
      }
    } else if (msg.type === "set-token-source") {
      const sel = figma.currentPage.selection;
      if (sel.length !== 1) {
        figma.notify("프레임/섹션 1개만 선택한 뒤 눌러주세요.");
        post({ type: "token-source", kind: msg.kind, name: null });
      } else {
        await figma.clientStorage.setAsync(TOKEN_SOURCE_KEY[msg.kind], sel[0].id);
        figma.notify(`'${sel[0].name}'을(를) 기준으로 지정했습니다.`);
        post({ type: "token-source", kind: msg.kind, name: sel[0].name });
      }
    } else if (msg.type === "clear-token-source") {
      await figma.clientStorage.deleteAsync(TOKEN_SOURCE_KEY[msg.kind]);
      figma.notify("기준을 해제했습니다 (다시 현재 페이지 전체를 훑습니다).");
      post({ type: "token-source", kind: msg.kind, name: null });
    } else if (msg.type === "get-token-source") {
      const id = await getTokenSourceId(msg.kind);
      let name: string | null = null;
      if (id) {
        const n = await figma.getNodeByIdAsync(id);
        name = n ? n.name : null;
      }
      post({ type: "token-source", kind: msg.kind, name });
    } else if (msg.type === "get-api-key") {
      const key = await figma.clientStorage.getAsync(API_KEY_STORAGE_KEY);
      post({ type: "api-key", key: typeof key === "string" && key ? key : null });
    } else if (msg.type === "set-api-key") {
      const key = msg.key.trim();
      if (key) {
        await figma.clientStorage.setAsync(API_KEY_STORAGE_KEY, key);
        figma.notify("API 키를 저장했습니다.");
      }
      post({ type: "api-key", key: key || null });
    } else if (msg.type === "clear-api-key") {
      await figma.clientStorage.deleteAsync(API_KEY_STORAGE_KEY);
      figma.notify("API 키를 삭제했습니다.");
      post({ type: "api-key", key: null });
    } else if (msg.type === "ignore-violation") {
      const keys = await getIgnoredKeys();
      keys.add(msg.key);
      await saveIgnoredKeys(keys);
    } else if (msg.type === "clear-ignored") {
      await saveIgnoredKeys(new Set());
      figma.notify("숨긴 항목을 모두 복원했습니다 — 다시 검사해주세요.");
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

// Remove our overlays when the plugin is closed so nothing is left behind.
figma.on("close", clearHighlights);

/** pluginData flag marking a node as a highlight overlay we created. */
const HIGHLIGHT_KEY = "dsLinterHighlight";

function clearHighlights() {
  const stale = figma.currentPage.findAll((n) => n.getPluginData(HIGHLIGHT_KEY) === "1");
  for (const n of stale) n.remove();
}

/** Draw a non-interactive red border overlay around a node so it stands out on the canvas. */
function drawBorder(node: SceneNode) {
  const box = node.absoluteBoundingBox;
  if (!box) return;
  const rect = figma.createRectangle();
  rect.name = "⛔ DS Linter Highlight";
  rect.setPluginData(HIGHLIGHT_KEY, "1");
  rect.x = box.x;
  rect.y = box.y;
  rect.resize(Math.max(box.width, 1), Math.max(box.height, 1));
  rect.fills = [];
  rect.strokes = [{ type: "SOLID", color: { r: 0.95, g: 0.28, b: 0.13 } }];
  rect.strokeWeight = 3;
  rect.strokeAlign = "OUTSIDE";
  rect.dashPattern = [8, 4];
  rect.cornerRadius = 4;
  rect.locked = true; // not selectable/editable, won't get in the user's way
  figma.currentPage.appendChild(rect);
}

/** Walk up to the PageNode a node lives on. A card template/token-source frame can be on a
 *  different page than the one currently open — figma.currentPage.selection and
 *  viewport.scrollAndZoomIntoView only accept nodes on the active page, so anything that
 *  reveals a cross-page node must switch pages first (see revealApplyResult below). */
function pageOf(node: BaseNode): PageNode | null {
  let p: BaseNode | null = node;
  while (p && p.type !== "PAGE") p = "parent" in p ? p.parent : null;
  return (p as PageNode) ?? null;
}

/** Draw highlights and select/scroll to what an apply just touched. If a newly-created
 *  card lives on another page (template/token-source frame set there), switch to it first —
 *  otherwise figma.currentPage.selection / scrollAndZoomIntoView throw for cross-page nodes. */
async function revealApplyResult(touched: SceneNode[], revealCard: SceneNode | null) {
  const revealPage = revealCard ? pageOf(revealCard) : null;
  if (revealCard && revealPage && revealPage.id !== figma.currentPage.id) {
    await figma.setCurrentPageAsync(revealPage);
    clearHighlights();
    drawBorder(revealCard);
    figma.currentPage.selection = [revealCard];
    figma.viewport.scrollAndZoomIntoView([revealCard]);
    return;
  }
  clearHighlights();
  for (const n of touched.slice(0, 30)) drawBorder(n);
  figma.currentPage.selection = touched;
  if (revealCard) {
    figma.viewport.scrollAndZoomIntoView([revealCard]);
  } else {
    panToNodes(touched);
  }
}

async function selectNodes(nodeIds: string[]) {
  const nodes: SceneNode[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && "type" in node && node.type !== "PAGE" && node.type !== "DOCUMENT") {
      nodes.push(node as SceneNode);
    }
  }
  if (nodes.length === 0) {
    figma.notify("선택할 노드를 찾지 못했습니다 (삭제되었을 수 있어요).");
    return;
  }
  // 스캔 이후 Figma에서 다른 페이지로 이동했을 수 있다 — 노드가 실제로 속한 페이지로 먼저
  // 전환해야 선택/줌이 가능하다(다른 페이지 노드로 currentPage.selection을 채우면 에러).
  const page = pageOf(nodes[0]);
  if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
  const onPage = page ? nodes.filter((n) => pageOf(n)?.id === page.id) : nodes;
  clearHighlights();
  for (const n of onPage) drawBorder(n);
  figma.currentPage.selection = onPage;
  panToNodes(onPage);
  if (onPage.length > 1) figma.notify(`${onPage.length}개 위반 노드를 표시했습니다.`);
}

/**
 * Move the viewport to the node(s) WITHOUT changing zoom — so small nodes don't
 * blow up to fill the screen. We pan to the combined bounding-box center and only
 * raise zoom if the user is so far out the node would be invisible (never zoom in).
 */
function panToNodes(nodes: SceneNode[]) {
  const boxes = nodes
    .map((n) => n.absoluteBoundingBox)
    .filter((b): b is Rect => Boolean(b));
  if (boxes.length === 0) {
    figma.viewport.scrollAndZoomIntoView(nodes);
    return;
  }
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));

  figma.viewport.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

  // 너무 멀리 축소돼 노드가 안 보일 때만 살짝 확대 (이미 가까우면 줌 유지).
  const MIN_VISIBLE_ZOOM = 0.25;
  if (figma.viewport.zoom < MIN_VISIBLE_ZOOM) {
    figma.viewport.zoom = MIN_VISIBLE_ZOOM;
  }
}

async function runScan(scope: ScanScope, checks: Record<ViolationType, boolean>) {
  post({ type: "scan-started" });

  // Remove leftover overlays first so we never scan our own highlights.
  clearHighlights();

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
  // Spelling needs an OpenAI call, which the sandbox can't make — just collect the raw
  // text here and let the UI (which has network access) run the actual check.
  const spellingCandidates: SpellingCandidate[] = [];
  let scanned = 0;

  for (const node of nodes) {
    // Never report our own highlight overlays.
    if (node.getPluginData(HIGHLIGHT_KEY) === "1") {
      scanned++;
      continue;
    }
    if (checks.color) violations.push(...checkColor(node));
    if (checks.typography && node.type === "TEXT") violations.push(...checkTypography(node));
    if (checks.spelling && node.type === "TEXT") {
      const text = node.characters.trim();
      if (text) {
        spellingCandidates.push({ nodeId: node.id, nodeName: node.name, nodeType: node.type, text: node.characters });
      }
    }

    scanned++;
    // Yield periodically so the UI thread stays responsive on big pages.
    if (scanned % 500 === 0) {
      post({ type: "scan-progress", scanned });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const catalog = await buildCatalog();

  const ignored = await getIgnoredKeys();
  const visibleViolations = violations.filter((v) => !ignored.has(violationKey(v)));
  // Spelling candidates aren't Violations yet (the OpenAI check that decides pass/fail
  // hasn't run), so build the same "nodeId::spelling::" shape violationKey() would produce.
  const visibleSpelling = spellingCandidates.filter((c) => !ignored.has(`${c.nodeId}::spelling::`));
  const ignoredCount =
    violations.length - visibleViolations.length + (spellingCandidates.length - visibleSpelling.length);

  post({
    type: "scan-result",
    violations: visibleViolations,
    scannedCount: nodes.length,
    scope,
    catalog,
    spellingCandidates: visibleSpelling,
    ignoredCount,
  });
}

/**
 * Collect the tokens this file actually defines so the AI recommends real
 * tokens instead of hallucinating names. Color variables + paint styles for
 * color fixes, text styles for typography.
 */
async function buildCatalog(): Promise<TokenCatalog> {
  const colorVariables: TokenRef[] = [];
  const paintStyles: TokenRef[] = [];
  const textStyles: TokenRef[] = [];

  try {
    const vars = await figma.variables.getLocalVariablesAsync("COLOR");
    for (const v of vars) {
      let hex: string | undefined;
      try {
        const rgb = await resolveVariableColor(v.id);
        if (rgb) hex = rgbToHex(rgb);
      } catch {
        /* alias chain broken or unresolved — leave hex undefined */
      }
      colorVariables.push({ id: v.id, name: v.name, hex });
    }
  } catch {
    /* variables API unavailable */
  }

  try {
    const styles = await figma.getLocalPaintStylesAsync();
    for (const s of styles) {
      const p = s.paints[0];
      const hex = p && p.type === "SOLID" ? rgbToHex(p.color) : undefined;
      paintStyles.push({ id: s.id, name: s.name, hex });
    }
  } catch {
    /* ignore */
  }

  try {
    const styles = await figma.getLocalTextStylesAsync();
    for (const s of styles) {
      const fn = s.fontName;
      const summary = `${fn.family} ${fn.style} · ${s.fontSize}px`;
      textStyles.push({
        id: s.id,
        name: s.name,
        summary,
        family: fn.family,
        style: fn.style,
        size: s.fontSize,
      });
    }
  } catch {
    /* ignore */
  }

  // getLocalVariablesAsync/getLocalPaintStylesAsync/getLocalTextStylesAsync only return
  // definitions that live IN THIS FILE. Design systems commonly publish their tokens from a
  // separate library file and just subscribe to them here — those variables/styles are real
  // and already applied on the canvas, but never show up as "local". Without this, the catalog
  // (and every recommendation built from it) silently ignores most of the actual design system.
  // So we also walk a set of nodes and pick up whatever variables/styles are ACTUALLY BOUND,
  // resolving each through getVariableByIdAsync/getStyleByIdAsync (which work for library-origin
  // tokens too, as long as they're already used somewhere in this document).
  //
  // Color and typography can each be pointed at their own "token source" frame (⚙ 설정, e.g. a
  // Foundations page's color palette section vs its type scale section) — only harvest inside
  // that subtree, otherwise a one-off color/font used in some random mockup elsewhere on the page
  // gets treated as if it were part of the design system. With no source set, fall back to the
  // whole current page.
  try {
    const colorNodes = await tokenSourceNodes("color");
    await harvestColorTokens(colorVariables, paintStyles, colorNodes);
  } catch {
    /* ignore */
  }
  try {
    const typoNodes = await tokenSourceNodes("typography");
    await harvestTypographyTokens(textStyles, typoNodes);
  } catch {
    /* ignore */
  }

  return { colorVariables, paintStyles, textStyles };
}

/** Resolve the node list to harvest from: inside the user-picked source frame, or the whole page. */
async function tokenSourceNodes(kind: "color" | "typography"): Promise<readonly SceneNode[]> {
  const sourceId = await getTokenSourceId(kind);
  const source = sourceId ? await figma.getNodeByIdAsync(sourceId) : null;
  return source && "findAll" in source
    ? [source as SceneNode, ...(source as ChildrenMixin & SceneNode).findAll(() => true)]
    : figma.currentPage.findAll(() => true);
}

/** Add color variables/paint styles that are bound on the given nodes but weren't already in the catalog. */
async function harvestColorTokens(
  colorVariables: TokenRef[],
  paintStyles: TokenRef[],
  nodes: readonly SceneNode[]
) {
  const seenVarIds = new Set(colorVariables.map((t) => t.id));
  const seenStyleIds = new Set(paintStyles.map((t) => t.id));

  for (const node of nodes) {
    for (const prop of ["fills", "strokes"] as const) {
      if (!(prop in node)) continue;
      const styleProp = prop === "fills" ? "fillStyleId" : "strokeStyleId";
      const sid = (node as unknown as Record<string, unknown>)[styleProp];
      if (typeof sid === "string" && sid && !seenStyleIds.has(sid)) {
        seenStyleIds.add(sid);
        try {
          const style = await figma.getStyleByIdAsync(sid);
          if (style && style.type === "PAINT") {
            const p = (style as PaintStyle).paints[0];
            const hex = p && p.type === "SOLID" ? rgbToHex(p.color) : undefined;
            paintStyles.push({ id: style.id, name: style.name, hex });
          }
        } catch {
          /* ignore */
        }
      }

      const current = (node as unknown as Record<string, unknown>)[prop];
      if (current === figma.mixed || !Array.isArray(current)) continue;
      for (const p of current as Paint[]) {
        if (p.type !== "SOLID") continue;
        const varId = p.boundVariables?.color?.id;
        if (!varId || seenVarIds.has(varId)) continue;
        seenVarIds.add(varId);
        try {
          const v = await figma.variables.getVariableByIdAsync(varId);
          if (!v) continue;
          const rgb = await resolveVariableColor(varId);
          colorVariables.push({ id: v.id, name: v.name, hex: rgb ? rgbToHex(rgb) : undefined });
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Add text styles that are bound on the given nodes but weren't already in the catalog. */
async function harvestTypographyTokens(textStyles: TokenRef[], nodes: readonly SceneNode[]) {
  const seenStyleIds = new Set(textStyles.map((t) => t.id));

  for (const node of nodes) {
    if (node.type !== "TEXT") continue;
    const tsid = node.textStyleId;
    if (typeof tsid !== "string" || !tsid || seenStyleIds.has(tsid)) continue;
    seenStyleIds.add(tsid);
    try {
      const style = await figma.getStyleByIdAsync(tsid);
      if (style && style.type === "TEXT") {
        const ts = style as TextStyle;
        const fn = ts.fontName;
        const summary = `${fn.family} ${fn.style} · ${ts.fontSize}px`;
        textStyles.push({
          id: ts.id,
          name: ts.name,
          summary,
          family: fn.family,
          style: fn.style,
          size: ts.fontSize,
        });
      }
    } catch {
      /* ignore */
    }
  }
}

/** Apply a one-click fix chosen in the UI to the given node, then report back. */
async function applyFix(nodeId: string, action: FixAction) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !("type" in node)) {
    report(nodeId, false, "노드를 찾지 못했습니다.");
    return;
  }
  const scene = node as SceneNode;
  // 스캔 이후 Figma에서 다른 페이지로 이동했을 수 있다 — bindVariableEverywhere 같은
  // figma.currentPage 기반 검색이 엉뚱한 페이지를 훑지 않도록, 노드가 실제로 속한
  // 페이지로 먼저 전환한다(전환 못하면 이후 selection 설정에서 에러가 난다).
  const nodePage = pageOf(scene);
  if (nodePage && nodePage.id !== figma.currentPage.id) {
    await figma.setCurrentPageAsync(nodePage);
  }

  try {
    let message: string;
    let touched: SceneNode[] = [scene];
    let revealCard: SceneNode | null = null; // 생성된 스와치 카드 → 그쪽으로 줌
    if (action.kind === "bind-variable") {
      const variable = await figma.variables.getVariableByIdAsync(action.variableId);
      if (!variable) throw new Error("변수를 찾지 못했습니다.");
      // 기본 동작: 같은 색(hex)을 쓰는 모든 노드에 한꺼번에 연결.
      touched = bindVariableEverywhere(action.hex, variable);
      if (touched.length === 0) {
        bindPaintVariable(scene, action.field, variable);
        touched = [scene];
      }
      message = `같은 색(${action.hex})을 쓰는 ${touched.length}개 노드를 ${action.tokenName} 변수에 연결했습니다.`;
    } else if (action.kind === "create-variable") {
      const { variable, created } = await ensureColorVariable(action.tokenName, action.hex);
      const collection = await figma.variables.getVariableCollectionByIdAsync(
        variable.variableCollectionId
      );
      touched = bindVariableEverywhere(action.hex, variable);
      if (touched.length === 0) {
        bindPaintVariable(scene, action.field, variable);
        touched = [scene];
      }
      const boundCount = touched.length;
      // 기존 디자인 시스템 카드를 '템플릿'으로 복제해 같은 자리에 카드 추가.
      let cardMsg = "";
      const tplId = await getTemplateId("color");
      if (!tplId) {
        cardMsg = " (카드 템플릿 미지정 — ⚙에서 기존 카드를 템플릿으로 지정하세요)";
      } else {
        try {
          const { card, created } = await drawSwatchCard(variable, action.hex, tplId);
          touched = [...touched, card]; // 화면 이동/선택엔 포함, 연결 카운트엔 미포함
          revealCard = card; // 새로 만들었든 이미 있었든 그 카드로 줌 — 이미 있다고만 하고 위치를 안 보여주면 못 찾는다
          cardMsg = created ? " + 스와치 카드 생성" : " (카드 이미 있음)";
        } catch (e) {
          cardMsg = " (카드 생성 실패: " + (e instanceof Error ? e.message : String(e)) + ")";
        }
      }
      const verb = created
        ? `[${collection?.name ?? "Local Variables"}]에 추가하고`
        : `(이미 있는 변수를)`;
      message =
        `✅ '${variable.name}' 변수를 ${verb} ` +
        `같은 색(${action.hex})을 쓰는 ${boundCount}개 노드에 연결${cardMsg}했습니다.`;
    } else if (action.kind === "apply-paint-style") {
      if (action.field === "fill" && "setFillStyleIdAsync" in scene) {
        await (scene as MinimalFillsMixin & SceneNode).setFillStyleIdAsync(action.styleId);
      } else if (action.field === "stroke" && "setStrokeStyleIdAsync" in scene) {
        await (scene as MinimalStrokesMixin & SceneNode).setStrokeStyleIdAsync(action.styleId);
      } else {
        throw new Error("이 노드에 스타일을 적용할 수 없습니다.");
      }
      message = `'${scene.name}'에 ${action.styleName} 스타일을 적용했습니다.`;
    } else if (action.kind === "apply-text-style") {
      if (scene.type !== "TEXT") throw new Error("텍스트 노드가 아닙니다.");
      await (scene as TextNode).setTextStyleIdAsync(action.styleId);
      message = `'${scene.name}'에 ${action.styleName} 텍스트 스타일을 적용했습니다.`;
    } else if (action.kind === "apply-spelling") {
      if (scene.type !== "TEXT") throw new Error("텍스트 노드가 아닙니다.");
      await loadTextFonts(scene as TextNode);
      (scene as TextNode).characters = action.corrected;
      message = `'${scene.name}'의 맞춤법을 수정했습니다 ("${action.original}" → "${action.corrected}").`;
    } else {
      if (scene.type !== "TEXT") throw new Error("텍스트 노드가 아닙니다.");
      const { textStyle, created, fallbackFont } = await ensureTextStyle(
        action.tokenName,
        action.family,
        action.style,
        action.size,
        action.lineHeight,
        action.letterSpacing
      );
      await (scene as TextNode).setTextStyleIdAsync(textStyle.id);
      // 색상 변수와 동일하게, 새로 만든 텍스트 스타일도 타이포 카드 템플릿(또는 타이포 기준
      // 프레임 안의 기존 샘플 카드)에 샘플을 추가한다.
      let cardMsg = "";
      const tplId = await resolveTypeCardTemplateId(
        textStyle.fontName.family,
        textStyle.fontName.style
      );
      if (!tplId) {
        cardMsg =
          " (카드로 추가할 곳을 못 찾음 — ⚙에서 타이포 카드 템플릿 또는 타이포 기준 프레임을 지정하세요)";
      } else {
        try {
          const result = await drawTypeCard(textStyle, tplId);
          touched = [...touched, result.card];
          revealCard = result.card; // 새로 만들었든 이미 있었든 그 카드로 줌
          cardMsg = !result.created
            ? " (카드 이미 있음)"
            : result.sampleIssue
            ? ` + 타이포 카드 생성 (샘플 텍스트는 원본 폰트를 못 불러와 갱신 못 함: ${result.sampleIssue})`
            : " + 타이포 카드 생성";
        } catch (e) {
          cardMsg = " (카드 생성 실패: " + (e instanceof Error ? e.message : String(e)) + ")";
        }
      }
      const verb = created ? "만들고" : "(이미 있는 스타일을)";
      const fallbackMsg = fallbackFont
        ? ` (원본 폰트가 없어 ${fallbackFont.family} ${fallbackFont.style}로 대체)`
        : "";
      message = `✅ '${textStyle.name}' 텍스트 스타일을 ${verb} '${scene.name}'에 적용${cardMsg}했습니다.${fallbackMsg}`;
    }
    // 어디에 적용됐는지 보이도록 영향받은 노드로 이동·선택·하이라이트
    // (대량 바인딩 시 테두리 도배를 막기 위해 최대 30개까지만 그린다 — 선택은 전부 유지,
    // 새로 만든 카드가 다른 페이지에 있으면 그쪽으로 전환한다).
    await revealApplyResult(touched, revealCard);
    report(nodeId, true, message, touched.map((n) => n.id));
  } catch (err) {
    report(nodeId, false, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Apply the SAME fix action to a set of explicitly picked nodes (the UI's
 * "체크한 항목에도 적용" bulk action). Unlike `applyFix`, this ignores hex/style
 * matching across the page and binds every listed node directly — the user
 * has already decided these unrelated violations should share one token.
 */
async function applyBulkFix(nodeIds: string[], action: FixAction) {
  const touched: SceneNode[] = [];
  let revealCard: SceneNode | null = null; // 생성된 스와치 카드 → 그쪽으로 줌
  let cardMsg = "";
  try {
    // 스캔 이후 Figma에서 다른 페이지로 이동했을 수 있다 — 선택된 노드들이 실제로 속한
    // 페이지로 먼저 전환한다(전환 못하면 이후 selection 설정에서 에러가 난다).
    const firstNode = nodeIds.length > 0 ? await figma.getNodeByIdAsync(nodeIds[0]) : null;
    const nodePage = firstNode ? pageOf(firstNode) : null;
    if (nodePage && nodePage.id !== figma.currentPage.id) {
      await figma.setCurrentPageAsync(nodePage);
    }

    let variable: Variable | null = null;
    let textStyleId: string | null = null;
    if (action.kind === "bind-variable") {
      variable = await figma.variables.getVariableByIdAsync(action.variableId);
      if (!variable) throw new Error("변수를 찾지 못했습니다.");
    } else if (action.kind === "create-variable") {
      const { variable: v } = await ensureColorVariable(action.tokenName, action.hex);
      variable = v;
      // 단건 적용(applyFix)과 동일하게, 새로 만든 변수는 스와치 카드도 함께 추가한다.
      const tplId = await getTemplateId("color");
      if (!tplId) {
        cardMsg = " (카드 템플릿 미지정 — ⚙에서 기존 카드를 템플릿으로 지정하세요)";
      } else {
        try {
          const { card, created } = await drawSwatchCard(variable, action.hex, tplId);
          revealCard = card; // 새로 만들었든 이미 있었든 그 카드로 줌
          cardMsg = created ? " + 스와치 카드 생성" : " (카드 이미 있음)";
        } catch (e) {
          cardMsg = " (카드 생성 실패: " + (e instanceof Error ? e.message : String(e)) + ")";
        }
      }
    } else if (action.kind === "create-text-style") {
      const { textStyle, fallbackFont } = await ensureTextStyle(
        action.tokenName,
        action.family,
        action.style,
        action.size,
        action.lineHeight,
        action.letterSpacing
      );
      textStyleId = textStyle.id;
      if (fallbackFont) {
        cardMsg += ` (원본 폰트가 없어 ${fallbackFont.family} ${fallbackFont.style}로 대체)`;
      }
      // 색상과 동일하게, 새로 만든 텍스트 스타일도 타이포 카드 템플릿(또는 타이포 기준 프레임
      // 안의 기존 샘플 카드)에 샘플을 추가한다.
      const tplId = await resolveTypeCardTemplateId(
        textStyle.fontName.family,
        textStyle.fontName.style
      );
      if (!tplId) {
        cardMsg +=
          " (카드로 추가할 곳을 못 찾음 — ⚙에서 타이포 카드 템플릿 또는 타이포 기준 프레임을 지정하세요)";
      } else {
        try {
          const result = await drawTypeCard(textStyle, tplId);
          revealCard = result.card; // 새로 만들었든 이미 있었든 그 카드로 줌
          cardMsg += !result.created
            ? " (카드 이미 있음)"
            : result.sampleIssue
            ? ` + 타이포 카드 생성 (샘플 텍스트는 원본 폰트를 못 불러와 갱신 못 함: ${result.sampleIssue})`
            : " + 타이포 카드 생성";
        } catch (e) {
          cardMsg += " (카드 생성 실패: " + (e instanceof Error ? e.message : String(e)) + ")";
        }
      }
    }

    for (const nodeId of nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node || !("type" in node)) continue;
      const scene = node as SceneNode;
      try {
        if (action.kind === "bind-variable" || action.kind === "create-variable") {
          if (!variable) continue;
          bindPaintVariable(scene, action.field, variable);
          touched.push(scene);
        } else if (action.kind === "apply-paint-style") {
          if (action.field === "fill" && "setFillStyleIdAsync" in scene) {
            await (scene as MinimalFillsMixin & SceneNode).setFillStyleIdAsync(action.styleId);
            touched.push(scene);
          } else if (action.field === "stroke" && "setStrokeStyleIdAsync" in scene) {
            await (scene as MinimalStrokesMixin & SceneNode).setStrokeStyleIdAsync(action.styleId);
            touched.push(scene);
          }
        } else if (action.kind === "apply-text-style") {
          if (scene.type === "TEXT") {
            await (scene as TextNode).setTextStyleIdAsync(action.styleId);
            touched.push(scene);
          }
        } else if (action.kind === "create-text-style") {
          if (scene.type === "TEXT" && textStyleId) {
            await (scene as TextNode).setTextStyleIdAsync(textStyleId);
            touched.push(scene);
          }
        }
      } catch {
        /* 개별 노드 실패는 건너뛰고 나머지는 계속 진행 */
      }
    }

    const boundCount = touched.length;
    if (revealCard) touched.push(revealCard); // 화면 이동/선택엔 포함, 연결 카운트엔 미포함

    // 새로 만든 카드가 다른 페이지에 있으면 그쪽으로 전환한다.
    await revealApplyResult(touched, revealCard);
    const message = `선택한 ${boundCount}개 항목에 일괄 적용했습니다${cardMsg}.`;
    report(nodeIds[0] ?? "", true, message, touched.map((n) => n.id));
  } catch (err) {
    report(nodeIds[0] ?? "", false, err instanceof Error ? err.message : String(err));
  }
}

/** Post the apply result to the UI AND show a canvas toast so failures are visible. */
function report(nodeId: string, ok: boolean, message: string, appliedNodeIds?: string[]) {
  post({ type: "apply-result", nodeId, ok, message, appliedNodeIds });
  figma.notify(ok ? message : `⚠️ 적용 실패: ${message}`, { error: !ok });
}

/**
 * Bind a color variable to EVERY untokenized solid paint (fill + stroke) on the
 * current page whose color equals `hex`. Returns the nodes that were changed.
 * Skips paints driven by a paint style (we don't want to detach those).
 */
function bindVariableEverywhere(hex: string, variable: Variable): SceneNode[] {
  const target = hex.toUpperCase();
  const changed: SceneNode[] = [];
  const all = figma.currentPage.findAll(() => true);

  for (const node of all) {
    if (node.getPluginData(HIGHLIGHT_KEY) === "1") continue;
    let touched = false;

    for (const prop of ["fills", "strokes"] as const) {
      if (!(prop in node)) continue;
      const styleProp = prop === "fills" ? "fillStyleId" : "strokeStyleId";
      const sid = (node as unknown as Record<string, unknown>)[styleProp];
      if (typeof sid === "string" && sid !== "") continue; // 스타일에 묶인 페인트는 건드리지 않음

      const current = (node as unknown as Record<string, unknown>)[prop];
      if (current === figma.mixed || !Array.isArray(current)) continue;

      const paints = (current as Paint[]).map((p) => ({ ...p })) as Paint[];
      let modified = false;
      for (let i = 0; i < paints.length; i++) {
        const p = paints[i];
        const alreadyBound = p.type === "SOLID" && Boolean(p.boundVariables && p.boundVariables.color);
        if (
          p.type === "SOLID" &&
          p.visible !== false &&
          !alreadyBound &&
          rgbToHex(p.color) === target
        ) {
          paints[i] = figma.variables.setBoundVariableForPaint(p as SolidPaint, "color", variable);
          modified = true;
        }
      }
      if (modified) {
        (node as unknown as Record<string, unknown>)[prop] = paints;
        touched = true;
      }
    }

    if (touched) changed.push(node as SceneNode);
  }

  return changed;
}

/** Bind a color variable to the first solid paint of a node's fill/stroke list. */
function bindPaintVariable(node: SceneNode, field: PaintField, variable: Variable) {
  const prop = field === "fill" ? "fills" : "strokes";
  if (!(prop in node)) throw new Error("이 노드에는 색상이 없습니다.");
  const current = (node as unknown as Record<string, unknown>)[prop];
  if (current === figma.mixed || !Array.isArray(current)) {
    throw new Error("색상이 혼합되어 있어 자동 연결할 수 없습니다.");
  }
  const paints = (current as Paint[]).map((p) => ({ ...p })) as Paint[];
  const idx = paints.findIndex((p) => p.type === "SOLID");
  if (idx === -1) throw new Error("연결할 단색 페인트가 없습니다.");
  paints[idx] = figma.variables.setBoundVariableForPaint(
    paints[idx] as SolidPaint,
    "color",
    variable
  );
  (node as unknown as Record<string, unknown>)[prop] = paints;
}

/**
 * Get a COLOR variable named `name`, reusing an existing one if present
 * (createVariable throws "duplicate variable named" otherwise). Creates it in the
 * first local collection (making one if needed) and seeds its value when new.
 */
async function ensureColorVariable(
  name: string,
  hex: string
): Promise<{ variable: Variable; created: boolean }> {
  const existing = await figma.variables.getLocalVariablesAsync("COLOR");
  const byName = existing.find((v) => v.name === name);
  if (byName) return { variable: byName, created: false };

  // 같은 '값'의 색상 변수가 이미 있으면 재사용 (이름만 다른 중복 색 변수 방지).
  const target = hex.toUpperCase();
  const byValue = existing.find((v) =>
    Object.keys(v.valuesByMode).some((m) => {
      const val = v.valuesByMode[m];
      return val && typeof val === "object" && "r" in (val as RGB) && rgbToHex(val as RGB) === target;
    })
  );
  if (byValue) return { variable: byValue, created: false };

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collection =
    collections[0] ?? figma.variables.createVariableCollection("Design System");
  const variable = figma.variables.createVariable(name, collection, "COLOR");
  variable.setValueForMode(collection.defaultModeId, hexToRgb(hex));
  return { variable, created: true };
}

/** True only if a real TextStyle's line-height exactly matches the raw fix spec (undefined spec ~ AUTO). */
function lineHeightEquals(a: LineHeight, b?: LineHeightSpec): boolean {
  if (!b) return a.unit === "AUTO";
  if (a.unit !== b.unit) return false;
  if (a.unit === "AUTO") return true;
  return Math.abs((a as { value: number }).value - (b.value ?? 0)) < 0.01;
}

/** True only if a real TextStyle's letter-spacing exactly matches the raw fix spec (undefined spec ~ 0%). */
function letterSpacingEquals(a: LetterSpacing, b?: LetterSpacingSpec): boolean {
  if (!b) return a.unit === "PERCENT" && a.value === 0;
  if (a.unit !== b.unit) return false;
  return Math.abs(a.value - b.value) < 0.01;
}

/** Find-or-create a local text style matching the given font/size, then bind it. */
async function ensureTextStyle(
  name: string,
  family: string,
  style: string,
  size: number,
  lineHeight?: LineHeightSpec,
  letterSpacing?: LetterSpacingSpec
): Promise<{ textStyle: TextStyle; created: boolean; fallbackFont?: { family: string; style: string } }> {
  const existing = await figma.getLocalTextStylesAsync();
  const byName = existing.find((s) => s.name === name);
  if (byName) return { textStyle: byName, created: false };

  // family/style/size만 같으면 재사용하던 걸 line-height/letter-spacing까지 정확히 같을 때만
  // 재사용하도록 좁혔다 — 예전엔 폰트/크기만 겹치면(행간·자간이 달라도) 사용자가 입력한 새
  // 이름을 무시하고 이름·행간·자간이 전혀 다른 기존 스타일("Sm" 등)을 그대로 돌려줘서, 뭘
  // 입력해도 항상 그 기존 스타일로 "재사용"돼 이름이 안 먹히는 것처럼 보였다.
  const byValue = existing.find(
    (s) =>
      s.fontName.family === family &&
      s.fontName.style === style &&
      s.fontSize === size &&
      lineHeightEquals(s.lineHeight, lineHeight) &&
      letterSpacingEquals(s.letterSpacing, letterSpacing)
  );
  if (byValue) return { textStyle: byValue, created: false };

  // 요청한 폰트가 이 기기/팀에 없으면 실패시키지 않고 Inter로 대체한다 (Figma에 항상 내장돼
  // 있어 확실히 로드된다). 같은 굵기(style) 이름부터 시도하고, 그것도 없으면 Regular로 낮춘다.
  let finalFamily = family;
  let finalStyle = style;
  let fallbackFont: { family: string; style: string } | undefined;
  try {
    await figma.loadFontAsync({ family, style });
  } catch {
    finalFamily = "Inter";
    try {
      await figma.loadFontAsync({ family: finalFamily, style });
    } catch {
      finalStyle = "Regular";
      await figma.loadFontAsync({ family: finalFamily, style: finalStyle });
    }
    fallbackFont = { family: finalFamily, style: finalStyle };
  }
  const textStyle = figma.createTextStyle();
  textStyle.name = name;
  textStyle.fontName = { family: finalFamily, style: finalStyle };
  textStyle.fontSize = size;
  // 원본 텍스트의 line-height/letter-spacing까지 그대로 재현 — 안 넣으면 Figma 기본값(AUTO/0%)이
  // 돼서 실제 적용 시 원본과 다르게 보일 수 있다.
  if (lineHeight) textStyle.lineHeight = lineHeight as LineHeight;
  if (letterSpacing) textStyle.letterSpacing = letterSpacing as LetterSpacing;
  return { textStyle, created: true, fallbackFont };
}

/**
 * clientStorage keys for the user-chosen template card, one each for color
 * (a swatch card) and typography (a type-sample card) — they usually live in
 * different sections of a Foundations page and clone very differently.
 */
const CARD_TEMPLATE_KEY: Record<"color" | "typography", string> = {
  color: "cardTemplateId",
  typography: "typeCardTemplateId",
};

async function getTemplateId(kind: "color" | "typography"): Promise<string | null> {
  const id = await figma.clientStorage.getAsync(CARD_TEMPLATE_KEY[kind]);
  return typeof id === "string" && id ? id : null;
}

/**
 * clientStorage keys for the user-chosen "token source" frame/section, one each
 * for color and typography (e.g. a Foundations page's color palette vs its type
 * scale, which often live in different sections). When set, catalog harvesting
 * only looks inside that node instead of the whole current page, so unrelated
 * colors/fonts used in random mockups elsewhere don't pollute the recommendations.
 */
const TOKEN_SOURCE_KEY: Record<"color" | "typography", string> = {
  color: "colorTokenSourceFrameId",
  typography: "typoTokenSourceFrameId",
};

/** clientStorage key for the user's own OpenAI API key — local to this machine, never bundled/shared. */
const API_KEY_STORAGE_KEY = "openaiApiKey";

/** clientStorage key for violation keys the user chose to dismiss — persists across re-scans. */
const IGNORED_STORAGE_KEY = "ignoredViolationKeys";

async function getIgnoredKeys(): Promise<Set<string>> {
  const raw = await figma.clientStorage.getAsync(IGNORED_STORAGE_KEY);
  return new Set(Array.isArray(raw) ? raw : []);
}

async function saveIgnoredKeys(keys: Set<string>): Promise<void> {
  await figma.clientStorage.setAsync(IGNORED_STORAGE_KEY, [...keys]);
}

async function getTokenSourceId(kind: "color" | "typography"): Promise<string | null> {
  const id = await figma.clientStorage.getAsync(TOKEN_SOURCE_KEY[kind]);
  return typeof id === "string" && id ? id : null;
}

/**
 * Resolve which node to clone for a new type-sample card: the explicitly picked
 * "타이포 샘플 카드 템플릿" if the user set one, otherwise fall back to auto-detecting
 * an existing sample card INSIDE the "타이포 기준 프레임" (⚙ 설정) they already picked —
 * so a brand-new text style still lands in that frame without a separate template step.
 *
 * A real card is a whole ROW: a size/weight label + spec text + the live-sample box
 * (≥2 text nodes total, matching the "Md" / "Font size : ..." / live-sample pattern).
 * Just requiring "contains a sample text" isn't enough — the live-sample's own inner
 * box also "contains a sample text" but has only ONE text node, so cloning IT produces
 * a stray extra sample dropped inside the existing row instead of a whole new row.
 * Requiring ≥2 texts lands on the individual row and not on an inner box (too few
 * texts) or an outer section wrapping many rows.
 *
 * Real design-system pages group rows into sections by font WEIGHT (e.g. "Title
 * (Extra Bold)" vs "Body (Regular)" vs "Subtitle (Bold)"), each holding its own
 * Xlg/Lg/Md/Sm rows. Picking the globally-smallest matching row (regardless of
 * which section it's in) meant every new style — no matter its actual name or
 * font — kept landing next to the same one card, since it happened to be the
 * smallest row on the whole page. The user's typed name can't be trusted to
 * indicate which section it belongs in, but the new style's ACTUAL font family/
 * weight can be compared against each candidate row's own live-sample font — so
 * prefer a candidate whose section already uses that same family/weight, and
 * only fall back to "just the smallest one" if nothing matches.
 */
async function resolveTypeCardTemplateId(
  family: string,
  style: string
): Promise<string | null> {
  const explicit = await getTemplateId("typography");
  if (explicit) return explicit;

  const sourceId = await getTokenSourceId("typography");
  if (!sourceId) return null;
  const source = await figma.getNodeByIdAsync(sourceId);
  if (!source || !("findAll" in source)) return null;

  const candidates = (
    (source as ChildrenMixin & SceneNode).findAll((n) => {
      if (
        n.type !== "FRAME" &&
        n.type !== "COMPONENT" &&
        n.type !== "INSTANCE" &&
        n.type !== "GROUP"
      ) {
        return false;
      }
      if (findSampleTextNode(n as SceneNode) === null) return false;
      const textCount = (n as ChildrenMixin & SceneNode).findAll((c) => c.type === "TEXT").length;
      return textCount >= 2;
    }) as SceneNode[]
  ).sort((a, b) => {
    const area = (n: SceneNode) => {
      const box = n.absoluteBoundingBox;
      return box ? box.width * box.height : Infinity;
    };
    return area(a) - area(b);
  });

  const fontMatches = candidates.filter((c) => {
    const s = findSampleTextNode(c);
    if (!s || s.fontName === figma.mixed) return false;
    const fn = s.fontName as FontName;
    return fn.family === family && fn.style === style;
  });

  return fontMatches[0]?.id ?? candidates[0]?.id ?? null;
}

/** Load every font used in a text node so its characters can be edited. */
async function loadTextFonts(t: TextNode) {
  const seen = new Set<string>();
  for (const s of t.getStyledTextSegments(["fontName"])) {
    const fn = s.fontName as FontName;
    const key = `${fn.family}__${fn.style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await figma.loadFontAsync(fn);
  }
}

/** Replace text from `start` to the end, keeping the styling of the preceding run. */
function replaceTail(t: TextNode, start: number, tail: string) {
  const len = t.characters.length;
  const s = Math.max(0, Math.min(start, len));
  if (s < len) t.deleteCharacters(s, len);
  t.insertCharacters(s, tail, "BEFORE");
}

/**
 * The card's color swatch = biggest RECTANGLE with a solid fill (the color block;
 * label boxes are FRAMEs, text is TEXT). Falls back to the biggest non-white solid
 * node if the template uses something other than a rectangle.
 */
function findSwatchNode(card: SceneNode): SceneNode | null {
  const nodes: SceneNode[] =
    "findAll" in card
      ? [card, ...(card as ChildrenMixin & SceneNode).findAll(() => true)]
      : [card];
  const solidOf = (n: SceneNode): SolidPaint | undefined => {
    if (!("fills" in n)) return undefined;
    const fills = (n as GeometryMixin).fills;
    if (fills === figma.mixed || !Array.isArray(fills)) return undefined;
    return fills.find((p) => p.type === "SOLID") as SolidPaint | undefined;
  };
  const area = (n: SceneNode) => {
    const b = n.absoluteBoundingBox;
    return b ? b.width * b.height : 0;
  };

  let rect: SceneNode | null = null;
  let rectArea = -1;
  let fallback: SceneNode | null = null;
  let fbArea = -1;
  for (const n of nodes) {
    const solid = solidOf(n);
    if (!solid) continue;
    if (n.type === "RECTANGLE" && area(n) > rectArea) {
      rectArea = area(n);
      rect = n;
    }
    const c = solid.color;
    const white = c.r > 0.93 && c.g > 0.93 && c.b > 0.93;
    if (!white && area(n) > fbArea) {
      fbArea = area(n);
      fallback = n;
    }
  }
  return rect ?? fallback;
}

/** Rewrite a cloned card's labels: name → token leaf, HEX/RGB → the new color. */
/**
 * `hex` is null when the plugin couldn't statically resolve the variable's color
 * (broken/dangling alias, missing mode value, etc.) — the card is still created and
 * the fill is still bound to the variable (Figma renders whatever it actually
 * resolves to at runtime, independent of our lookup), but the HEX/RGB labels can't
 * be filled in and are marked instead so the user knows to check that variable.
 */
async function relabelCard(card: SceneNode, variable: Variable, hex: string | null) {
  const texts = (
    "findAll" in card
      ? (card as ChildrenMixin & SceneNode).findAll((n) => n.type === "TEXT")
      : []
  ) as TextNode[];
  const rgb = hex ? hexToRgb(hex) : null;
  const r = rgb ? Math.round(rgb.r * 255) : null;
  const g = rgb ? Math.round(rgb.g * 255) : null;
  const b = rgb ? Math.round(rgb.b * 255) : null;
  const leaf = variable.name.split("/").pop() || variable.name;
  let nameSet = false;
  for (const t of texts) {
    const chars = t.characters;
    try {
      await loadTextFonts(t);
    } catch {
      continue; // 폰트(예: Pretendard ExtraBold)를 못 불러오면 이 텍스트는 건드리지 않음
    }
    if (/HEX/i.test(chars)) {
      const idx = chars.search(/#|[0-9A-Fa-f]{6}/);
      replaceTail(t, idx >= 0 ? idx : chars.length, hex ? hex.toUpperCase() : "값 확인 필요");
    } else if (/RGB/i.test(chars)) {
      const idx = chars.search(/\d/);
      replaceTail(t, idx >= 0 ? idx : chars.length, rgb ? `${r} ${g} ${b}` : "값 확인 필요");
    } else if (!nameSet) {
      t.characters = leaf;
      nameSet = true;
    }
  }
}

/**
 * Add a swatch card INTO the real design system by cloning the user-chosen template
 * card and appending it to that template's parent (same row/section, same format).
 * Rebinds the cloned swatch to `variable` and rewrites its labels. Returns the new
 * card, or null if a card for this variable already exists in that parent.
 */
async function drawSwatchCard(
  variable: Variable,
  hex: string,
  templateId: string
): Promise<{ card: SceneNode; created: boolean }> {
  const tpl = await figma.getNodeByIdAsync(templateId);
  if (!tpl || !("clone" in tpl) || !("parent" in tpl) || !tpl.parent) {
    throw new Error("카드 템플릿 노드를 찾지 못했습니다. 다시 지정하세요.");
  }
  const parent = tpl.parent as BaseNode & ChildrenMixin;
  const cardName = `swatch ${variable.name}`;
  // 카드가 이미 있으면 새로 안 만들지만, 어디 있는지 찾아서 돌려준다 — 호출부가 그쪽으로
  // 화면을 이동시켜줄 수 있게(이미 있다고만 하고 위치를 안 알려주면 사용자가 못 찾는다).
  const existing = parent.children.find((c) => c.name === cardName);
  if (existing) return { card: existing as SceneNode, created: false };

  const card = (tpl as SceneNode & { clone(): SceneNode }).clone();
  card.name = cardName;
  parent.appendChild(card);

  const swatch = findSwatchNode(card);
  if (swatch) bindPaintVariable(swatch, "fill", variable);
  await relabelCard(card, variable, hex);
  return { card, created: true };
}

/**
 * Incremental: add a card ONLY for color variables that don't have one yet (no
 * `swatch <name>` node on the page). New cards are cloned from the template and
 * appended to the template's parent (the real design-system row). Variables that
 * already have a card (e.g. gray-300) are skipped — nothing is regenerated.
 */
async function generateAllCards() {
  const tplId = await getTemplateId("color");
  if (!tplId) {
    figma.notify("먼저 ⚙에서 카드 템플릿을 지정하세요.");
    post({ type: "generate-result", kind: "color", ok: false, message: "카드 템플릿 미지정 — ⚙에서 기존 카드를 지정하세요." });
    return;
  }
  const tpl = await figma.getNodeByIdAsync(tplId);
  if (!tpl || !("clone" in tpl) || !("parent" in tpl) || !tpl.parent) {
    post({ type: "generate-result", kind: "color", ok: false, message: "템플릿 노드를 찾지 못했습니다." });
    return;
  }
  const parent = tpl.parent as BaseNode & ChildrenMixin;
  // 템플릿이 지금 보고 있는 페이지가 아닌 다른 페이지에 있을 수 있다 — 중복 카드 검사와
  // 최종 선택/줌은 반드시 템플릿이 실제로 속한 페이지를 기준으로 해야 한다.
  const page = pageOf(parent) ?? figma.currentPage;

  const vars = await figma.variables.getLocalVariablesAsync("COLOR");

  // 이미 카드가 있는 변수(swatch <name> 노드 존재)는 건너뛴다.
  const existing = new Set(
    page.findAll((n) => n.name.indexOf("swatch ") === 0).map((n) => n.name)
  );

  const added: SceneNode[] = [];
  const unresolvedNames: string[] = [];
  let alreadyHasCard = 0;
  for (const v of vars) {
    const cardName = `swatch ${v.name}`;
    if (existing.has(cardName)) {
      alreadyHasCard++;
      continue;
    }
    // 변수마다 실제로 속한 컬렉션/모드에서 값을 읽는다 — 첫 번째 컬렉션의 모드 ID로만 읽으면
    // 다른 컬렉션에 속한 변수(혹은 다른 변수를 참조하는 alias)는 값을 못 찾아 전부 건너뛰게 된다.
    const val = await resolveVariableColor(v.id);
    if (!val) unresolvedNames.push(v.name);
    // 값을 못 읽었어도 카드는 만들고 변수 바인딩은 그대로 건다 — Figma는 우리 조회 로직과
    // 무관하게 실제 값을 알아서 렌더링하므로(끊긴 alias가 아닌 이상), 값 텍스트만 못 채울 뿐
    // 카드 자체를 못 만들 이유는 없다. 사용자가 문서에서 바로 눈으로 확인하고 고칠 수 있다.
    const hex = val ? rgbToHex(val) : null;
    const card = (tpl as SceneNode & { clone(): SceneNode }).clone();
    card.name = cardName;
    parent.appendChild(card);
    const swatch = findSwatchNode(card);
    if (swatch) bindPaintVariable(swatch, "fill", v);
    await relabelCard(card, v, hex);
    added.push(card);
  }

  let m: string;
  if (added.length) {
    if (page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = added;
    figma.viewport.scrollAndZoomIntoView(added);
    m =
      unresolvedNames.length > 0
        ? `${added.length}개 변수 카드를 추가했습니다 (이 중 값을 확인 못한 변수: ${unresolvedNames
            .slice(0, 5)
            .join(", ")}${
            unresolvedNames.length > 5 ? ` 외 ${unresolvedNames.length - 5}개` : ""
          } — 카드는 추가됐지만 HEX/RGB 라벨은 직접 확인해주세요).`
        : `${added.length}개 변수 카드를 추가했습니다.`;
  } else {
    m = `추가할 새 카드가 없습니다 (모든 변수에 카드가 이미 있어요: ${alreadyHasCard}개).`;
  }
  figma.notify(m);
  post({ type: "generate-result", kind: "color", ok: true, message: m });
}

/**
 * The card's live sample = the TEXT node already bound to a real text style
 * (i.e. the node that's actually demonstrating a style) — mirrors how
 * `findSwatchNode` picks the color rectangle: the node that carries the
 * thing we're about to rebind, not a label.
 *
 * Picking "largest font size" doesn't work: a real spec-card's size/weight
 * label (e.g. "Md") is often BIGGER than the live sample text itself, since
 * the label uses its own fixed heading style while the sample demonstrates
 * a body style. What reliably distinguishes the sample is that it sits in
 * its OWN nested container (usually a colored box) instead of directly on
 * the card, since design systems box the live example separately from the
 * flat row of labels/spec text — so we prefer the most deeply nested
 * text-styled candidate instead.
 */
function findSampleTextNode(card: SceneNode): TextNode | null {
  const texts = (
    "findAll" in card ? (card as ChildrenMixin & SceneNode).findAll((n) => n.type === "TEXT") : []
  ) as TextNode[];
  const candidates = texts.filter((t) => Boolean(t.textStyleId));
  if (candidates.length === 0) return texts[0] ?? null;

  const depthOf = (n: BaseNode): number => {
    let depth = 0;
    let p = n.parent;
    while (p && p.id !== card.id) {
      depth++;
      p = p.parent;
    }
    return depth;
  };

  let best: TextNode | null = null;
  let bestDepth = -1;
  for (const t of candidates) {
    const depth = depthOf(t);
    if (depth > bestDepth) {
      bestDepth = depth;
      best = t;
    }
  }
  return best ?? candidates[0];
}

function roundTo(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** "160%" / "24px" / "Auto" — matches how design-system spec labels usually read line-height. */
function formatLineHeight(lh: LineHeight): string {
  if (lh.unit === "AUTO") return "Auto";
  return lh.unit === "PERCENT" ? `${roundTo(lh.value, 2)}%` : `${roundTo(lh.value, 2)}px`;
}

/** "-2.5% (-0.35px)" — Figma stores letter-spacing in one unit only, so the other is derived from font size. */
function formatLetterSpacing(ls: LetterSpacing, fontSize: number): string {
  const percent = ls.unit === "PERCENT" ? ls.value : fontSize ? (ls.value / fontSize) * 100 : 0;
  const px = ls.unit === "PERCENT" ? (fontSize * ls.value) / 100 : ls.value;
  return `${roundTo(percent, 2)}% (${roundTo(px, 2)}px)`;
}

/**
 * Rewrite a cloned type card's labels — everything except the live sample text:
 * the style-name label, and (when the template has one) a spec block ("Font size :
 * Npx / Line height : L[ / Letter Spacing: S]") so it's regenerated from the ACTUAL
 * new style instead of staying stale/copied. Templates without that spec block just
 * get the short "family style · size" label.
 *
 * The spec block is identified by "Font size" alone — NOT by also requiring "Letter
 * Spacing" to be present. Real templates vary: some rows omit the letter-spacing line
 * entirely. Requiring both used to make the check fail on those rows, so the spec
 * text fell through to the generic digit/px fallback and got flattened into a single
 * "family style · size" line — silently dropping the actual line-height it was meant
 * to show. Whether the regenerated block includes a letter-spacing line now mirrors
 * whatever the original template row had, so the format each row already used is kept.
 */
async function relabelTypeCard(card: SceneNode, textStyle: TextStyle, sample: TextNode) {
  const texts = (
    "findAll" in card ? (card as ChildrenMixin & SceneNode).findAll((n) => n.type === "TEXT") : []
  ) as TextNode[];
  // 라벨은 이름의 마지막 조각만 쓴다 — "/"뿐 아니라 "-"로도 나눠서(예: "text/t-01" → "01"),
  // "Md"/"Sm"처럼 카드 라벨은 짧은 코드 하나만 보여주는 기존 컨벤션과 맞춘다.
  const leaf = textStyle.name.split(/[/-]/).filter(Boolean).pop() || textStyle.name;
  const summary = `${textStyle.fontName.family} ${textStyle.fontName.style} · ${textStyle.fontSize}px`;
  let nameSet = false;
  for (const t of texts) {
    if (t === sample) continue;

    // 글자를 읽는 건 폰트 로드 없이도 가능 — 뭘로 바꿀지는 먼저 정하고, 실제로 쓸 때만 폰트가 필요하다.
    let chars = "";
    try {
      chars = t.characters;
    } catch {
      continue; // 정말 못 읽으면 포기
    }

    let newChars: string | null = null;
    if (/font size/i.test(chars)) {
      const lines = [
        `Font size : ${textStyle.fontSize}px`,
        `Line height : ${formatLineHeight(textStyle.lineHeight)}`,
      ];
      if (/letter spacing/i.test(chars)) {
        lines.push(
          `Letter Spacing: ${formatLetterSpacing(textStyle.letterSpacing, textStyle.fontSize)}`
        );
      }
      newChars = lines.join("\n");
    } else if (/\d+\s*px/i.test(chars)) {
      newChars = summary;
    } else if (!nameSet) {
      newChars = leaf;
      nameSet = true;
    }
    if (newChars === null) continue; // 이 텍스트는 라벨/스펙 어느 쪽도 아님 — 손대지 않는다

    try {
      // 라벨/스펙이 쓰는 폰트(예: Pretendard)가 이 기기에 없으면 여기서 던진다 — 스펙 블록만
      // 없는 게 아니라 이 라벨 텍스트에도 손을 못 대서, 새 스타일을 만들어도 카드엔 항상
      // 템플릿의 옛날 값("Sm"/"12px"/"150%")이 그대로 남아있는 것처럼 보였다.
      await loadTextFonts(t);
      t.characters = newChars;
    } catch {
      // 원본 폰트를 못 불러오면 텍스트를 새로 만들어 갈아끼운다(샘플 텍스트와 동일한 우회).
      await replaceTextNodeSafely(t, newChars);
    }
  }
}

/**
 * Swap a text node for a brand-new one with the same content/position/sizing,
 * using Inter (always available) instead of whatever font it originally had.
 * Used when the original font can't be loaded, so the node's content couldn't
 * otherwise be updated at all (Figma requires the CURRENT font loaded first).
 */
async function replaceTextNodeSafely(node: TextNode, newCharacters: string): Promise<TextNode> {
  const parent = node.parent as (BaseNode & ChildrenMixin) | null;
  if (!parent) throw new Error("텍스트 노드의 부모를 찾지 못했습니다.");
  const index = parent.children.indexOf(node as unknown as SceneNode);
  const { x, y, width, height, textAlignHorizontal, textAlignVertical, textAutoResize, fontSize } =
    node;
  const isAutoLayoutChild =
    "layoutMode" in parent && (parent as unknown as { layoutMode: string }).layoutMode !== "NONE";

  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  const next = figma.createText();
  next.fontName = { family: "Inter", style: "Regular" };
  if (typeof fontSize === "number") next.fontSize = fontSize;
  next.characters = newCharacters;
  next.textAlignHorizontal = textAlignHorizontal;
  next.textAlignVertical = textAlignVertical;
  next.textAutoResize = textAutoResize;
  if (!isAutoLayoutChild) {
    next.x = x;
    next.y = y;
  }
  next.resize(Math.max(width, 1), Math.max(height, 1));

  parent.insertChild(Math.max(index, 0), next);
  node.remove();
  return next;
}

/**
 * Add a type-sample card INTO the real design system by cloning the user-chosen
 * template card (same pattern as `drawSwatchCard`) and rebinding its live sample
 * text to the new style.
 */
async function drawTypeCard(
  textStyle: TextStyle,
  templateId: string
): Promise<{ card: SceneNode; created: boolean; sampleIssue: string | null }> {
  const tpl = await figma.getNodeByIdAsync(templateId);
  if (!tpl || !("clone" in tpl) || !("parent" in tpl) || !tpl.parent) {
    throw new Error("카드 템플릿 노드를 찾지 못했습니다. 다시 지정하세요.");
  }
  const parent = tpl.parent as BaseNode & ChildrenMixin;
  const cardName = `type-sample ${textStyle.name}`;
  // 카드가 이미 있으면 새로 안 만들지만, 어디 있는지 찾아서 돌려준다 — 호출부가 그쪽으로
  // 화면을 이동시켜줄 수 있게(이미 있다고만 하고 위치를 안 알려주면 사용자가 못 찾는다).
  const existing = parent.children.find((c) => c.name === cardName);
  if (existing) return { card: existing as SceneNode, created: false, sampleIssue: null };

  const card = (tpl as SceneNode & { clone(): SceneNode }).clone();
  card.name = cardName;
  parent.appendChild(card);

  let sample = findSampleTextNode(card);
  let sampleIssue: string | null = null;
  if (sample) {
    // 템플릿 카드의 원본 샘플 텍스트가 쓰던 폰트(예: 팀에 없는 커스텀 폰트)가 이 기기에
    // 없으면, Figma 규칙상 그 텍스트에 손도 못 댄다(속성을 바꾸려면 "현재" 폰트부터 로드해야
    // 함) — 그래서 카드가 겉보기엔 그냥 템플릿 그대로 복사된 것처럼 남는다. 그 경우, 텍스트
    // 노드를 고쳐 쓰는 대신 아예 새로 만들어서 갈아끼운다: 새 노드는 원래 그 폰트를 가져본
    // 적이 없으니 "현재 폰트 로드" 제약에 걸리지 않는다.
    try {
      await loadTextFonts(sample);
      await sample.setTextStyleIdAsync(textStyle.id);
    } catch {
      try {
        sample = await replaceSampleWithNewFont(sample, textStyle);
      } catch (e) {
        sampleIssue = e instanceof Error ? e.message : String(e);
      }
    }
    await relabelTypeCard(card, textStyle, sample);
  }
  return { card, created: true, sampleIssue };
}

/**
 * When the sample's original font can't be loaded (so its properties can't be
 * edited), swap it for a brand-new text node styled with the real new text style
 * instead — a fresh node was never bound to the missing font, so it isn't subject
 * to Figma's "must load the CURRENT font before editing" restriction. Keeps the
 * old sample's original wording, position and sizing so the card still reads the
 * same, just with the new style actually applied.
 */
async function replaceSampleWithNewFont(oldSample: TextNode, textStyle: TextStyle): Promise<TextNode> {
  const parent = oldSample.parent as (BaseNode & ChildrenMixin) | null;
  if (!parent) throw new Error("샘플 텍스트의 부모를 찾지 못했습니다.");
  const index = parent.children.indexOf(oldSample as unknown as SceneNode);

  let characters = "";
  try {
    characters = oldSample.characters; // 읽기는 폰트 로드 없이도 가능 — 원래 문구는 그대로 유지
  } catch {
    /* 못 읽으면 빈 텍스트로 시작 */
  }
  const { x, y, width, height, textAlignHorizontal, textAlignVertical, textAutoResize } = oldSample;
  const isAutoLayoutChild =
    "layoutMode" in parent && (parent as unknown as { layoutMode: string }).layoutMode !== "NONE";

  await figma.loadFontAsync(textStyle.fontName);
  const next = figma.createText();
  next.fontName = textStyle.fontName;
  next.characters = characters;
  await next.setTextStyleIdAsync(textStyle.id);
  next.textAlignHorizontal = textAlignHorizontal;
  next.textAlignVertical = textAlignVertical;
  next.textAutoResize = textAutoResize;
  if (!isAutoLayoutChild) {
    next.x = x;
    next.y = y;
  }
  next.resize(Math.max(width, 1), Math.max(height, 1));

  parent.insertChild(Math.max(index, 0), next);
  oldSample.remove();
  return next;
}

/**
 * Incremental: add a card ONLY for text styles that don't have one yet (no
 * `type-sample <name>` node on the page). Mirrors `generateAllCards`.
 */
async function generateAllTypeCards() {
  const styles = await figma.getLocalTextStylesAsync();
  // 스타일마다 그 폰트/굵기가 실제로 쓰이는 섹션(템플릿)을 각자 찾는데, 그 템플릿들이 서로
  // 다른 페이지에 있을 수도 있다 — 중복 카드 검사는 각 템플릿이 실제로 속한 페이지 기준으로
  // 페이지별로 캐싱하고, 새로 만든 카드도 페이지별로 묶어서 관리한다.
  const existingByPage = new Map<string, Set<string>>();
  const addedByPage = new Map<string, { page: PageNode; nodes: SceneNode[] }>();

  let skipped = 0;
  for (const s of styles) {
    const cardName = `type-sample ${s.name}`;

    // 스타일마다 그 폰트/굵기가 실제로 쓰이는 섹션을 각자 찾는다 — 템플릿 하나를 고정해서
    // 전부 거기 몰아넣으면, 서로 다른 섹션(Title/Subtitle/Body 등)에 있어야 할 스타일들이
    // 전부 그 템플릿이 속한 섹션 하나에만 쌓이는 문제가 생긴다.
    const tplId = await resolveTypeCardTemplateId(s.fontName.family, s.fontName.style);
    const tpl = tplId ? await figma.getNodeByIdAsync(tplId) : null;
    if (!tpl || !("clone" in tpl) || !("parent" in tpl) || !tpl.parent) {
      skipped++;
      continue;
    }
    const parent = tpl.parent as BaseNode & ChildrenMixin;
    const page = pageOf(parent) ?? figma.currentPage;

    let existing = existingByPage.get(page.id);
    if (!existing) {
      existing = new Set(page.findAll((n) => n.name.indexOf("type-sample ") === 0).map((n) => n.name));
      existingByPage.set(page.id, existing);
    }
    if (existing.has(cardName)) continue;

    const card = (tpl as SceneNode & { clone(): SceneNode }).clone();
    card.name = cardName;
    parent.appendChild(card);
    existing.add(cardName);
    const sample = findSampleTextNode(card);
    if (sample) {
      try {
        await loadTextFonts(sample);
        await sample.setTextStyleIdAsync(s.id);
        await relabelTypeCard(card, s, sample);
      } catch {
        /* 폰트를 못 불러오면 이 카드는 스타일 미적용 상태로 남긴다 */
      }
    }
    let bucket = addedByPage.get(page.id);
    if (!bucket) {
      bucket = { page, nodes: [] };
      addedByPage.set(page.id, bucket);
    }
    bucket.nodes.push(card);
  }

  const totalAdded = [...addedByPage.values()].reduce((n, b) => n + b.nodes.length, 0);
  let m: string;
  if (totalAdded) {
    // 여러 페이지에 흩어져 추가됐으면 가장 많이 추가된 페이지로 이동해 선택/줌한다
    // (Figma는 현재 페이지가 아닌 노드는 선택/줌할 수 없다).
    const primary = [...addedByPage.values()].sort((a, b) => b.nodes.length - a.nodes.length)[0];
    if (primary.page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(primary.page);
    figma.currentPage.selection = primary.nodes;
    figma.viewport.scrollAndZoomIntoView(primary.nodes);
    const otherPages = addedByPage.size - 1;
    m =
      `${totalAdded}개 텍스트 스타일 카드를 추가했습니다.` +
      (otherPages > 0 ? ` (다른 페이지 ${otherPages}곳에도 추가됨)` : "") +
      (skipped ? ` (${skipped}개는 카드로 추가할 곳을 못 찾아 건너뜀)` : "");
  } else if (skipped) {
    m = `카드로 추가할 곳을 못 찾아 ${skipped}개를 건너뛰었습니다 — ⚙에서 타이포 카드 템플릿 또는 타이포 기준 프레임을 지정하세요.`;
  } else {
    m = "추가할 새 카드가 없습니다 (모든 스타일에 카드가 이미 있어요).";
  }
  figma.notify(m);
  post({ type: "generate-result", kind: "typography", ok: true, message: m });
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
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

/**
 * Resolve a color variable's literal RGB, following VARIABLE_ALIAS chains
 * (e.g. a semantic token aliasing a primitive scale step like Blue-10).
 * Without this, aliased steps report no hex and drop out of the AI catalog,
 * leaving only literal-value steps (e.g. Blue-100) as viable matches.
 *
 * Mode-aware: when hopping across collections, Figma resolves the alias
 * using the mode with the SAME NAME in the target collection (falling back
 * to its default mode if no matching name exists) — not that collection's
 * default mode outright. Ignoring this previously produced nonsense (e.g. a
 * "white" alias landing on an unrelated collection's default mode, which
 * happened to be a dark value) since a collection's own default mode can be
 * completely unrelated to the mode the alias is actually being read in.
 */
async function resolveVariableColor(
  variableId: string,
  modeName?: string,
  depth = 0
): Promise<RGB | undefined> {
  if (depth > 5) return undefined; // guard against alias cycles
  const v = await figma.variables.getVariableByIdAsync(variableId);
  if (!v) return undefined;
  const collection = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  if (!collection) return undefined;
  const matchedMode = modeName && collection.modes.find((m) => m.name === modeName);
  let modeId = matchedMode ? matchedMode.modeId : collection.defaultModeId;
  // 변수가 이 컬렉션의 모드가 추가된 이후 값을 한 번도 설정받지 못했으면 defaultModeId에
  // 값이 없을 수 있다 — 그런 경우 아예 포기하지 말고 실제로 값이 있는 모드로 대신 읽는다.
  if (!(modeId in v.valuesByMode)) modeId = Object.keys(v.valuesByMode)[0];
  const val = v.valuesByMode[modeId];
  if (val && typeof val === "object") {
    if ("r" in (val as RGB)) return val as RGB;
    if ((val as VariableAlias).type === "VARIABLE_ALIAS") {
      const currentModeName = collection.modes.find((m) => m.modeId === modeId)?.name;
      return resolveVariableColor((val as VariableAlias).id, currentModeName, depth + 1);
    }
  }
  return undefined;
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
            fix: { kind: "color", field: "fill", hex: rgbToHex((paint as SolidPaint).color) },
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
            fix: { kind: "color", field: "stroke", hex: rgbToHex((paint as SolidPaint).color) },
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
        fix: { kind: "typography", summary: "mixed" },
      },
    ];
  }

  if (styleId === "") {
    const font = node.fontName;
    const size = node.fontSize;
    const lineHeight = node.lineHeight;
    const letterSpacing = node.letterSpacing;
    const notMixed =
      font !== figma.mixed &&
      size !== figma.mixed &&
      lineHeight !== figma.mixed &&
      letterSpacing !== figma.mixed;
    const detail = notMixed
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
        fix: notMixed
          ? {
              kind: "typography",
              summary: detail,
              family: (font as FontName).family,
              style: (font as FontName).style,
              size: size as number,
              lineHeight: lineHeight as LineHeightSpec,
              letterSpacing: letterSpacing as LetterSpacingSpec,
            }
          : { kind: "typography", summary: detail },
      },
    ];
  }

  return [];
}
