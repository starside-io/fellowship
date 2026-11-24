import { useState } from "react";
import { Check, X } from "lucide-react";

import { SectionCard } from "@/ds/index";
import { MONTH_NAMES, NO_YEAR, dayParts, partsToDay } from "@/lib/dates";
import { cn } from "@/lib/cn";
import { useWrite } from "@/lib/use-rpc";
import { Failure } from "@/app/components/states";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";

/**
 * The facts on a person, typed by the person who knows them.
 *
 * Same form for adding someone and for changing them, because they are the
 * same fields and a second form is a second thing to keep in step. The host
 * validates: this posts what was typed and shows what came back, rather than
 * repeating personCreateSchema in the browser.
 */

export interface PersonFacts {
  id?: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  birthday: string | null;
  location: string | null;
  howWeMet: string | null;
  metOn: string | null;
  mbti?: string | null;
  commStyle?: unknown;
}

/** The sixteen types, grouped the way people usually read them. */
const MBTI_TYPES = [
  "INTJ", "INTP", "ENTJ", "ENTP",
  "INFJ", "INFP", "ENFJ", "ENFP",
  "ISTJ", "ISFJ", "ESTJ", "ESFJ",
  "ISTP", "ISFP", "ESTP", "ESFP",
];

/** A native select styled as the Input primitive, so it needs no portal. */
const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30";

type DayValue = { day: string; month: string; year: string };

/**
 * A day as three fields rather than a native date input. WebKit draws an
 * empty date input with today's date in grey, which reads as a stored value;
 * three fields that say "Day", "Month" and "Year" cannot be mistaken for one.
 * The year can stay blank for a birthday, which stores it as year unknown.
 */
