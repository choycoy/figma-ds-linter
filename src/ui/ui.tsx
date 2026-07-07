import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  PluginToUi,
  UiToPlugin,
  Violation,
  ViolationType,
  ScanScope,
  TokenCatalog,
  Recommendation,
  FixAction,
  SpellingCandidate,
} from "../shared";
import { getRecommendations, checkSpelling, violationKey } from "../ai";
import "./ui.css";

function postToPlugin(msg: UiToPlugin) {
  parent.postMessage({ pluginMessage: msg }, "*");
}

const TYPE_LABEL: Record<ViolationType, string> = {
  color: "색상",
  typography: "타이포그래피",
  spelling: "맞춤법",
};

const TYPE_ORDER: ViolationType[] = ["color", "typography", "spelling"];

const EMPTY_CATALOG: TokenCatalog = {
  colorVariables: [],
  paintStyles: [],
  textStyles: [],
};

function App() {
  const [scope, setScope] = useState<ScanScope>("page");
  const [checks, setChecks] = useState<Record<ViolationType, boolean>>({
    color: true,
    typography: true,
    spelling: true,
  });
  const [scanning, setScanning] = useState(false);
  const [violations, setViolations] = useState<Violation[] | null>(null);
  const [scannedCount, setScannedCount] = useState(0);
  const [filter, setFilter] = useState<ViolationType | "all">("all");
  const [error, setError] = useState<string | null>(null);

  // AI / recommendations
  const [catalog, setCatalog] = useState<TokenCatalog>(EMPTY_CATALOG);
  const [recs, setRecs] = useState<Record<string, Recommendation>>({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDone, setAiDone] = useState(0);
  const [aiTotal, setAiTotal] = useState(0);
  const [aiError, setAiError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  // 적용 중인 색상(hex). 같은 색을 쓰는 위반 항목들을 한꺼번에 '적용 중'으로 표시하기 위함.
  const [applyingHex, setApplyingHex] = useState<string | null>(null);
  // 사용자가 직접 입력한 색상 변수 이름(create-variable 액션별). 비어 있으면 AI 추천값 사용.
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const pendingKeyRef = useRef<string | null>(null);
  const violationsRef = useRef<Violation[] | null>(null);
  // 색상·타이포 AI 추천을 이미 처리한 비-맞춤법 위반 개수. 맞춤법 결과가 뒤늦게 도착해
  // violations를 갱신할 때 추천을 불필요하게 다시 돌리지 않기 위한 가드.
  const aiProcessedCountRef = useRef(-1);
  // 체크박스로 묶어서 "같은 액션 일괄 적용"할 대상들. 처리 중엔 ref(핸들러용)+state(스피너 표시용) 둘 다 채움.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkApplyingKeys, setBulkApplyingKeys] = useState<Set<string>>(new Set());
  const bulkKeysRef = useRef<Set<string>>(new Set());
  // 체크된 항목 전체에 한 번에 넣을 이름(선택 상태 바의 공용 입력창).
  const [bulkNameDraft, setBulkNameDraft] = useState("");
  // 검사가 순식간에 끝나도 스피너가 최소 이 시간(ms)만큼은 보이도록.
  const scanStartRef = useRef<number>(0);
  const MIN_SPINNER_MS = 450;
  const [notice, setNotice] = useState<string | null>(null);

  // message 핸들러(빈 deps)가 최신 violations를 읽도록 ref로 동기화.
  useEffect(() => {
    violationsRef.current = violations;
  }, [violations]);

  // OpenAI API 키는 각 사용자가 ⚙에서 직접 입력해 figma.clientStorage(이 기기 로컬)에 저장한다 —
  // 배포된 번들에 키를 박아두면 누구나 파일을 열어 추출할 수 있어 절대 하드코딩하지 않는다.
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  // 메시지 핸들러(마운트 시 한 번만 등록)가 항상 최신 키를 읽도록 ref로 동기화 — apiKey state를
  // 직접 클로저로 캡처하면, 사용자가 나중에 키를 새로 저장해도 핸들러엔 마운트 시점의(대부분
  // null인) 값이 그대로 남아 계속 "키 없음"으로 실패하게 된다.
  const apiKeyRef = useRef<string | null>(null);
  useEffect(() => {
    apiKeyRef.current = apiKey;
  }, [apiKey]);
  const [showSettings, setShowSettings] = useState(false);

  // 카드 템플릿 (색상 스와치 카드 / 타이포 샘플 카드, 각각 별도)
  const [cardTemplate, setCardTemplate] = useState<{ color: string | null; typography: string | null }>(
    { color: null, typography: null }
  );
  const [generating, setGenerating] = useState<"color" | "typography" | null>(null);
  const [genMsg, setGenMsg] = useState<string | null>(null);

  // 토큰 수집 기준 프레임 (색상/타이포 각각, 설정 안 하면 현재 페이지 전체를 훑음)
  const [tokenSource, setTokenSource] = useState<{ color: string | null; typography: string | null }>(
    { color: null, typography: null }
  );

  useEffect(() => {
    postToPlugin({ type: "get-card-template", kind: "color" });
    postToPlugin({ type: "get-card-template", kind: "typography" });
    postToPlugin({ type: "get-token-source", kind: "color" });
    postToPlugin({ type: "get-token-source", kind: "typography" });
    postToPlugin({ type: "get-api-key" });
    const handler = (e: MessageEvent) => {
      const msg = e.data.pluginMessage as PluginToUi | undefined;
      if (!msg) return;
      switch (msg.type) {
        case "scan-started":
          setScanning(true);
          setError(null);
          setRecs({});
          setApplied(new Set());
          setAiError(null);
          aiProcessedCountRef.current = -1;
          break;
        case "scan-progress":
          break;
        case "scan-result": {
          const result = msg;
          const elapsed = Date.now() - scanStartRef.current;
          const finish = () => {
            setScanning(false);
            setViolations(result.violations);
            setScannedCount(result.scannedCount);
            setCatalog(result.catalog);
            if (result.spellingCandidates.length > 0) {
              runSpellCheck(result.spellingCandidates);
            }
          };
          // 검사가 너무 빨리 끝났으면 스피너를 잠깐 더 보여주고 결과를 반영.
          if (elapsed < MIN_SPINNER_MS) {
            setTimeout(finish, MIN_SPINNER_MS - elapsed);
          } else {
            finish();
          }
          break;
        }
        case "card-template":
          setCardTemplate((prev) => ({ ...prev, [msg.kind]: msg.name }));
          break;
        case "token-source":
          setTokenSource((prev) => ({ ...prev, [msg.kind]: msg.name }));
          break;
        case "api-key":
          setApiKey(msg.key);
          break;
        case "generate-result":
          setGenerating(null);
          setGenMsg(msg.message);
          break;
        case "apply-result": {
          setNotice(msg.message);
          const pk = pendingKeyRef.current;
          const bulkKeys = bulkKeysRef.current;
          if (msg.ok) {
            const touched = new Set(msg.appliedNodeIds || []);
            setApplied((prev) => {
              // 클릭한 항목 + 같은 색으로 함께 연결된 노드 + 체크박스로 묶어 일괄 적용한 항목을 '적용됨'으로.
              const next = new Set(prev);
              if (pk) next.add(pk);
              for (const k of bulkKeys) next.add(k);
              for (const v of violationsRef.current || []) {
                if (v.type === "color" && touched.has(v.nodeId)) next.add(violationKey(v));
              }
              return next;
            });
            if (bulkKeys.size > 0) {
              setSelected((prev) => {
                const next = new Set(prev);
                for (const k of bulkKeys) next.delete(k);
                return next;
              });
            }
          }
          pendingKeyRef.current = null;
          bulkKeysRef.current = new Set();
          setBulkApplyingKeys(new Set());
          setApplyingKey(null);
          setApplyingHex(null);
          break;
        }
        case "error":
          setScanning(false);
          setError(msg.message);
          pendingKeyRef.current = null;
          bulkKeysRef.current = new Set();
          setBulkApplyingKeys(new Set());
          setApplyingKey(null);
          setApplyingHex(null);
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const counts = useMemo(() => {
    const c: Record<ViolationType, number> = { color: 0, typography: 0, spelling: 0 };
    (violations || []).forEach((v) => (c[v.type] += 1));
    return c;
  }, [violations]);

  const visible = useMemo(() => {
    if (!violations) return [];
    return filter === "all" ? violations : violations.filter((v) => v.type === filter);
  }, [violations, filter]);

  const runScan = () => {
    if (!checks.color && !checks.typography && !checks.spelling) {
      setError("최소 한 가지 검사 항목을 선택하세요.");
      return;
    }
    // 왕복 지연 없이 클릭 즉시 로딩 상태로 전환 (scan-started 메시지를 기다리지 않음).
    setScanning(true);
    setError(null);
    scanStartRef.current = Date.now();
    postToPlugin({ type: "scan", scope, checks });
  };

  // silent=true(검사 직후 자동 실행)일 땐 키/프레임 미설정·추천 대상 없음 같은 경우 조용히
  // 넘어간다 — 매번 스캔할 때마다 설정 패널이 튀어나오면 성가시니, 그런 안내는 사용자가
  // 직접 "AI 추천 받기"를 눌렀을 때만 보여준다.
  const runRecommendations = async (
    list: Violation[],
    cat: TokenCatalog,
    opts?: { silent?: boolean }
  ) => {
    const silent = opts?.silent ?? false;
    if (!apiKey) {
      if (!silent) {
        setShowSettings(true);
        setAiError("먼저 ⚙ 설정에서 OpenAI API 키를 입력하세요.");
      }
      return;
    }
    if (!tokenSource.color || !tokenSource.typography) {
      if (!silent) {
        setShowSettings(true);
        setAiError("먼저 ⚙ 설정에서 색상·타이포 기준 프레임을 지정하세요.");
      }
      return;
    }
    const fixable = list.filter((v) => v.fix);
    if (fixable.length === 0) {
      if (!silent) setAiError("AI가 추천할 수 있는(색상·타이포) 항목이 없습니다.");
      return;
    }
    setAiLoading(true);
    setAiError(null);
    setAiDone(0);
    setAiTotal(fixable.length);
    try {
      const result = await getRecommendations(apiKey, fixable, cat, (partial) => {
        // 먼저 끝난 것부터 즉시 표시 (전체를 기다리지 않음).
        setRecs((prev) => ({ ...prev, ...partial }));
        setAiDone(Object.keys(partial).length);
      });
      setRecs((prev) => ({ ...prev, ...result }));
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  };

  // 맞춤법 위반은 색상/타이포용 추천 엔드포인트로 보내지 않는다 — 이미 자체 교정 액션을
  // 갖고 있고(runSpellCheck), 저기로 넘기면 색상/타이포 매칭 로직이 액션 없는 조언으로 덮어써버린다.
  const runAi = () => runRecommendations(visible.filter((v) => v.type !== "spelling"), catalog);

  // 검사 결과가 들어올 때마다(= violations가 바뀔 때) 색상·타이포 AI 추천을 자동으로 받아온다.
  // 맞춤법 결과는 뒤늦게 하나씩 도착해 violations를 계속 갱신하는데(runSpellCheck), 그때마다
  // 이 effect가 다시 돌면 이미 처리한 색상·타이포 항목까지 API를 반복 호출하게 된다 — 그래서
  // "처리한 비-맞춤법 항목 개수"를 기록해두고, 그 개수가 그대로면(=맞춤법만 추가된 것) 건너뛴다.
  useEffect(() => {
    if (!violations) return;
    const nonSpelling = violations.filter((v) => v.type !== "spelling");
    if (nonSpelling.length === aiProcessedCountRef.current) return;
    aiProcessedCountRef.current = nonSpelling.length;
    runRecommendations(nonSpelling, catalog, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [violations]);

  // 맞춤법 검사는 색상/타이포와 달리 후보(텍스트)가 곧 위반 여부를 모르는 상태로 넘어온다 —
  // 색상/타이포처럼 "이미 확정된 위반에 대한 추천"이 아니라, OpenAI 응답 자체가 위반인지
  // 아닌지를 결정한다. 그래서 결과를 violations에 직접 추가하고, 교정 액션도 recs에 바로
  // 채워 넣어(추가 추천 단계 없이) 다른 항목들과 동일한 "적용" 버튼 UI를 그대로 재사용한다.
  const runSpellCheck = async (candidates: SpellingCandidate[]) => {
    // finish()가 마운트 시 한 번만 등록되는 메시지 핸들러 안에서 호출되므로, apiKey state를
    // 직접 클로저로 읽으면 항상 마운트 시점 값(대개 null)만 보게 된다 — ref로 최신값을 읽는다.
    const key = apiKeyRef.current;
    if (!key || candidates.length === 0) return;
    try {
      await checkSpelling(key, candidates, (found) => {
        setViolations((prev) => [...(prev || []), ...found]);
        setRecs((prev) => {
          const next = { ...prev };
          for (const v of found) {
            if (v.fix && v.fix.kind === "spelling") {
              next[violationKey(v)] = {
                text: v.message,
                action: { kind: "apply-spelling", original: v.fix.original, corrected: v.fix.corrected },
              };
            }
          }
          return next;
        });
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    }
  };

  // 체크박스로 같은 검사 종류(색상/타이포)를 묶은 다른 위반들. 이 항목 자신은 제외.
  const bulkPartners = (v: Violation): Violation[] =>
    visible.filter(
      (other) => other !== v && other.type === v.type && other.fix && selected.has(violationKey(other))
    );

  // 체크박스로 묶인 항목이 있으면 apply-bulk(같은 액션을 여러 노드에), 없으면 기존처럼 단건 apply.
  const dispatchApply = (v: Violation, action: FixAction) => {
    const partners = bulkPartners(v);
    if (partners.length > 0) {
      const keys = new Set([violationKey(v), ...partners.map(violationKey)]);
      bulkKeysRef.current = keys;
      setBulkApplyingKeys(keys);
      setApplyingKey("__bulk__");
      postToPlugin({ type: "apply-bulk", nodeIds: [v.nodeId, ...partners.map((p) => p.nodeId)], action });
    } else {
      pendingKeyRef.current = violationKey(v);
      setApplyingKey(violationKey(v));
      postToPlugin({ type: "apply", nodeId: v.nodeId, action });
    }
  };

  const applyRec = (v: Violation, rec: Recommendation) => {
    if (!rec.action || applyingKey) return; // 진행 중엔 중복 클릭 무시
    // 색상 연결(bind/create)은 같은 색 노드를 모두 건드리므로 hex도 기록.
    if (rec.action.kind === "bind-variable" || rec.action.kind === "create-variable") {
      setApplyingHex(rec.action.hex);
    }
    dispatchApply(v, rec.action);
  };

  // 직접 입력한 이름으로 색상 변수를 만들어 같은 색 노드에 연결 + 스와치 카드 추가.
  // 체크박스로 다른 색상 위반을 함께 묶었으면, 그 노드들에도 같은 새 변수를 연결한다.
  const applyCreate = (
    v: Violation,
    action: Extract<FixAction, { kind: "create-variable" }>
  ) => {
    if (applyingKey) return; // 진행 중엔 중복 클릭 무시
    const key = violationKey(v);
    const name = (nameDrafts[key] ?? action.tokenName).trim();
    if (!name) return; // 빈 이름으로는 변수를 만들지 않음
    setApplyingHex(action.hex); // 같은 색 항목을 함께 '적용 중'으로 표시
    dispatchApply(v, { ...action, tokenName: name });
  };

  // 직접 입력한 이름으로 텍스트 스타일을 만들어 이 노드에 적용.
  // 체크박스로 다른 타이포 위반을 함께 묶었으면, 그 노드들에도 같은 새 스타일을 적용한다.
  const applyCreateText = (
    v: Violation,
    action: Extract<FixAction, { kind: "create-text-style" }>
  ) => {
    if (applyingKey) return; // 진행 중엔 중복 클릭 무시
    const key = violationKey(v);
    const name = (nameDrafts[key] ?? action.tokenName).trim();
    if (!name) return; // 빈 이름으로는 스타일을 만들지 않음
    dispatchApply(v, { ...action, tokenName: name });
  };

  // 체크된 항목들(같은 종류일 때만) — 선택 상태 바의 공용 이름 입력에 쓰인다.
  const selectedFixable = useMemo(
    () => visible.filter((v) => v.fix && selected.has(violationKey(v))),
    [visible, selected]
  );
  const selectedTypeSet = useMemo(
    () => new Set(selectedFixable.map((v) => v.type)),
    [selectedFixable]
  );
  const bulkNameType: ViolationType | null =
    selectedTypeSet.size === 1 ? [...selectedTypeSet][0] : null;

  // 선택 상태 바에서 이름 하나만 입력해 체크된 항목 전체에 새 변수/스타일을 만들어 적용.
  // (개별 항목마다 이름을 입력할 필요 없이, 여러 항목을 한 번에 새 토큰으로 묶고 싶을 때 사용)
  const applyBulkNamed = () => {
    if (applyingKey || !bulkNameType) return;
    const name = bulkNameDraft.trim();
    if (!name || selectedFixable.length === 0) return;

    let action: FixAction | null = null;
    if (bulkNameType === "color") {
      const base = selectedFixable.find((v) => v.fix && v.fix.kind === "color");
      if (base && base.fix && base.fix.kind === "color") {
        action = { kind: "create-variable", field: base.fix.field, tokenName: name, hex: base.fix.hex };
      }
    } else if (bulkNameType === "typography") {
      const base = selectedFixable.find(
        (v) => v.fix && v.fix.kind === "typography" && v.fix.family && v.fix.style && v.fix.size
      );
      if (base && base.fix && base.fix.kind === "typography" && base.fix.family && base.fix.style && base.fix.size) {
        action = {
          kind: "create-text-style",
          tokenName: name,
          family: base.fix.family,
          style: base.fix.style,
          size: base.fix.size,
          lineHeight: base.fix.lineHeight,
          letterSpacing: base.fix.letterSpacing,
        };
      }
    }
    if (!action) return;

    const keys = new Set(selectedFixable.map(violationKey));
    bulkKeysRef.current = keys;
    setBulkApplyingKeys(keys);
    setApplyingKey("__bulk__");
    if (action.kind === "create-variable") setApplyingHex(action.hex);
    postToPlugin({
      type: "apply-bulk",
      nodeIds: selectedFixable.map((v) => v.nodeId),
      action,
    });
    setBulkNameDraft("");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <h1>Design System Linter</h1>
          <button
            className={`gear ${apiKey && tokenSource.color && tokenSource.typography ? "" : "gear-warn"}`}
            title="설정"
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙
          </button>
        </div>
        <p className="subtitle">Figma 변수·스타일 기준으로 위반을 찾고 AI가 해결책을 추천합니다.</p>
      </header>

      {showSettings && (
        <section className="settings">
          <div className="settings-actions">
            <button className="link muted" onClick={() => setShowSettings(false)}>
              닫기
            </button>
          </div>

          <label className="settings-label">OpenAI API 키</label>
          <p className="settings-hint">
            AI 추천·맞춤법 검사에 쓰입니다. 이 기기에만 저장되며 OpenAI(api.openai.com)로만 전송됩니다.
          </p>
          <div className="settings-actions">
            <input
              className="key-input"
              type="password"
              placeholder={apiKey ? "새 키로 교체하려면 입력" : "sk-..."}
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiKeyDraft.trim()) {
                  postToPlugin({ type: "set-api-key", key: apiKeyDraft.trim() });
                  setApiKeyDraft("");
                }
              }}
            />
          </div>
          <div className="settings-actions">
            <button
              className="primary small"
              disabled={!apiKeyDraft.trim()}
              onClick={() => {
                postToPlugin({ type: "set-api-key", key: apiKeyDraft.trim() });
                setApiKeyDraft("");
              }}
            >
              저장
            </button>
            <span className="tpl-status">
              {apiKey ? `설정됨 (${apiKey.slice(0, 5)}…${apiKey.slice(-4)})` : "미설정"}
            </span>
            {apiKey && (
              <button
                className="link muted"
                onClick={() => postToPlugin({ type: "clear-api-key" })}
              >
                삭제
              </button>
            )}
          </div>

          <div className="settings-divider" />
          <label className="settings-label">스와치 카드 템플릿 (색상)</label>
          <p className="settings-hint">
            기존 디자인 시스템의 카드 1개를 캔버스에서 선택한 뒤 아래 버튼을 누르세요. 새 변수를
            만들면 이 카드를 복제해 같은 자리(같은 행)에 추가합니다.
          </p>
          <div className="settings-actions">
            <button
              className="primary small"
              onClick={() => postToPlugin({ type: "set-card-template", kind: "color" })}
            >
              선택한 카드를 템플릿으로 지정
            </button>
            <span className="tpl-status">
              {cardTemplate.color ? `현재: ${cardTemplate.color}` : "미지정"}
            </span>
          </div>

          <div className="settings-actions">
            <button
              className="primary small"
              disabled={generating !== null || !cardTemplate.color}
              onClick={() => {
                setGenMsg(null);
                setGenerating("color");
                postToPlugin({ type: "generate-all-cards", kind: "color" });
              }}
            >
              {generating === "color" ? "추가 중…" : "카드 없는 변수 추가"}
            </button>
            {genMsg && <span className="tpl-status">{genMsg}</span>}
          </div>
          {!cardTemplate.color && (
            <p className="settings-hint">템플릿을 먼저 지정해야 생성할 수 있어요.</p>
          )}

          <div className="settings-divider" />
          <label className="settings-label">타이포 샘플 카드 템플릿</label>
          <p className="settings-hint">
            기존 디자인 시스템의 텍스트 스타일 샘플 카드 1개를 선택한 뒤 지정하세요. 새 텍스트
            스타일을 만들면 이 카드를 복제해 실제 스타일이 적용된 샘플을 추가합니다.
          </p>
          <div className="settings-actions">
            <button
              className="primary small"
              onClick={() => postToPlugin({ type: "set-card-template", kind: "typography" })}
            >
              선택한 카드를 템플릿으로 지정
            </button>
            <span className="tpl-status">
              {cardTemplate.typography ? `현재: ${cardTemplate.typography}` : "미지정"}
            </span>
          </div>

          <div className="settings-actions">
            <button
              className="primary small"
              disabled={generating !== null || !cardTemplate.typography}
              onClick={() => {
                setGenMsg(null);
                setGenerating("typography");
                postToPlugin({ type: "generate-all-cards", kind: "typography" });
              }}
            >
              {generating === "typography" ? "추가 중…" : "카드 없는 스타일 추가"}
            </button>
            {genMsg && <span className="tpl-status">{genMsg}</span>}
          </div>
          {!cardTemplate.typography && (
            <p className="settings-hint">템플릿을 먼저 지정해야 생성할 수 있어요.</p>
          )}

          <div className="settings-divider" />
          <label className="settings-label">색상 기준 프레임</label>
          <div className="settings-actions">
            <button
              className="primary small"
              onClick={() => postToPlugin({ type: "set-token-source", kind: "color" })}
            >
              선택한 프레임으로 지정
            </button>
            <span className="tpl-status">
              {tokenSource.color ? `현재: ${tokenSource.color}` : "미지정 (현재 페이지 전체)"}
            </span>
            {tokenSource.color && (
              <button
                className="link muted"
                onClick={() => postToPlugin({ type: "clear-token-source", kind: "color" })}
              >
                해제
              </button>
            )}
          </div>

          <label className="settings-label">타이포 기준 프레임</label>
          <div className="settings-actions">
            <button
              className="primary small"
              onClick={() => postToPlugin({ type: "set-token-source", kind: "typography" })}
            >
              선택한 프레임으로 지정
            </button>
            <span className="tpl-status">
              {tokenSource.typography
                ? `현재: ${tokenSource.typography}`
                : "미지정 (현재 페이지 전체)"}
            </span>
            {tokenSource.typography && (
              <button
                className="link muted"
                onClick={() => postToPlugin({ type: "clear-token-source", kind: "typography" })}
              >
                해제
              </button>
            )}
          </div>
        </section>
      )}

      <section className="controls">
        <div className="scope">
          <label className={scope === "page" ? "seg active" : "seg"}>
            <input
              type="radio"
              name="scope"
              checked={scope === "page"}
              onChange={() => setScope("page")}
            />
            현재 페이지
          </label>
          <label className={scope === "selection" ? "seg active" : "seg"}>
            <input
              type="radio"
              name="scope"
              checked={scope === "selection"}
              onChange={() => setScope("selection")}
            />
            선택 영역
          </label>
        </div>

        <div className="checks">
          {TYPE_ORDER.map((t) => (
            <label key={t} className="check">
              <input
                type="checkbox"
                checked={checks[t]}
                onChange={(e) => setChecks({ ...checks, [t]: e.target.checked })}
              />
              {TYPE_LABEL[t]}
            </label>
          ))}
        </div>

        <button className="primary" onClick={runScan} disabled={scanning}>
          {scanning ? (
            <span className="applying">
              <span className="spinner spinner-onbrand" /> 검사 중…
            </span>
          ) : (
            "검사 실행"
          )}
        </button>
      </section>

      {error && <div className="error">{error}</div>}

      {violations && !scanning && (
        <section className="summary">
          <div className="summary-line">
            <span>
              <strong>{violations.length}</strong>개 위반 · {scannedCount}개 노드 검사됨
            </span>
            {visible.length > 0 && (
              <span className="summary-actions">
                <button
                  className="link"
                  onClick={() =>
                    postToPlugin({
                      type: "select-nodes",
                      nodeIds: [...new Set(visible.map((v) => v.nodeId))],
                    })
                  }
                >
                  전체 하이라이트
                </button>
                <button
                  className="link muted"
                  onClick={() => postToPlugin({ type: "clear-highlights" })}
                >
                  지우기
                </button>
              </span>
            )}
          </div>
          <div className="filters">
            <button
              className={filter === "all" ? "chip active" : "chip"}
              onClick={() => setFilter("all")}
            >
              전체 {violations.length}
            </button>
            {TYPE_ORDER.map((t) => (
              <button
                key={t}
                className={filter === t ? "chip active" : "chip"}
                onClick={() => setFilter(t)}
              >
                {TYPE_LABEL[t]} {counts[t]}
              </button>
            ))}
          </div>
          {visible.some((v) => v.fix) && (
            <div className="ai-bar">
              <button className="ai-btn" onClick={runAi} disabled={aiLoading}>
                {aiLoading
                  ? `AI 추천 생성 중… (${aiDone}/${aiTotal})`
                  : "✨ AI 추천 받기"}
              </button>
              {aiError && <span className="ai-error">{aiError}</span>}
              {notice && <span className="ai-notice">{notice}</span>}
            </div>
          )}
          {visible.some((v) => v.fix) && (
            <div className="selection-bar">
              {selected.size > 0 && (
                <div className="selection-bar-row">
                  <span>
                    {selected.size}개 체크됨 · 각 항목의 "적용" 버튼을 눌러도 함께 적용됩니다
                  </span>
                  <button className="link muted" onClick={() => setSelected(new Set())}>
                    선택 해제
                  </button>
                </div>
              )}
              {selected.size === 0 || bulkNameType ? (
                <div className="selection-bar-row">
                  <input
                    className="name-input"
                    placeholder={
                      bulkNameType === "typography" ? "text/heading-01" : "color/blue-900"
                    }
                    value={bulkNameDraft}
                    disabled={applyingKey !== null}
                    onChange={(e) => setBulkNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyBulkNamed();
                    }}
                  />
                  <button
                    className="apply-btn"
                    disabled={!bulkNameDraft.trim() || applyingKey !== null || selected.size === 0}
                    onClick={applyBulkNamed}
                  >
                    {selected.size > 0
                      ? `체크한 ${selected.size}개에 이 이름으로 적용`
                      : "체크박스로 항목을 먼저 선택하세요"}
                  </button>
                </div>
              ) : (
                <span className="selection-bar-hint">
                  색상·타이포를 섞어 체크하면 이름을 한 번에 넣을 수 없어요 — 종류를 맞춰 체크해주세요.
                </span>
              )}
            </div>
          )}
        </section>
      )}

      <section className="list">
        {violations && visible.length === 0 && (
          <div className="empty">
            {violations.length === 0
              ? "🎉 위반 사항이 없습니다."
              : "이 필터에 해당하는 항목이 없습니다."}
          </div>
        )}
        {visible.map((v, i) => {
          const key = violationKey(v);
          const rec = recs[key];
          const isApplied = applied.has(key);
          const itemHex = v.fix && v.fix.kind === "color" ? v.fix.hex : null;
          // 클릭한 항목 + 같은 색(hex)을 쓰는 모든 색상 위반 + 체크박스로 묶여 일괄 적용 중인 항목을 함께 '적용 중'으로 표시.
          const isApplying =
            applyingKey === key ||
            bulkApplyingKeys.has(key) ||
            (applyingHex !== null &&
              itemHex !== null &&
              itemHex.toUpperCase() === applyingHex.toUpperCase());
          // 색상 위반은 AI 추천이 없어도 직접 변수 이름을 입력해 만들 수 있다.
          const colorFix = v.fix && v.fix.kind === "color" ? v.fix : null;
          const recCreate =
            rec && rec.action && rec.action.kind === "create-variable" ? rec.action : null;
          const createAction: Extract<FixAction, { kind: "create-variable" }> | null = recCreate
            ? recCreate
            : colorFix
            ? { kind: "create-variable", field: colorFix.field, hex: colorFix.hex, tokenName: "" }
            : null;
          // 타이포 위반은 AI 추천이 없어도 직접 텍스트 스타일 이름을 입력해 만들 수 있다 (mixed는 제외).
          const typoFix =
            v.fix && v.fix.kind === "typography" && v.fix.family && v.fix.style && v.fix.size
              ? v.fix
              : null;
          const recCreateTypo =
            rec && rec.action && rec.action.kind === "create-text-style" ? rec.action : null;
          const createTypoAction: Extract<FixAction, { kind: "create-text-style" }> | null =
            recCreateTypo
              ? recCreateTypo
              : typoFix
              ? {
                  kind: "create-text-style",
                  tokenName: "",
                  family: typoFix.family as string,
                  style: typoFix.style as string,
                  size: typoFix.size as number,
                  lineHeight: typoFix.lineHeight,
                  letterSpacing: typoFix.letterSpacing,
                }
              : null;
          return (
            <div key={`${v.nodeId}-${v.type}-${i}`} className="item-wrap">
              <div className="item-row">
                {/* 맞춤법 교정은 항목마다 텍스트가 다 달라 같은 액션을 일괄 적용할 수 없다 — 체크박스 숨김. */}
                {v.fix && v.fix.kind !== "spelling" && (
                  <input
                    type="checkbox"
                    className="item-check"
                    title="다른 항목과 묶어서 같은 액션을 일괄 적용"
                    checked={selected.has(key)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                  />
                )}
                <button
                  className="item"
                  onClick={() => postToPlugin({ type: "select-node", nodeId: v.nodeId })}
                >
                  <span className={`badge badge-${v.type}`}>{TYPE_LABEL[v.type]}</span>
                  <span className="item-body">
                    <span className="item-name">{v.nodeName}</span>
                    <span className="item-msg">{v.message}</span>
                    {v.detail && <span className="item-detail">{v.detail}</span>}
                  </span>
                </button>
              </div>
              {rec && (
                <div className="rec">
                  <span className="rec-icon">💡</span>
                  <span className="rec-text">{rec.text}</span>
                  {rec.action &&
                    rec.action.kind !== "create-variable" &&
                    rec.action.kind !== "create-text-style" && (
                    <button
                      className="apply-btn"
                      disabled={isApplied || applyingKey !== null}
                      onClick={() => applyRec(v, rec)}
                    >
                      {isApplying ? (
                        <span className="applying">
                          <span className="spinner" />
                        </span>
                      ) : isApplied ? (
                        "✓ 적용됨"
                      ) : rec.action.kind === "bind-variable" ? (
                        `${rec.action.tokenName} 연결${bulkPartners(v).length > 0 ? ` (+${bulkPartners(v).length}개)` : ""}`
                      ) : rec.action.kind === "apply-paint-style" ? (
                        `${rec.action.styleName} 적용${bulkPartners(v).length > 0 ? ` (+${bulkPartners(v).length}개)` : ""}`
                      ) : rec.action.kind === "apply-spelling" ? (
                        `"${rec.action.corrected}"로 수정`
                      ) : (
                        `${rec.action.styleName} 적용${bulkPartners(v).length > 0 ? ` (+${bulkPartners(v).length}개)` : ""}`
                      )}
                    </button>
                  )}
                </div>
              )}
              {createAction && (
                <div className="create-row">
                  <input
                    className="name-input"
                    value={nameDrafts[key] ?? createAction.tokenName}
                    placeholder="color/blue-900"
                    disabled={isApplied || applyingKey !== null}
                    onChange={(e) => setNameDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyCreate(v, createAction);
                    }}
                  />
                  <button
                    className="apply-btn"
                    disabled={
                      isApplied ||
                      applyingKey !== null ||
                      !(nameDrafts[key] ?? createAction.tokenName).trim()
                    }
                    onClick={() => applyCreate(v, createAction)}
                  >
                    {isApplying ? (
                      <span className="applying">
                        <span className="spinner" /> 적용 중…
                      </span>
                    ) : isApplied ? (
                      "✓ 적용됨"
                    ) : (
                      `변수 만들고 + 카드 추가${bulkPartners(v).length > 0 ? ` (+${bulkPartners(v).length}개)` : ""}`
                    )}
                  </button>
                </div>
              )}
              {createTypoAction && (
                <div className="create-row">
                  <input
                    className="name-input"
                    value={nameDrafts[key] ?? createTypoAction.tokenName}
                    placeholder="text/heading-01"
                    disabled={isApplied || applyingKey !== null}
                    onChange={(e) => setNameDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyCreateText(v, createTypoAction);
                    }}
                  />
                  <button
                    className="apply-btn"
                    disabled={
                      isApplied ||
                      applyingKey !== null ||
                      !(nameDrafts[key] ?? createTypoAction.tokenName).trim()
                    }
                    onClick={() => applyCreateText(v, createTypoAction)}
                  >
                    {isApplying ? (
                      <span className="applying">
                        <span className="spinner" /> 적용 중…
                      </span>
                    ) : isApplied ? (
                      "✓ 적용됨"
                    ) : (
                      `텍스트 스타일 만들고 적용${bulkPartners(v).length > 0 ? ` (+${bulkPartners(v).length}개)` : ""}`
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

// 렌더 중 예외가 나도 흰 화면 대신 원인을 보여준다.
class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error("[ds-linter] UI crashed:", err, info);
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 16, fontSize: 12, color: "#f24822" }}>
          <strong>UI 오류</strong>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
            {this.state.err.message}
            {"\n"}
            {this.state.err.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// 임포트/런타임 단계에서 터지는 예외도 흰 화면이 되지 않게 화면에 찍는다.
window.addEventListener("error", (e) => {
  const root = document.getElementById("root");
  if (root && !root.hasChildNodes()) {
    root.innerHTML = `<pre style="padding:16px;color:#f24822;white-space:pre-wrap;font-size:12px">에러: ${
      e.message
    }\n${e.filename || ""}:${e.lineno || ""}</pre>`;
  }
});

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
