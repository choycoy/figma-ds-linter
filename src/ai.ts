// OpenAI call that turns linter violations into actionable token recommendations.
// Runs in the UI iframe (which is allowed to fetch api.openai.com per manifest).

import type { Violation, TokenCatalog, Recommendation, FixAction, SpellingCandidate } from "./shared";
import { violationKey } from "./shared";
export { violationKey };

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const CHUNK = 12; // violations per request (작을수록 병렬↑·부분표시 빠름)
// 색상·타이포 모두 로컬에서 "가장 가까운" 계산을 하지 않는다 — 정확히 일치하는 토큰만 즉시
// 처리하고, 나머지는 전부 AI에게 넘겨 카탈로그 전체 맥락(네이밍 컨벤션 등)을 보고 판단하게 한다.

interface RawRec {
  index: number;
  matchKind: "variable" | "paintStyle" | "textStyle" | "new" | "none";
  tokenId?: string;
  newName?: string;
  rationale?: string;
}

const SYSTEM = `너는 Figma 디자인 시스템 린터의 어시스턴트야.
각 위반(raw 값)에 대해, 주어진 "사용 가능한 토큰" 목록에서 가장 알맞은 토큰을 골라 연결을 추천해.
규칙:
- 색상은 hex가 정확히/가장 가깝게 일치하는 colorVariable 또는 paintStyle을 우선 추천한다.
- 타이포는 폰트/크기가 맞는 textStyle을 추천한다.
- 일치하는 토큰이 목록에 없을 때는 색상이든 타이포든 새 이름(newName)을 제안한다(matchKind="new").
- 새 이름(newName)을 만들 때:
  - "사용 가능한 토큰" 목록에 이미 있는 이름은 절대 다시 만들지 마라. 반드시 목록에 없는 새 이름이어야 한다(이미 있으면 그 토큰을 matchKind로 추천).
  - 기존 토큰 이름들의 네이밍 컨벤션(접두사·구분자·계층 구조·대소문자, 예: "color/gray-900", "text/heading-01" 같은 slash 계층, kebab-case 등)을 그대로 따른다. 타이포 새 이름은 textStyle 목록의 네이밍을, 색상 새 이름은 colorVariable/paintStyle 목록의 네이밍을 따른다.
  - 기존 이름이 하나도 없을 때만 "color/gray-900" 또는 "text/body-01" 같은 일반적인 컨벤션을 사용한다.
- 토큰 id는 반드시 주어진 목록의 값 그대로 사용한다. 추측하지 마라.
- matchKind="new"일 때(방금 지어낸 새 이름일 때) rationale에 "가장 가까운", "일치하는" 같은 표현을
  쓰지 마라 — 새로 만드는 이름일 뿐 기존 토큰과 비교한 결과가 아니다.
- rationale은 한국어 한 줄로 짧게.
오직 JSON만 출력한다.`;

function catalogBlock(catalog: TokenCatalog): string {
  const c = catalog.colorVariables
    .map((t) => `  variable ${t.id} | ${t.name}${t.hex ? " | " + t.hex : ""}`)
    .join("\n");
  const p = catalog.paintStyles
    .map((t) => `  paintStyle ${t.id} | ${t.name}${t.hex ? " | " + t.hex : ""}`)
    .join("\n");
  const tx = catalog.textStyles
    .map((t) => `  textStyle ${t.id} | ${t.name}${t.summary ? " | " + t.summary : ""}`)
    .join("\n");
  return `사용 가능한 토큰:\n[colorVariables]\n${c || "  (없음)"}\n[paintStyles]\n${
    p || "  (없음)"
  }\n[textStyles]\n${tx || "  (없음)"}`;
}

function problemsBlock(violations: Violation[]): string {
  return violations
    .map((v, i) => {
      if (v.fix && v.fix.kind === "color") {
        return `  ${i}: color ${v.fix.field} raw=${v.fix.hex}`;
      }
      if (v.fix && v.fix.kind === "typography") {
        return `  ${i}: typography raw="${v.fix.summary}"`;
      }
      return `  ${i}: ${v.type} ${v.message}`;
    })
    .join("\n");
}

