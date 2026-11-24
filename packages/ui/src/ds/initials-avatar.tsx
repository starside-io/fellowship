import { cn } from "@/lib/cn";
import { readable, tint } from "@/ds/tint";

/** "Ada Lovelace" becomes AL, "Ada" becomes AD, an empty name becomes ?. */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/**
 * One ramp, two ways to name a step. The t-shirt keys are the default scale.
 * The numeric keys are the raw Tailwind step, for wrappers and dense layouts
 * that need an exact box rather than the nearest t-shirt size.
 */
export const AVATAR_SIZES = {
  xs: "size-5 text-[0.55rem]",
  sm: "size-7 text-[0.65rem]",
  "8": "size-8 text-[0.7rem]",
  md: "size-9 text-xs",
  "10": "size-10 text-sm",
  lg: "size-12 text-sm",
  xl: "size-16 text-xl",
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZES;

/** The circle shape, shared so the picture variant matches the initials exactly. */
const AVATAR_BASE =
  "flex shrink-0 items-center justify-center rounded-full border font-semibold tracking-tight";

export type InitialsAvatarProps = {
  name: string;
  /** Any CSS colour. Person records store a six digit hex. Falls back to a neutral tone. */
  color?: string | null;
  size?: AvatarSize;
  className?: string;
  /**
   * A picture to show instead of the initials. It is painted as a background
   * layer rather than an `img`, so a URL that 404s or errors leaves the
   * initials showing rather than a broken image glyph. That is the common case
   * here: the avatar route answers 404 for anyone with no stored picture.
   */
  src?: string | null;
};

/** The canonical avatar circle, used everywhere a person appears. */
export function InitialsAvatar({
  name,
  color = "var(--muted-foreground)",
  size = "md",
  className,
  src,
}: InitialsAvatarProps) {
  const resolved = color ?? "var(--muted-foreground)";
  const boxClassName = cn(AVATAR_BASE, AVATAR_SIZES[size], className);
  const style = {
    backgroundColor: tint(resolved, "26", 15),
    borderColor: tint(resolved, "59", 35),
    color: readable(resolved),
  };
  const initials = initialsFor(name);

  if (src) {
    return (
      <span
        aria-hidden="true"
        className={cn(boxClassName, "relative overflow-hidden")}
        style={style}
      >
        {initials}
        <span
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url("${encodeURI(src)}")` }}
        />
      </span>
    );
  }

  return (
    <span aria-hidden="true" className={boxClassName} style={style}>
      {initials}
    </span>
  );
}