function DayField({
  id,
  label,
  value,
  onChange,
  yearOptional,
}: {
  id: string;
  label: string;
  value: DayValue;
  onChange: (next: DayValue) => void;
  yearOptional?: boolean;
}) {
  const set = (patch: Partial<DayValue>) => onChange({ ...value, ...patch });
  const empty = !value.day && !value.month && !value.year;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={`${id}-day`}>{label}</Label>
        {empty ? (
          <span className="text-muted-foreground text-xs">Not set</span>
        ) : (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
            onClick={() => onChange({ day: "", month: "", year: "" })}
          >
            Clear
          </button>
        )}
      </div>
      <div className="grid grid-cols-[4.5rem_1fr_5.5rem] gap-2">
        <select
          id={`${id}-day`}
          aria-label={`${label}, day`}
          className={cn(SELECT_CLASS, !value.day && "text-muted-foreground")}
          value={value.day}
          onChange={(event) => set({ day: event.target.value })}
        >
          <option value="">Day</option>
          {Array.from({ length: 31 }, (_, index) => (
            <option key={index + 1} value={String(index + 1)}>
              {index + 1}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label}, month`}
          className={cn(SELECT_CLASS, !value.month && "text-muted-foreground")}
          value={value.month}
          onChange={(event) => set({ month: event.target.value })}
        >
          <option value="">Month</option>
          {MONTH_NAMES.map((name, index) => (
            <option key={name} value={String(index + 1)}>
              {name}
            </option>
          ))}
        </select>
        <Input
          aria-label={`${label}, year`}
          inputMode="numeric"
          maxLength={4}
          placeholder={yearOptional ? "Year?" : "Year"}
          value={value.year}
          onChange={(event) => set({ year: event.target.value.replace(/\D/g, "") })}
        />
      </div>
    </div>
  );
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function commStyleList(value: unknown): string {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join(", ") : "";
}

export function PersonForm({
  person,
  onDone,
  onCancel,
}: {
  /** Omitted to add someone new. */
  person?: PersonFacts;
  /** The id that was written, so a caller can navigate to a new person. */
  onDone?: (personId: string) => void;
  onCancel?: () => void;
}) {
  const editing = person?.id !== undefined;
  const write = useWrite<{ person: { id: string } }>(
    editing ? "people.update" : "people.create",
  );

  const [displayName, setDisplayName] = useState(person?.displayName ?? "");
  const [firstName, setFirstName] = useState(person?.firstName ?? "");
  const [lastName, setLastName] = useState(person?.lastName ?? "");
  const [birthday, setBirthday] = useState<DayValue>(dayParts(person?.birthday));
  const [location, setLocation] = useState(person?.location ?? "");
  const [howWeMet, setHowWeMet] = useState(person?.howWeMet ?? "");
  const [metOn, setMetOn] = useState<DayValue>(dayParts(person?.metOn));
  const [mbti, setMbti] = useState(person?.mbti ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const mbtiType = MBTI_TYPES.includes(mbti.slice(0, 4)) ? mbti.slice(0, 4) : "";
  const mbtiIdentity = mbti.length > 4 ? mbti.slice(4) : "";
  const [commStyle, setCommStyle] = useState(commStyleList(person?.commStyle));

  async function submit() {
    const born = partsToDay(birthday);
    const met = partsToDay(metOn);
    if (!born.ok) return setFormError(`Birthday: ${born.error}`);
    if (!met.ok) return setFormError(`Met on: ${met.error}`);
    if (met.value?.startsWith(String(NO_YEAR))) {
      return setFormError("Met on: give the year you met.");
    }
    setFormError(null);

    const facts = {
      displayName: displayName.trim(),
      firstName: textOrNull(firstName),
      lastName: textOrNull(lastName),
      birthday: born.value,
      location: textOrNull(location),
      howWeMet: textOrNull(howWeMet),
      metOn: met.value,
      mbti: textOrNull(mbti),
      commStyle: commStyle
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    };

    const saved = editing
      ? await write.run({ personId: person?.id, patch: facts })
      : await write.run(facts);

    if (saved?.person.id) onDone?.(saved.person.id);
  }

  return (
    <SectionCard
      title={editing ? "Edit the facts" : "Add a person"}
      description={
        editing
          ? "What you know about them. A blank field clears what was stored."
          : "A name is enough to start. Everything else can come later."
      }
      action={
        onCancel ? (
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close">
            <X className="size-4" />
          </Button>
        ) : null
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={write.pending || displayName.trim().length === 0}
            onClick={submit}
          >
            {write.pending ? "Saving" : editing ? "Save" : "Add"}
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="person-display-name">Name as you call them</Label>
          <Input
            id="person-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Sam Rivera"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="person-first-name">First name</Label>
          <Input
            id="person-first-name"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            placeholder="Sam"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="person-last-name">Last name</Label>
          <Input
            id="person-last-name"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            placeholder="Rivera"
          />
        </div>

        <DayField
          id="person-birthday"
          label="Birthday"
          value={birthday}
          onChange={setBirthday}
          yearOptional
        />

        <DayField id="person-met-on" label="Met on" value={metOn} onChange={setMetOn} />

        <div className="space-y-1.5">
          <Label htmlFor="person-mbti">Myers-Briggs type</Label>
          <div className="grid grid-cols-[1fr_8.5rem] gap-2">
            <select
              id="person-mbti"
              className={cn(SELECT_CLASS, !mbtiType && "text-muted-foreground")}
              value={mbtiType}
              onChange={(event) =>
                setMbti(event.target.value ? `${event.target.value}${mbtiIdentity}` : "")
              }
            >
              <option value="">Not set</option>
              {MBTI_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <select
              aria-label="Identity"
              className={SELECT_CLASS}
              value={mbtiIdentity}
              disabled={!mbtiType}
              onChange={(event) => setMbti(`${mbtiType}${event.target.value}`)}
            >
              <option value="">No suffix</option>
              <option value="-A">-A assertive</option>
              <option value="-T">-T turbulent</option>
            </select>
          </div>
          <p className="text-muted-foreground text-xs">
            Typed by you. Drafts never set it.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="person-location">Where they are</Label>
          <Input
            id="person-location"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Geneva"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="person-how-we-met">How you met</Label>
          <Input
            id="person-how-we-met"
            value={howWeMet}
            onChange={(event) => setHowWeMet(event.target.value)}
            placeholder="climbing gym"
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="person-comm-style">How to reach them, in practice</Label>
          <Input
            id="person-comm-style"
            value={commStyle}
            onChange={(event) => setCommStyle(event.target.value)}
            placeholder="voice notes, never calls, replies at night"
          />
          <p className="text-muted-foreground text-xs">Separate each one with a comma.</p>
        </div>
      </div>

      {formError ? <p className="text-negative pt-3 text-sm">{formError}</p> : null}
      {write.error ? <Failure error={write.error} /> : null}
    </SectionCard>
  );
}
