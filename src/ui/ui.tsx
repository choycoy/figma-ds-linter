import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  PluginToUi,
  UiToPlugin,
  Violation,
  ViolationType,
  ScanScope,
} from "../shared";
import "./ui.css";

function postToPlugin(msg: UiToPlugin) {
  parent.postMessage({ pluginMessage: msg }, "*");
}

const TYPE_LABEL: Record<ViolationType, string> = {
  color: "색상",
  typography: "타이포그래피",
  detached: "Detached/Override",
};

const TYPE_ORDER: ViolationType[] = ["color", "typography", "detached"];

function App() {
  const [scope, setScope] = useState<ScanScope>("page");
  const [checks, setChecks] = useState<Record<ViolationType, boolean>>({
    color: true,
    typography: true,
    detached: true,
  });
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [violations, setViolations] = useState<Violation[] | null>(null);
  const [scannedCount, setScannedCount] = useState(0);
  const [filter, setFilter] = useState<ViolationType | "all">("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data.pluginMessage as PluginToUi | undefined;
      if (!msg) return;
      switch (msg.type) {
        case "scan-started":
          setScanning(true);
          setProgress(0);
          setError(null);
          break;
        case "scan-progress":
          setProgress(msg.scanned);
          break;
        case "scan-result":
          setScanning(false);
          setViolations(msg.violations);
          setScannedCount(msg.scannedCount);
          break;
        case "error":
          setScanning(false);
          setError(msg.message);
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const counts = useMemo(() => {
    const c: Record<ViolationType, number> = { color: 0, typography: 0, detached: 0 };
    (violations || []).forEach((v) => (c[v.type] += 1));
    return c;
  }, [violations]);

  const visible = useMemo(() => {
    if (!violations) return [];
    return filter === "all" ? violations : violations.filter((v) => v.type === filter);
  }, [violations, filter]);

  const runScan = () => {
    if (!checks.color && !checks.typography && !checks.detached) {
      setError("최소 한 가지 검사 항목을 선택하세요.");
      return;
    }
    postToPlugin({ type: "scan", scope, checks });
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Design System Linter</h1>
        <p className="subtitle">Figma 변수·스타일 기준으로 위반 항목을 찾습니다.</p>
      </header>

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
          {scanning ? `검사 중… (${progress})` : "검사 실행"}
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
        {visible.map((v, i) => (
          <button
            key={`${v.nodeId}-${v.type}-${i}`}
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
        ))}
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
