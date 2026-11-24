import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Hash, MessageSquare, StickyNote, Users } from "lucide-react";

import { InitialsAvatar } from "@/ds/index";
import { navigate } from "@/lib/router";
import { useRpc } from "@/lib/use-rpc";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";

/**
 * Cmd+K. Runs people.search, which is the same tool an assistant searches
 * with, so the palette cannot find anything a tool call could not.
 */

interface SearchResult {
  people: Array<{ id: string; displayName: string; avatarColor: string; isSelf: boolean }>;
  tags: Array<{ id: string; name: string; kind: string; colour: string }>;
  events: Array<{ id: string; title: string; occurredAt: string }>;
  notes: Array<{ id: string; personId: string | null; occurredAt: string; snippet: string }>;
  messages: Array<{
    id: string;
    personId: string | null;
    senderName: string;
    sentAt: string;
    snippet: string;
  }>;
  messageTotal: number;
}

/** What FTS5 wraps a hit in, so the palette can show it as emphasis. */
const HIT_OPEN = "\u2039";
const HIT_CLOSE = "\u203a";

function Snippet({ text }: { text: string }) {
  const parts = text.split(HIT_OPEN).flatMap((chunk, index) => {
    if (index === 0) return [{ hit: false, text: chunk }];
    const [hit = "", rest = ""] = chunk.split(HIT_CLOSE);
    return [
      { hit: true, text: hit },
      { hit: false, text: rest },
    ];
  });

  return (
    <span className="text-muted-foreground truncate text-xs">
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="bg-thread/20 text-foreground rounded px-0.5">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

export function usePaletteShortcut(open: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 120);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const search = useRpc<SearchResult>(
    debounced.length > 0 ? "people.search" : null,
    { query: debounced, limit: 8 },
  );

  const rows = useMemo(() => {
    const result = search.data;
    if (!result) return [];
    return [
      ...result.people.map((person) => ({
        key: `person:${person.id}`,
        icon: (
          <InitialsAvatar name={person.displayName} color={person.avatarColor} size="xs" />
        ),
        label: person.displayName,
        hint: person.isSelf ? "You" : "Person",
        go: () => navigate(`/people/${person.id}`),
      })),
      ...result.events.map((event) => ({
        key: `event:${event.id}`,
        icon: <CalendarDays className="size-4" />,
        label: event.title,
        hint: new Date(event.occurredAt).toLocaleDateString(),
        go: () => navigate("/events"),
      })),
      ...result.tags.map((tag) => ({
        key: `tag:${tag.id}`,
        icon: <Hash className="size-4" />,
        label: tag.name,
        hint: tag.kind.toLowerCase(),
        go: () => navigate("/people"),
      })),
      ...result.notes.map((note) => ({
        key: `note:${note.id}`,
        icon: <StickyNote className="size-4" />,
        label: <Snippet text={note.snippet} />,
        hint: "note",
        go: () => (note.personId ? navigate(`/people/${note.personId}`) : undefined),
      })),
      ...result.messages.map((message) => ({
        key: `message:${message.id}`,
        icon: <MessageSquare className="size-4" />,
        label: <Snippet text={message.snippet} />,
        hint: message.senderName,
        go: () =>
          message.personId ? navigate(`/people/${message.personId}`) : undefined,
      })),
    ];
  }, [search.data]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="top-[20%] max-w-lg translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Search Fellowship</DialogTitle>
        <div className="border-border border-b p-3">
          <Input
            autoFocus
            value={query}
            placeholder="Search people, occasions and tags"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && rows[0]) {
                rows[0].go();
                onClose();
              }
            }}
          />
        </div>

        <ul className="max-h-80 overflow-y-auto p-2">
          {debounced.length === 0 ? (
            <li className="text-muted-foreground p-3 text-sm">
              <Users className="mr-2 inline size-4" aria-hidden />
              Type a name. Search comes before everything else here.
            </li>
          ) : null}

          {debounced.length > 0 && rows.length === 0 && !search.loading ? (
            <li className="text-muted-foreground p-3 text-sm">
              Nothing matches "{debounced}".
            </li>
          ) : null}

          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm"
                onClick={() => {
                  row.go();
                  onClose();
                }}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {row.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{row.hint}</span>
              </button>
            </li>
          ))}

          {(search.data?.messageTotal ?? 0) > (search.data?.messages.length ?? 0) ? (
            <li className="text-muted-foreground px-3 py-2 text-xs">
              {search.data!.messageTotal} messages match. The closest few are above.
            </li>
          ) : null}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