async function callChunk(
  apiKey: string,
  violations: Violation[],
  catalog: TokenCatalog
): Promise<RawRec[]> {
  const user = `${catalogBlock(catalog)}\n\n위반 목록:\n${problemsBlock(
    violations
  )}\n\n다음 형식의 JSON만 출력해:
{"recommendations":[{"index":0,"matchKind":"variable","tokenId":"<id>","newName":"<옵션>","rationale":"<한 줄>"}]}`;

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e) {
    // 브라우저에선 fetch가 "Failed to fetch"로만 던져진다. 두 가지 원인이 같은 증상으로 보임:
    //  1) API 키가 틀림 → OpenAI가 401을 주는데, 401 응답엔 CORS 헤더가 없어 브라우저가 읽지 못함
    //  2) 매니페스트 networkAccess 미적용으로 요청 자체가 차단됨
    // (1)이 가장 흔하므로 키부터 안내한다.
    throw new Error(
      "요청 실패. 대부분 API 키 오류(401)입니다 — ⚙에서 올바른 sk-... 키를 다시 저장하세요. " +
        "키가 맞다면 매니페스트 재임포트/네트워크 권한을 확인하세요. (" +
        (e instanceof Error ? e.message : String(e)) +
        ")"
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content);
  const arr = Array.isArray(parsed) ? parsed : parsed.recommendations;
  return Array.isArray(arr) ? (arr as RawRec[]) : [];
}

/** Turn a raw model rec + its violation + catalog into a validated Recommendation. */
function toRecommendation(
  raw: RawRec,
  v: Violation,
  catalog: TokenCatalog
): Recommendation {
  const text = raw.rationale || "추천을 생성하지 못했습니다.";
  const field = v.fix && v.fix.kind === "color" ? v.fix.field : "fill";

  if (raw.matchKind === "variable") {
    const t = catalog.colorVariables.find((x) => x.id === raw.tokenId);
    if (t && v.fix && v.fix.kind === "color") {
      const action: FixAction = {
        kind: "bind-variable",
        field,
        variableId: t.id,
        tokenName: t.name,
        hex: v.fix.hex,
      };
      return { text, action };
    }
  } else if (raw.matchKind === "paintStyle") {
    const t = catalog.paintStyles.find((x) => x.id === raw.tokenId);
    if (t) {
      const action: FixAction = {
        kind: "apply-paint-style",
        field,
        styleId: t.id,
        styleName: t.name,
      };
      return { text, action };
    }
  } else if (raw.matchKind === "textStyle") {
    const t = catalog.textStyles.find((x) => x.id === raw.tokenId);
    if (t) {
      const action: FixAction = {
        kind: "apply-text-style",
        styleId: t.id,
        styleName: t.name,
      };
      return { text, action };
    }
  }

  // 매칭이 안 됐거나(none) 모델이 없는 id를 지어낸 경우:
  // 색상이면 항상 "새 변수 생성" 버튼을 제공한다 (이름은 모델 제안 → 없으면 hex 기반).
  // rationale은 항상 우리 고정 문구를 쓴다 — 모델이 "가장 가까운 이름입니다" 같은 말을 붙이면
  // 방금 지어낸 새 이름을 마치 기존 토큰인 것처럼 오해하게 만들어서 신뢰하지 않는다.
  if (v.fix && v.fix.kind === "color") {
    const name = (raw.newName && raw.newName.trim()) || defaultColorName(v.fix.hex);
    return {
      text: `일치하는 토큰이 없어요. 새 변수 ${name} 를 만들어 연결할 수 있어요.`,
      action: { kind: "create-variable", field: v.fix.field, tokenName: name, hex: v.fix.hex },
    };
  }

  // 타이포도 마찬가지로 "새 텍스트 스타일 생성" 버튼을 제공한다 (mixed는 폰트가 하나로 안 정해져서 제외).
  if (v.fix && v.fix.kind === "typography" && v.fix.family && v.fix.style && v.fix.size) {
    const name =
      (raw.newName && raw.newName.trim()) ||
      defaultTypographyName(v.fix.family, v.fix.style, v.fix.size);
    return {
      text: `일치하는 텍스트 스타일이 없어요. 새 스타일 ${name} 를 만들어 적용할 수 있어요.`,
      action: {
        kind: "create-text-style",
        tokenName: name,
        family: v.fix.family,
        style: v.fix.style,
        size: v.fix.size,
        lineHeight: v.fix.lineHeight,
        letterSpacing: v.fix.letterSpacing,
      },
    };
  }

  // 그 외(mixed 등 자동 생성이 애매한 경우)는 조언 텍스트만.
  return { text };
}

