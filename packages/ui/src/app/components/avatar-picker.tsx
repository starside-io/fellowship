import { useState } from "react";
import { Check, Download, ImageOff, X } from "lucide-react";

import { host, type AvatarPreview } from "@/client";
import { RpcError } from "@/client";
import { SectionCard } from "@/ds/index";
import { useRpc, useWrite, invalidate } from "@/lib/use-rpc";
import { Failure, Loading } from "@/app/components/states";
import { ContactIcon } from "@/app/components/social-icon";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";

/**
 * A picture for a person, from the handles already stored against them.
 *
 * Three steps, and the middle one is the point: the host lists the URLs its
 * enabled resolvers would try, the owner picks one and sees what comes back,
 * and only then does anything get stored. The browser never fetches a
 * resolver itself, so every byte passes the host's guard, and no picture lands
 * without the owner looking at it first.
 */

interface Candidate {
  resolverId: string;
  label: string;
  platform: string;
  url: string;
  handle: string | null;
  error?: string;
}

interface CandidatesPayload {
  personId: string;
  displayName: string;
  picture: { source: string; sourceUrl: string | null; fetchedAt: string } | null;
  candidates: Candidate[];
  hint: string;
}

export function AvatarPicker({
  personId,
  onDone,
  onCancel,
}: {
  personId: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const state = useRpc<CandidatesPayload>("people.avatar_candidates", { personId });
  const registry = useRpc<{ platforms: Array<{ key: string; icon: string }> }>(
    "people.social_platforms",
  );
  const store = useWrite<unknown>("people.set_picture");

  const [preview, setPreview] = useState<AvatarPreview | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [failure, setFailure] = useState<RpcError | null>(null);

  async function look(candidate: Candidate) {
    setFetching(candidate.url);
    setFailure(null);
    setPreview(null);
    try {
      setPreview(await host.avatarPreview(personId, candidate.url));
    } catch (error) {
      setFailure(
        error instanceof RpcError
          ? error
          : new RpcError("/host/avatar/preview", "failed", String(error)),
      );
    } finally {
      setFetching(null);
    }
  }

  async function keep() {
    if (!preview) return;
    // The owner has the picture in front of them and clicked this. That is
    // what confirmedByUser means, and it is why no screen sets it earlier.
    const saved = await store.run({
      personId,
      url: preview.candidate.url,
      source: "RESOLVER",
      confirmedByUser: true,
    });
    if (saved) {
      invalidate();
      onDone?.();
    }
  }

  if (state.error) return <Failure error={state.error} />;
  if (state.loading || !state.data) return <Loading lines={3} />;

  const { candidates, hint, picture } = state.data;
  const iconByPlatform = new Map(
    (registry.data?.platforms ?? []).map((entry) => [entry.key, entry.icon]),
  );

  return (
    <SectionCard
      title="Find a picture"
      description="Built from the handles on this person. Nothing is fetched until you ask, and nothing is stored until you say so."
      action={
        onCancel ? (
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close">
            <X className="size-4" />
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">{hint}</p>

        {picture ? (
          <p className="text-muted-foreground text-xs">
            There is already a picture here, from {picture.source.toLowerCase()}, fetched{" "}
            {new Date(picture.fetchedAt).toLocaleDateString()}. Keeping one of these
            replaces it.
          </p>
        ) : null}

        {candidates.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <ImageOff className="size-4" aria-hidden />
            Nothing to try.
          </div>
        ) : null}

        <ul className="space-y-2">
          {candidates.map((candidate) => (
            <li
              key={candidate.url}
              className="border-border flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <ContactIcon
                kind={candidate.platform === "email" ? "EMAIL" : "SOCIAL"}
                iconName={iconByPlatform.get(candidate.platform)}
                className="text-muted-foreground size-4"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{candidate.label}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {candidate.handle ? `${candidate.handle} · ` : ""}
                  {candidate.url}
                </p>
              </div>
              {candidate.error ? (
                <Badge variant="outline" className="text-xs">
                  {candidate.error}
                </Badge>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={fetching !== null}
                  onClick={() => look(candidate)}
                >
                  <Download className="size-3.5" aria-hidden />
                  {fetching === candidate.url ? "Fetching" : "Look"}
                </Button>
              )}
            </li>
          ))}
        </ul>

        {failure ? <Failure error={failure} /> : null}

        {preview ? (
          <div className="border-border flex flex-wrap items-center gap-4 rounded-lg border p-3">
            <img
              src={preview.dataUrl}
              alt={`Candidate picture from ${preview.candidate.label}`}
              className="size-20 rounded-full object-cover"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">{preview.candidate.label}</p>
              <p className="text-muted-foreground text-xs">
                {preview.mime} · {Math.round(preview.bytes / 1024)} kB
              </p>
              <p className="text-muted-foreground truncate text-xs">{preview.sourceUrl}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={store.pending} onClick={keep}>
                {store.pending ? "Saving" : "Use this picture"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Discard
              </Button>
              {store.result ? (
                <span className="text-positive flex items-center gap-1 text-sm">
                  <Check className="size-3.5" aria-hidden /> Saved.
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {store.error ? <Failure error={store.error} /> : null}
      </div>
    </SectionCard>
  );
}
