import { useEffect, useState } from "react";
import { Download, Upload } from "lucide-react";

import { host, type ModuleConfigShape } from "@/client";
import { SectionCard, StatRow } from "@/ds/index";
import { useRpc, useWrite, invalidate } from "@/lib/use-rpc";
import { Failure, Loading } from "@/app/components/states";
import { DraftSenders } from "@/app/components/draft";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/**
 * The config, the resolver list, and the user's own data in a file they can
 * read.
 *
 * halfLifeDays and scoreScale are what the cached closeness scores are a cache
 * of, so the host recomputes every connection before a change to either one
 * counts as applied. That is why saving them can take a moment and why the
 * form says so.
 */

export function Settings() {
  const health = useRpc<never>(null);
  const [config, setConfig] = useState<ModuleConfigShape | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ silo: string; hostDb: string; tools: number } | null>(
    null,
  );

  useEffect(() => {
    void host
      .config()
      .then((answer) => setConfig(answer.config))
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : String(error)),
      );
    void host.health().then(setFiles).catch(() => setFiles(null));
  }, []);

  void health;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Everything here is local. Nothing in this app reaches the network by itself.
        </p>
      </header>

      {loadError ? (
        <p className="text-negative text-sm">The host would not give up its config: {loadError}</p>
      ) : null}

      {config === null ? <Loading lines={4} /> : <ScoringForm config={config} />}

      {config !== null ? <Resolvers config={config} /> : null}

      <ImportChat />

      <Transfer />

      <SectionCard title="The files" description="Two of them, one per owner.">
        {files === null ? (
          <p className="text-muted-foreground text-sm">The host is not answering.</p>
        ) : (
          <div className="space-y-1">
            <StatRow label="Silo" value={<code className="text-xs">{files.silo}</code>} />
            <StatRow label="Host" value={<code className="text-xs">{files.hostDb}</code>} />
            <StatRow label="Tools" value={files.tools} />
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function ScoringForm({ config }: { config: ModuleConfigShape }) {
  const [halfLife, setHalfLife] = useState(String(config.halfLifeDays));
  const [scale, setScale] = useState(String(config.scoreScale));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed =
    Number(halfLife) !== config.halfLifeDays || Number(scale) !== config.scoreScale;

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/host/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          halfLifeDays: Number(halfLife),
          scoreScale: Number(scale),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The host answered ${response.status}`);
      }
      setSaved(true);
      // Every cached score just moved.
      invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard
      title="Closeness"
      description="contribution = sentiment x weight x 0.5 ^ (days / halfLife), then scaled and clamped to -100..100."
      footer={
        <div className="flex items-center gap-2">
          <Button disabled={!changed || saving} onClick={() => void save()}>
            {saving ? "Recomputing every connection" : "Save"}
          </Button>
          {saved ? <span className="text-positive text-sm">Saved and recomputed.</span> : null}
          {error ? <span className="text-negative text-sm">{error}</span> : null}
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="half-life">Half life, in days</Label>
          <Input
            id="half-life"
            type="number"
            min={30}
            max={1095}
            value={halfLife}
            onChange={(event) => setHalfLife(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            Six months by default, so an argument two years ago barely registers.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="score-scale">Scale</Label>
          <Input
            id="score-scale"
            type="number"
            min={1}
            max={50}
            value={scale}
            onChange={(event) => setScale(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            5 by default, so a dense friendship lands on the scale instead of pinning to the
            ceiling.
          </p>
        </div>
      </div>
      <p className="text-muted-foreground pt-2 text-xs">
        Changing either one makes every cached score wrong, so the host rebuilds all of them
        before the new value counts as applied.
      </p>
    </SectionCard>
  );
}

function Resolvers({ config }: { config: ModuleConfigShape }) {
  const write = useWrite<{ resolvers: ModuleConfigShape["avatarResolvers"] }>(
    "people.set_resolvers",
  );
  const [resolvers, setResolvers] = useState(config.avatarResolvers);

  function toggle(id: string) {
    setResolvers((current) =>
      current.map((resolver) =>
        resolver.id === id ? { ...resolver, enabled: !resolver.enabled } : resolver,
      ),
    );
  }

  return (
    <SectionCard
      title="Where a picture may come from"
      description="Tried in order. https only, no credentials, and the host checks the address before it fetches."
      footer={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={write.pending}
            onClick={() => void write.run({ resolvers })}
          >
            {write.pending ? "Saving" : "Save the list"}
          </Button>
          {write.result ? <span className="text-positive text-sm">Saved.</span> : null}
        </div>
      }
    >
      {write.error ? <Failure error={write.error} /> : null}
      <ul className="divide-border divide-y">
        {resolvers.map((resolver) => (
          <li key={resolver.id} className="flex items-center gap-3 py-2">
            <input
              id={`resolver-${resolver.id}`}
              type="checkbox"
              checked={resolver.enabled}
              onChange={() => toggle(resolver.id)}
              className="size-4"
            />
            <label htmlFor={`resolver-${resolver.id}`} className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{resolver.label}</span>
              <code className="text-muted-foreground block truncate text-xs">
                {resolver.urlTemplate}
              </code>
            </label>
            <Badge variant="outline">{resolver.platform}</Badge>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function Transfer() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importWrite = useWrite<{
    written: boolean;
    counts?: Record<string, number>;
    wouldDestroy?: Record<string, number> | null;
  }>("people.import");

  async function download() {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "people.export", input: {} }),
      });
      const body = (await response.json()) as { ok: boolean; result?: unknown };
      if (!body.ok) throw new Error("The export was refused.");

      const blob = new Blob([JSON.stringify(body.result)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `fellowship-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNote("Exported. Avatar bytes travel base64, so the file is large.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setNote(null);
    setError(null);
    try {
      const snapshot: unknown = JSON.parse(await file.text());
      const result = await importWrite.run({
        snapshot,
        mode: "merge",
        confirmedByUser: true,
      });
      if (result?.written) {
        const counts = result.counts ?? {};
        setNote(
          `Merged: ${counts["people"] ?? 0} people, ${counts["events"] ?? 0} occasions, ${
            counts["messages"] ?? 0
          } messages. Cached scores rebuilt.`,
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <SectionCard
      title="Your data in a file you can read"
      description="The snapshot is the backup and the bridge. Import merges: the file wins row by row and nothing else is touched."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={busy} onClick={() => void download()}>
          <Download className="size-4" aria-hidden />
          {busy ? "Exporting" : "Export"}
        </Button>

        <Button variant="outline" asChild disabled={importWrite.pending}>
          <label className="cursor-pointer">
            <Upload className="size-4" aria-hidden />
            {importWrite.pending ? "Importing" : "Import a snapshot"}
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </label>
        </Button>
      </div>

      {note ? <p className="text-positive pt-2 text-sm">{note}</p> : null}
      {error ? <p className="text-negative pt-2 text-sm">{error}</p> : null}
      {importWrite.error ? <Failure error={importWrite.error} /> : null}

      <p className="text-muted-foreground pt-2 text-xs">
        Replace mode, which wipes first, is deliberately not here: it is a command, where it
        names the row counts it will destroy before it runs.
      </p>
    </SectionCard>
  );
}

function ImportChat() {
  const write = useWrite<{
    ok: boolean;
    error?: string;
    replaced?: boolean;
    conversation?: { id: string; title: string | null; messageCount: number };
    unmappedSenders?: Array<{ senderName: string; messageCount: number }>;
  }>("people.import_chat");

  async function upload(file: File) {
    await write.run({ text: await file.text(), fileName: file.name });
  }

  const result = write.result;

  return (
    <div className="space-y-4">
      <SectionCard
        title="Import a chat export"
        description="A WhatsApp export, the .txt from Export Chat without media. It is stored whole, and importing the same chat again rewrites it rather than doubling it."
      >
        <Button variant="outline" asChild disabled={write.pending}>
          <label className="cursor-pointer">
            <Upload className="size-4" aria-hidden />
            {write.pending ? "Reading" : "Choose an export"}
            <input
              type="file"
              accept=".txt,text/plain"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
          </label>
        </Button>

        {write.error ? <Failure error={write.error} /> : null}

        {result && result.ok === false ? (
          <p className="text-negative pt-2 text-sm">{result.error}</p>
        ) : null}

        {result?.ok && result.conversation ? (
          <p className="text-positive pt-2 text-sm">
            {result.replaced ? "Rewrote" : "Imported"} {result.conversation.title ?? "the chat"}:{" "}
            {result.conversation.messageCount} messages,{" "}
            {result.unmappedSenders?.length ?? 0} senders with nobody behind them yet.
          </p>
        ) : null}
      </SectionCard>

      {result?.ok && result.conversation ? (
        <DraftSenders
          conversationId={result.conversation.id}
          unmapped={result.unmappedSenders?.length ?? 0}
        />
      ) : null}
    </div>
  );
}
