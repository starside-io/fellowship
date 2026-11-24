import { useState } from "react";
import { Sparkles } from "lucide-react";

import { RpcError, host, type DraftAnswer } from "@/client";
import { SectionCard } from "@/ds/index";
import { invalidate } from "@/lib/use-rpc";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";

/**
 * Asking the model for a draft.
 *
 * Every button here ends in the review queue. Nothing on this screen writes to
 * the records, which is why none of them say "save": they say what they are,
 * which is a draft going somewhere to be read.
 */

function Outcome({ answer }: { answer: DraftAnswer }) {
  return (
    <div className="space-y-2 pt-2 text-sm">
      {answer.queued.length > 0 ? (
        <p className="text-positive">
          {answer.queued.length} waiting in Review, drafted in{" "}
          {(answer.tookMs / 1000).toFixed(1)}s. Nothing is written until you confirm it.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Nothing worth proposing came back in {(answer.tookMs / 1000).toFixed(1)}s.
        </p>
      )}

      {answer.rejected.length > 0 ? (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">
            {answer.rejected.length} dropped before the queue
          </summary>
          <ul className="list-disc space-y-0.5 pt-1 pl-4">
            {answer.rejected.slice(0, 8).map((entry, index) => (
              <li key={index}>{entry.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function useDraft() {
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<DraftAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(job: () => Promise<DraftAnswer>) {
    setPending(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await job();
      setAnswer(result);
      // The queue changed, and the rail shows its count.
      invalidate();
    } catch (caught) {
      setError(
        caught instanceof RpcError && caught.code === "unavailable"
          ? `${caught.message} Start one, or point FELLOWSHIP_MODEL_URL at the one you use.`
          : caught instanceof Error
            ? caught.message
            : String(caught),
      );
    } finally {
      setPending(false);
    }
  }

  return { pending, answer, error, run };
}

export function DraftSketch({ personId }: { personId: string }) {
  const draft = useDraft();

  return (
    <SectionCard
      title="Ask for a sketch"
      description="The model reads the history, the chats and your notes, and proposes a sketch. It lands in Review, unwritten, and a draft that reads as a diagnosis is refused before you ever see it."
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={draft.pending}
            onClick={() => void draft.run(() => host.draft.sketch(personId))}
          >
            <Sparkles className="size-3.5" aria-hidden />
            {draft.pending ? "Reading" : "Draft a sketch"}
          </Button>
        </div>
      }
    >
      {draft.error ? <p className="text-negative text-sm">{draft.error}</p> : null}
      {draft.answer ? <Outcome answer={draft.answer} /> : null}
    </SectionCard>
  );
}

export function DraftFacts({ personId }: { personId: string }) {
  const draft = useDraft();
  const [text, setText] = useState("");

  return (
    <SectionCard
      title="Read something into facts"
      description="Paste a bio, a message, anything. What it finds becomes proposals: a field, a tag, a contact, a note. What has nowhere to go is listed rather than forced."
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={draft.pending || text.trim().length === 0}
            onClick={() => void draft.run(() => host.draft.facts(personId, text))}
          >
            <Sparkles className="size-3.5" aria-hidden />
            {draft.pending ? "Reading" : "Read it"}
          </Button>
        </div>
      }
    >
      <Textarea
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Paste the text here."
      />
      {draft.error ? <p className="text-negative pt-2 text-sm">{draft.error}</p> : null}
      {draft.answer ? <Outcome answer={draft.answer} /> : null}
    </SectionCard>
  );
}

export function DraftSenders({
  conversationId,
  unmapped,
}: {
  conversationId: string;
  unmapped: number;
}) {
  const draft = useDraft();

  if (unmapped === 0) return null;

  return (
    <SectionCard
      title="Who are these senders?"
      description={`${unmapped} ${
        unmapped === 1 ? "sender has" : "senders have"
      } nobody behind them. The model reads how they write and proposes a match, one at a time, because binding the wrong sender rewrites who said what across a whole chat.`}
      footer={
        <Button
          size="sm"
          disabled={draft.pending}
          onClick={() => void draft.run(() => host.draft.senders(conversationId))}
        >
          <Sparkles className="size-3.5" aria-hidden />
          {draft.pending ? "Reading" : "Suggest matches"}
        </Button>
      }
    >
      {draft.error ? <p className="text-negative text-sm">{draft.error}</p> : null}
      {draft.answer ? <Outcome answer={draft.answer} /> : null}
    </SectionCard>
  );
}
