import { useMemo, useState } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";

import { SectionCard } from "@/ds/index";
import { useRpc, useWrite } from "@/lib/use-rpc";
import { Failure, Loading } from "@/app/components/states";
import { ContactIcon } from "@/app/components/social-icon";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/**
 * The contact card, editable.
 *
 * The platform list, the handle rules and the profile URL all come from the
 * host: people.social_platforms says what exists and what a handle looks like,
 * and people.set_contacts turns what was typed into the stored value. Nothing
 * here parses a handle or builds a URL, so the UI and an assistant cannot
 * disagree about what Instagram handles are.
 */

const KINDS = ["EMAIL", "PHONE", "SOCIAL", "OTHER"] as const;
type Kind = (typeof KINDS)[number];

const KIND_LABEL: Record<Kind, string> = {
  EMAIL: "Email",
  PHONE: "Phone",
  SOCIAL: "Social",
  OTHER: "Other",
};

const KIND_PLACEHOLDER: Record<Kind, string> = {
  EMAIL: "sam@example.com",
  PHONE: "+41 79 123 45 67",
  SOCIAL: "handle or profile link",
  OTHER: "whatever it is",
};

/** The picker entry for a platform the registry does not have. */
const FREE_TEXT = "__other__";

const SELECT_CLASS =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm";

interface Platform {
  key: string;
  label: string;
  kind: string;
  icon: string;
  placeholder: string;
  handlePattern: string | null;
}

export interface ExistingContact {
  id: string;
  kind: string;
  platform: string | null;
  value: string;
  url: string | null;
  isPrimary: boolean;
  label?: string | null;
  source: string;
  verifiedAt: string | null;
}

interface Row {
  /** Local only, so a row survives being reordered or renumbered. */
  key: string;
  id?: string;
  kind: Kind;
  /** A registry key, free text, or "" for none. */
  platform: string;
  /** True while the platform is being typed rather than picked. */
  freeText: boolean;
  value: string;
  label: string;
  isPrimary: boolean;
  source: string;
  verifiedAt: string | null;
  /** What was stored, to tell an edit from a row that was only carried along. */
  storedValue: string;
}

