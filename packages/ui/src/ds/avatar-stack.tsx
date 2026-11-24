import { cn } from "@/lib/cn";
import {
  AVATAR_SIZES,
  InitialsAvatar,
  type AvatarSize,
} from "@/ds/initials-avatar";

export type AvatarStackPerson = {
  id: string;
  name: string;
  color: string;
  /** Picture URL. Falls back to the initials when absent or broken. */
  src?: string | null;
};

export type AvatarStackProps = {
  people: AvatarStackPerson[];
  /** How many avatars to show before collapsing the rest into a counter. */
  max?: number;
  size?: AvatarSize;
  /**
   * Ring colour of the gap between avatars. Match it to the surface behind
   * the stack, for example ring-card inside a card.
   */
  ringClassName?: string;
  /** Shown instead of the stack when there is nobody to show. */
  emptyLabel?: string;
  className?: string;
};

/** Overlapping initials circles, capped with a +N counter. */
export function AvatarStack({
  people,
  max = 4,
  size = "sm",
  ringClassName = "ring-background",
  emptyLabel = "No one tagged",
  className,
}: AvatarStackProps) {
  if (people.length === 0) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        {emptyLabel}
      </span>
    );
  }

  const shown = people.slice(0, max);
  const extra = people.length - shown.length;

  return (
    <span
      className={cn("flex items-center", className)}
      title={people.map((person) => person.name).join(", ")}
    >
      {shown.map((person) => (
        <InitialsAvatar
          key={person.id}
          name={person.name}
          color={person.color}
          src={person.src}
          size={size}
          className={cn("-ml-2 ring-2 first:ml-0", ringClassName)}
        />
      ))}
      {extra > 0 ? (
        <span
          className={cn(
            "-ml-2 flex shrink-0 items-center justify-center rounded-full border bg-muted font-semibold text-muted-foreground ring-2",
            AVATAR_SIZES[size],
            ringClassName,
          )}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
