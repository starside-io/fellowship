import {
  AtSign,
  Briefcase,
  Camera,
  CirclePlay,
  Cloud,
  CodeXml,
  Gamepad2,
  Ghost,
  Globe,
  Link,
  Mail,
  MessageCircle,
  MessageCircleMore,
  MessagesSquare,
  Music2,
  Phone,
  Rabbit,
  Send,
  Tv,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The glyph for a contact row.
 *
 * Core holds the icon name, never the component: importing a React icon
 * library into the one package that must not know the UI exists would point the
 * dependency arrow the wrong way. This is the other half of that, the only
 * place that maps a name to something that renders.
 *
 * lucide ships no brand marks, so each platform gets a generic glyph.
 */
const BY_NAME: Record<string, LucideIcon> = {
  AtSign,
  Briefcase,
  Camera,
  CirclePlay,
  Cloud,
  CodeXml,
  Gamepad2,
  Ghost,
  Globe,
  Link,
  Mail,
  MessageCircle,
  MessageCircleMore,
  MessagesSquare,
  Music2,
  Phone,
  Rabbit,
  Send,
  Tv,
  Users,
};

/** Fallbacks for a row whose platform is not in the registry. */
const BY_KIND: Record<string, LucideIcon> = {
  EMAIL: Mail,
  PHONE: Phone,
  SOCIAL: AtSign,
  OTHER: Link,
};

export function contactIconComponent(
  kind: string,
  iconName: string | null | undefined,
): LucideIcon {
  if (iconName && BY_NAME[iconName]) return BY_NAME[iconName];
  return BY_KIND[kind] ?? Link;
}

export function ContactIcon({
  kind,
  iconName,
  className,
}: {
  kind: string;
  iconName?: string | null;
  className?: string;
}) {
  const Glyph = contactIconComponent(kind, iconName);
  return <Glyph className={className} aria-hidden />;
}