let rowCounter = 0;
function nextKey(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

function toRow(contact: ExistingContact, known: Set<string>): Row {
  const platform = contact.platform ?? "";
  return {
    key: nextKey(),
    id: contact.id,
    kind: isKind(contact.kind) ? contact.kind : "OTHER",
    platform,
    freeText: platform !== "" && !known.has(platform),
    value: contact.value,
    label: contact.label ?? "",
    isPrimary: contact.isPrimary,
    source: contact.source,
    verifiedAt: contact.verifiedAt,
    storedValue: contact.value,
  };
}

export function ContactsEditor({
  personId,
  contacts,
  onDone,
  onCancel,
}: {
  personId: string;
  contacts: ExistingContact[];
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const catalogue = useRpc<{ platforms: Platform[] }>("people.social_platforms");
  const write = useWrite<{ contacts: ExistingContact[] }>("people.set_contacts");

  const platforms = catalogue.data?.platforms ?? [];
  const known = useMemo(
    () => new Set(platforms.map((platform) => platform.key)),
    [platforms],
  );
  const byKey = useMemo(
    () => new Map(platforms.map((platform) => [platform.key, platform])),
    [platforms],
  );

  // Built once the catalogue is in, because whether a stored platform is a
  // registry key or free text is the catalogue's answer, not a guess.
  const [rows, setRows] = useState<Row[] | null>(null);
  const live = rows ?? (catalogue.data ? contacts.map((row) => toRow(row, known)) : null);

  if (catalogue.error) return <Failure error={catalogue.error} />;
  if (live === null) return <Loading lines={4} />;

  function edit(key: string, patch: Partial<Row>) {
    setRows(live!.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function remove(key: string) {
    setRows(live!.filter((row) => row.key !== key));
  }

  function add(kind: Kind) {
    setRows([
      ...live!,
      {
        key: nextKey(),
        kind,
        platform: "",
        freeText: false,
        value: "",
        label: "",
        // The first row on an empty card is the one the card leads with.
        isPrimary: live!.length === 0,
        source: "MANUAL",
        verifiedAt: null,
        storedValue: "",
      },
    ]);
  }

  function makeDefault(key: string) {
    setRows(live!.map((row) => ({ ...row, isPrimary: row.key === key })));
  }

  function changeKind(key: string, kind: Kind) {
    // A platform belongs to a kind, so changing the kind drops one that no
    // longer applies rather than sending Instagram as an email.
    const row = live!.find((entry) => entry.key === key);
    const platform = row ? byKey.get(row.platform) : undefined;
    const keep = platform?.kind === kind;
    edit(key, {
      kind,
      ...(keep ? {} : { platform: "", freeText: false }),
    });
  }

  async function save() {
    const payload = live!
      .filter((row) => row.value.trim().length > 0)
      .map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        kind: row.kind,
        platform: row.platform.trim() === "" ? null : row.platform.trim(),
        value: row.value.trim(),
        label: row.label.trim() === "" ? null : row.label.trim(),
        isPrimary: row.isPrimary,
        // A value a person typed over is theirs now, whoever proposed it first.
        source: row.value.trim() === row.storedValue ? row.source : "MANUAL",
      }));

    const saved = await write.run({ personId, contacts: payload, replace: true });
    if (saved) onDone?.();
  }

  return (
    <SectionCard
      title="Contact card"
      description="Email, phone, socials. The default is the one the card leads with."
      action={
        onCancel ? (
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close">
            <X className="size-4" />
          </Button>
        ) : null
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={write.pending} onClick={save}>
            {write.pending ? "Saving" : "Save card"}
          </Button>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {write.result ? (
            <span className="text-positive flex items-center gap-1 text-sm">
              <Check className="size-3.5" aria-hidden /> Saved.
            </span>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3">
        {live.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing on the card yet. Add an email, a number or a handle.
          </p>
        ) : null}

        {live.map((row) => {
          const platform = byKey.get(row.platform);
          const picker = platforms.filter((entry) => entry.kind === row.kind);
          const takesPlatform = row.kind === "SOCIAL" || row.kind === "OTHER";

          return (
            <div
              key={row.key}
              className="border-border grid gap-2 rounded-lg border p-3 sm:grid-cols-[auto_8rem_12rem_1fr_auto]"
            >
              <div className="text-muted-foreground flex items-center justify-center pt-1">
                <ContactIcon
                  kind={row.kind}
                  iconName={platform?.icon}
                  className="size-4"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`${row.key}-kind`} className="text-xs">
                  Kind
                </Label>
                <select
                  id={`${row.key}-kind`}
                  value={row.kind}
                  onChange={(event) =>
                    isKind(event.target.value) && changeKind(row.key, event.target.value)
                  }
                  className={SELECT_CLASS}
                >
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`${row.key}-platform`} className="text-xs">
                  Platform
                </Label>
                {takesPlatform ? (
                  row.freeText ? (
                    <Input
                      id={`${row.key}-platform`}
                      value={row.platform}
                      onChange={(event) => edit(row.key, { platform: event.target.value })}
                      placeholder="name it"
                    />
                  ) : (
                    <select
                      id={`${row.key}-platform`}
                      value={row.platform}
                      onChange={(event) =>
                        event.target.value === FREE_TEXT
                          ? edit(row.key, { platform: "", freeText: true })
                          : edit(row.key, { platform: event.target.value })
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="">Not said</option>
                      {picker.map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.label}
                        </option>
                      ))}
                      <option value={FREE_TEXT}>Something else…</option>
                    </select>
                  )
                ) : (
                  <p className="text-muted-foreground pt-2 text-xs">Not used for this kind.</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`${row.key}-value`} className="text-xs">
                  {row.kind === "SOCIAL" ? "Handle or link" : "Value"}
                </Label>
                <Input
                  id={`${row.key}-value`}
                  value={row.value}
                  onChange={(event) => edit(row.key, { value: event.target.value })}
                  placeholder={platform?.placeholder ?? KIND_PLACEHOLDER[row.kind]}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={row.label}
                    onChange={(event) => edit(row.key, { label: event.target.value })}
                    placeholder="label, such as work"
                    className="h-7 max-w-40 text-xs"
                    aria-label="Label"
                  />
                  <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <input
                      type="radio"
                      name={`${personId}-primary`}
                      checked={row.isPrimary}
                      onChange={() => makeDefault(row.key)}
                    />
                    Default
                  </label>
                  {row.source !== "MANUAL" ? (
                    <Badge variant="outline" className="text-xs">
                      {row.verifiedAt === null ? "unconfirmed" : row.source.toLowerCase()}
                    </Badge>
                  ) : null}
                </div>
              </div>

              <div className="flex items-start justify-end pt-6">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(row.key)}
                  aria-label={`Remove ${row.value || "this row"}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap gap-2">
          {KINDS.map((kind) => (
            <Button key={kind} variant="secondary" size="sm" onClick={() => add(kind)}>
              <Plus className="size-3.5" aria-hidden />
              {KIND_LABEL[kind]}
            </Button>
          ))}
        </div>

        <p className="text-muted-foreground text-xs">
          A handle is cleaned up and its profile link derived when this saves. A row left
          empty is dropped, and a row removed here is deleted.
        </p>
      </div>

      {write.error ? <Failure error={write.error} /> : null}
    </SectionCard>
  );
}