/** Fallback variable name when the model didn't suggest one, e.g. "color/ffffff". */
function defaultColorName(hex: string): string {
  return `color/${hex.replace("#", "").toLowerCase()}`;
}

/** Fallback text style name when the model didn't suggest one, e.g. "text/inter-regular-16". */
function defaultTypographyName(family: string, style: string, size: number): string {
  const slug = `${family}-${style}`.toLowerCase().replace(/\s+/g, "-");
  return `text/${slug}-${size}`;
}

/**
 * Exact match resolved locally — no API call needed. Covers the common case
 * (raw color equals an existing token's hex, or font equals a text style).
 */
function localMatch(v: Violation, catalog: TokenCatalog): Recommendation | null {
  if (v.fix && v.fix.kind === "color") {
    const hex = v.fix.hex.toUpperCase();
    const varT = catalog.colorVariables.find((t) => (t.hex || "").toUpperCase() === hex);
    if (varT) {
      return {
        text: `동일한 색(${hex}) 변수 ${varT.name} 가 있어요.`,
        action: {
          kind: "bind-variable",
          field: v.fix.field,
          variableId: varT.id,
          tokenName: varT.name,
          hex: v.fix.hex,
        },
      };
    }
    const styT = catalog.paintStyles.find((t) => (t.hex || "").toUpperCase() === hex);
    if (styT) {
      return {
        text: `동일한 색(${hex}) 스타일 ${styT.name} 이 있어요.`,
        action: { kind: "apply-paint-style", field: v.fix.field, styleId: styT.id, styleName: styT.name },
      };
    }
    // 정확히 일치하는 토큰이 없으면 로컬에서 억지로 추측하지 않고 AI에게 넘긴다.
  } else if (v.fix && v.fix.kind === "typography") {
    const summary = v.fix.summary;
    const t = catalog.textStyles.find((s) => (s.summary || "") === summary);
    if (t) {
      return {
        text: `동일한 텍스트 스타일 ${t.name} 이 있어요.`,
        action: { kind: "apply-text-style", styleId: t.id, styleName: t.name },
      };
    }
    // 정확히 일치하는 스타일이 없으면 로컬에서 억지로 추측하지 않고 AI에게 넘긴다.
  }
  return null;
}

const SPELLING_CHUNK = 20; // texts per request

interface RawSpellingResult {
  index: number;
  hasError: boolean;
  corrected?: string;
  note?: string;
}

const SPELLING_SYSTEM = `너는 한국어/영어 맞춤법·띄어쓰기 검사기야. 주어진 텍스트 목록 각각을 검사해.
규칙:
- 오탈자(맞춤법)와 띄어쓰기 오류만 잡는다. 주어-서술어 호응, 문장 구조, 어색한 표현 같은 문법·문체 문제는 오류로 보지 않는다.
- 오류가 없으면 hasError=false만 반환한다.
- 오류가 있으면 hasError=true로 하고, corrected에 교정된 전체 텍스트를 넣는다. note엔 무엇이 잘못됐는지 한국어 한 줄로 짧게 설명하되, 아직 고쳐지지 않은 상태이므로 "~했습니다"처럼 이미 고친 것처럼 쓰지 말고 반드시 "~이 필요합니다"/"~가 필요합니다" 형태로 끝낸다(예: "쉼표 앞 띄어쓰기가 필요합니다.").
- 디자인 토큰 이름, 코드/변수명, 고유명사, 영문 약어, 숫자·기호만으로 된 텍스트는 오류로 판단하지 않는다.
- "&"는 그대로 둔다. "&"를 "및"이나 다른 말로 바꾸라는 교정은 하지 않는다.
- 오직 JSON만 출력한다.`;

function spellingBlock(items: SpellingCandidate[]): string {
  return items.map((c, i) => `  ${i}: "${c.text}"`).join("\n");
}

/** True if the only difference is the model swapping "&" for "및" (or vice versa) — not a real error. */
function isAmpersandOnlyChange(original: string, corrected: string): boolean {
  const normalize = (s: string) => s.replace(/&|및/g, "&");
  return normalize(original) === normalize(corrected);
}

