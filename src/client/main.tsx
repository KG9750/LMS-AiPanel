import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ApiEnvelope, SystemSnapshot } from "../shared/schemas";
import "./styles.css";

const queryClient = new QueryClient();

async function fetchGraph(): Promise<SystemSnapshot> {
  const response = await fetch("/api/graph");
  const envelope = (await response.json()) as ApiEnvelope<SystemSnapshot>;
  if (!envelope.ok) {
    throw new Error(envelope.error.message);
  }
  return envelope.data;
}

function App() {
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["graph"],
    queryFn: fetchGraph,
    refetchInterval: 15_000
  });

  if (isLoading) {
    return <div className="screen center">Loading AI stack snapshot...</div>;
  }

  if (error) {
    return <div className="screen center error">Failed to load graph: {(error as Error).message}</div>;
  }

  const snapshot = data!;
  const totals = summarize(snapshot);
  const driftPriority = snapshot.driftRecords.slice(0, 8);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">LMS-AiPanel</div>
        {["运行总览", "AI Tools", "Assistants", "Local Models", "Runtimes", "Skills", "MCP", "Config Center", "Audit Log"].map(
          (item, index) => (
            <button className={index === 0 ? "nav active" : "nav"} key={item}>
              <span className="nav-dot" />
              {item}
            </button>
          )
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>运行总览</h1>
            <p>localhost-only AI stack control plane</p>
          </div>
          <div className="top-actions">
            <span className="localhost">127.0.0.1</span>
            <button onClick={() => void refetch()}>{isFetching ? "Refreshing" : "Refresh"}</button>
          </div>
        </header>

        <section className="metrics">
          <Metric label="Resources" value={snapshot.nodes.length} />
          <Metric label="Edges" value={snapshot.edges.length} />
          <Metric label="Drift" value={snapshot.driftRecords.length} tone={snapshot.driftRecords.length ? "warn" : "ok"} />
          <Metric label="Adapters" value={snapshot.adapterRuns.length} />
          <Metric label="Running" value={totals.running} tone="ok" />
          <Metric label="Stopped" value={totals.stopped} tone="warn" />
        </section>

        <section className="content-grid">
          <div className="panel table-panel">
            <div className="panel-head">
              <h2>Resource Table</h2>
              <span>{snapshot.nodes.length} nodes</span>
            </div>
            <div className="resource-table">
              <div className="row header">
                <span>Resource</span>
                <span>Type</span>
                <span>State</span>
                <span>Adapter</span>
              </div>
              {snapshot.nodes.slice(0, 60).map((node) => (
                <div className="row" key={node.id}>
                  <span className="truncate">{node.label}</span>
                  <span>{node.type}</span>
                  <Status value={node.state} />
                  <span>{node.sourceAdapter}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel map-panel">
            <div className="panel-head">
              <h2>AI Stack Map</h2>
              <span>lightweight topology</span>
            </div>
            <div className="map">
              {snapshot.nodes.slice(0, 18).map((node) => (
                <div className={`map-node ${node.state}`} key={node.id}>
                  <strong>{node.label}</strong>
                  <small>{node.type}</small>
                </div>
              ))}
            </div>
          </div>

          <div className="panel drift-panel">
            <div className="panel-head">
              <h2>配置漂移</h2>
              <span>{driftPriority.length} highlighted</span>
            </div>
            {driftPriority.length === 0 ? (
              <p className="empty">No drift detected in the latest snapshot.</p>
            ) : (
              <div className="drift-list">
                {driftPriority.map((record) => (
                  <div className="drift" key={record.id}>
                    <strong>{record.status}</strong>
                    <span>{record.resourceId}</span>
                    <small>{record.evidence.join(" · ")}</small>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel adapter-panel">
            <div className="panel-head">
              <h2>Adapter Runs</h2>
              <span>isolated collectors</span>
            </div>
            <div className="adapter-list">
              {snapshot.adapterRuns.map((run) => (
                <div className="adapter-run" key={run.runId}>
                  <span>{run.adapterId}</span>
                  <Status value={run.status} />
                  <small>{run.durationMs ?? 0}ms {run.stale ? "stale" : ""}</small>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "ok" | "warn" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value}`}>{value}</span>;
}

function summarize(snapshot: SystemSnapshot) {
  return snapshot.nodes.reduce(
    (acc, node) => {
      if (node.state === "running") acc.running += 1;
      if (node.state === "stopped") acc.stopped += 1;
      return acc;
    },
    { running: 0, stopped: 0 }
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);

