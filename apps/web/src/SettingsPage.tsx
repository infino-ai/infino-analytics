import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getEmbedding, saveEmbedding, testEmbedding, type EmbeddingProbe, type EmbeddingSettings } from "./api";

// The embedder the agent's semantic and hybrid search use. A model that doesn't
// match the table's vectors gives wrong results without any error, so test first.
export default function SettingsPage() {
  const [current, setCurrent] = useState<EmbeddingSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [expectedDims, setExpectedDims] = useState("");
  const [probe, setProbe] = useState<EmbeddingProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    getEmbedding()
      .then((s) => {
        setCurrent(s);
        setBaseUrl(s.embedding?.baseUrl ?? "");
        setModel(s.embedding?.model ?? "");
      })
      .catch((e: Error) => setMessage(e.message));
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onTest = () =>
    run(async () => {
      setProbe(null);
      setProbe(await testEmbedding({ baseUrl, model, expectedDims: Number(expectedDims) || undefined }));
    });
  const onSave = () =>
    run(async () => {
      setCurrent(await saveEmbedding({ baseUrl, model }));
      setMessage("Saved. Fino uses this embedder from the next question, or after a restart if its harness starts the search server once.");
    });
  const onReset = () =>
    run(async () => {
      setCurrent(await saveEmbedding(null));
      setBaseUrl("");
      setModel("");
      setProbe(null);
      setMessage("Reset. Fino uses the search server's built-in model.");
    });

  return (
    <div className="page settings">
      <h2>Embedding model</h2>
      <p className="pagenote">
        Fino embeds the question with this model for semantic and hybrid search. It must be the model that built the
        table's vectors. Any endpoint that serves <code>POST /embeddings</code> works; for a TEI server, the base URL
        ends in <code>/v1</code>. With nothing set, Fino uses the search server's built-in model (all-MiniLM-L6-v2,
        384 dimensions).
      </p>
      <p className="pagenote">
        Now using:{" "}
        {current === null ? "…" : current.embedding ? `${current.embedding.model} at ${current.embedding.baseUrl}` : "the built-in model (all-MiniLM-L6-v2)"}
        {current?.apiKeySet ? " (API key set on the server)" : ""}
      </p>
      <label>
        Base URL
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://embeddings.example.com/v1" />
      </label>
      <label>
        Model
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model name" />
      </label>
      <label>
        Table vector size (optional)
        <Input
          value={expectedDims}
          onChange={(e) => setExpectedDims(e.target.value)}
          inputMode="numeric"
          placeholder="Vector size of the table"
        />
      </label>
      <div className="settingsactions">
        <Button variant="outline" onClick={onTest} disabled={busy || !baseUrl || !model}>
          Test
        </Button>
        <Button onClick={onSave} disabled={busy || !baseUrl || !model}>
          Save
        </Button>
        <Button variant="ghost" onClick={onReset} disabled={busy || !current?.embedding}>
          Reset to built-in
        </Button>
      </div>
      {probe && (
        <p className={probe.ok ? "probe ok" : "probe fail"} role="status">
          {probe.ok
            ? `Pass: ${probe.dims}-dimensional vectors in ${probe.ms} ms`
            : `Fail: ${probe.error}${probe.dims ? ` (${probe.dims} dims)` : ""}`}
        </p>
      )}
      {message && (
        <p className="pagenote" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