async function callSpellingChunk(
  apiKey: string,
  items: SpellingCandidate[]
): Promise<RawSpellingResult[]> {
  const user = `텍스트 목록:\n${spellingBlock(items)}\n\n다음 형식의 JSON만 출력해:\n{"results":[{"index":0,"hasError":false},{"index":1,"hasError":true,"corrected":"...","note":"..."}]}`;

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SPELLING_SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e) {
    throw new Error(
      "맞춤법 검사 요청 실패. 대부분 API 키 오류(401)입니다 — ⚙에서 올바른 sk-... 키를 다시 저장하세요. (" +
        (e instanceof Error ? e.message : String(e)) +
        ")"
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content);
  const arr = Array.isArray(parsed) ? parsed : parsed.results;
  return Array.isArray(arr) ? (arr as RawSpellingResult[]) : [];
}

/**
 * Spell-check every candidate text node in parallel chunks. Only texts the model
 * flags as actually wrong come back as violations (with the correction attached
 * as a ready-to-apply fix) — clean text produces no violation at all.
 * `onPartial` is called per finished chunk so the UI can render progressively.
 */
export async function checkSpelling(
  apiKey: string,
  candidates: SpellingCandidate[],
  onPartial?: (violations: Violation[]) => void
): Promise<Violation[]> {
  const out: Violation[] = [];
  const chunks: SpellingCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += SPELLING_CHUNK) {
    chunks.push(candidates.slice(i, i + SPELLING_CHUNK));
  }

  await Promise.all(
    chunks.map(async (slice) => {
      const raws = await callSpellingChunk(apiKey, slice);
      const byIndex = new Map<number, RawSpellingResult>();
      for (const r of raws) byIndex.set(r.index, r);
      const found: Violation[] = [];
      slice.forEach((c, idx) => {
        const raw = byIndex.get(idx);
        if (
          raw &&
          raw.hasError &&
          raw.corrected &&
          raw.corrected !== c.text &&
          !isAmpersandOnlyChange(c.text, raw.corrected)
        ) {
          found.push({
            nodeId: c.nodeId,
            nodeName: c.nodeName,
            nodeType: c.nodeType,
            type: "spelling",
            message: raw.note || "맞춤법 수정이 필요합니다.",
            detail: `"${c.text}" → "${raw.corrected}"`,
            fix: { kind: "spelling", original: c.text, corrected: raw.corrected },
          });
        }
      });
      out.push(...found);
      if (onPartial && found.length > 0) onPartial(found);
    })
  );

  return out;
}

/**
 * Get recommendations for every fixable violation. Exact matches are resolved
 * locally (instant, no API); the rest go to the model in PARALLEL chunks.
 * `onPartial` is called as results arrive so the UI can render progressively.
 */
export async function getRecommendations(
  apiKey: string,
  violations: Violation[],
  catalog: TokenCatalog,
  onPartial?: (recs: Record<string, Recommendation>) => void
): Promise<Record<string, Recommendation>> {
  const fixable = violations.filter((v) => v.fix);
  const out: Record<string, Recommendation> = {};

  // 1) 즉시 해결되는 정확 매칭은 로컬에서 처리하고 바로 표시.
  const needAi: Violation[] = [];
  for (const v of fixable) {
    const local = localMatch(v, catalog);
    if (local) out[violationKey(v)] = local;
    else needAi.push(v);
  }
  if (onPartial && Object.keys(out).length > 0) onPartial({ ...out });
  if (needAi.length === 0) return out;

  // 2) 나머지는 병렬 청크 호출. 먼저 끝나는 청크부터 onPartial 로 흘려보냄.
  const chunks: Violation[][] = [];
  for (let i = 0; i < needAi.length; i += CHUNK) chunks.push(needAi.slice(i, i + CHUNK));

  await Promise.all(
    chunks.map(async (slice) => {
      const raws = await callChunk(apiKey, slice, catalog);
      const byIndex = new Map<number, RawRec>();
      for (const r of raws) byIndex.set(r.index, r);
      slice.forEach((v, idx) => {
        const raw = byIndex.get(idx);
        if (raw) out[violationKey(v)] = toRecommendation(raw, v, catalog);
      });
      if (onPartial) onPartial({ ...out });
    })
  );

  return out;
}
