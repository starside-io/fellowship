import { PERSONALITY_AXES } from "../../schemas/personality.js";
import type { SenderMatch } from "./schemas.js";

/**
 * What the model is told, and what it is told not to do.
 *
 * The rules here are the same ones the tools enforce, said again in words the
 * model reads: do not invent a person, do not diagnose, say when the history
 * is thin. The enforcement is still in the tools, because a prompt is a
 * request and a schema is a contract, but a model that has been told the rule
 * produces drafts a person can actually confirm.
 */

export const HOUSE_RULES = [
  "You are drafting for one person's private records. Nothing you write is saved: every draft goes to a review queue where the owner confirms or discards it.",
  "Never invent a person, a date, a handle or a quote. If the material does not say it, leave it out and say what is missing.",
  "Prefer the concrete. A number, a quote or a date beats an adjective.",
].join(" ");

export interface SenderPromptContext {
  conversationTitle: string | null;
  /** The sender names with nobody behind them yet, busiest first. */
  unmapped: Array<{ senderName: string; messageCount: number }>;
  /** Who this silo already knows. */
  people: Array<{ id: string; displayName: string }>;
  /** A few lines per sender, so the model has something to read. */
  samples: Array<{ senderName: string; body: string; sentAt: string }>;
}

export function senderPrompt(context: SenderPromptContext): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      HOUSE_RULES,
      "You are matching sender names in a chat export to people already in the records.",
      "Only ever answer with a personId from the list you are given, or null. A sender who is not one of those people is null, not the closest name.",
      "A nickname, a surname or a phone number can be the same person as a full name. Say what in the messages makes you think so.",
    ].join(" "),
    prompt: [
      `Chat: ${context.conversationTitle ?? "untitled"}`,
      "",
      "People already in the records:",
      ...context.people.map((person) => `  ${person.id}  ${person.displayName}`),
      "",
      "Senders with nobody behind them:",
      ...context.unmapped.map(
        (sender) => `  ${sender.senderName} (${sender.messageCount} messages)`,
      ),
      "",
      "A few of their messages:",
      ...context.samples.map(
        (sample) => `  [${sample.sentAt}] ${sample.senderName}: ${sample.body}`,
      ),
      "",
      "For each unmapped sender, give the personId they are, or null.",
    ].join("\n"),
  };
}

export interface FactPromptContext {
  displayName: string;
  /** The custom fields this silo defines, so extraction cannot invent a key. */
  fields: Array<{ key: string; label: string; type: string }>;
  /** What is already recorded, so the draft adds rather than repeats. */
  known: {
    location: string | null;
    howWeMet: string | null;
    birthday: string | null;
    interests: string[];
    allergies: string[];
    dislikes: string[];
  };
  text: string;
}

export function factPrompt(context: FactPromptContext): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      HOUSE_RULES,
      "You are pulling facts about one person out of text the owner pasted in.",
      "An allergy is not an interest. Getting that wrong puts someone in a restaurant that can hurt them.",
      "Do not guess a birthday from an age, from the date a message was sent, a location from a phone prefix, or a surname from an email address. A fact with no source in the text is not a fact.",
      "Dates are YYYY-MM-DD. A birthday given as a day and a month with no year uses the year 1604, which the records read as year unknown.",
      "Anything the text says that has nowhere to go belongs in unplaced, not forced into the nearest field.",
    ].join(" "),
    prompt: [
      `About: ${context.displayName}`,
      "",
      "Already recorded:",
      `  location: ${context.known.location ?? "unknown"}`,
      `  how we met: ${context.known.howWeMet ?? "unknown"}`,
      `  birthday: ${context.known.birthday ?? "unknown"}`,
      `  interests: ${context.known.interests.join(", ") || "none"}`,
      `  allergies: ${context.known.allergies.join(", ") || "none"}`,
      `  dislikes: ${context.known.dislikes.join(", ") || "none"}`,
      "",
      context.fields.length > 0
        ? `Custom fields that exist: ${context.fields
            .map((field) => `${field.key} (${field.label}, ${field.type})`)
            .join(", ")}`
        : "This silo defines no custom fields, so do not use the update kind with a field that is not a Person column.",
      "",
      "The text:",
      context.text,
    ].join("\n"),
  };
}

export interface SketchPromptContext {
  displayName: string;
  /** Everything the logged history says, as people.insights returns it. */
  insights: unknown;
  /** What the chats say, as people.chat_insights returns it. Null when none. */
  chatInsights: unknown;
  /** Real message text, which is what a sketch is actually written from. */
  messages: Array<{ sentAt: string; isFromSelf: boolean; body: string }>;
  /** Notes the owner wrote themselves. */
  notes: string[];
  /** What to put in sources, named for the model rather than left to it. */
  sourceHints: string[];
}

export function sketchPrompt(context: SketchPromptContext): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      HOUSE_RULES,
      "You are drafting a sketch of how someone actually is, and how to spend time with them well.",
      "Observable behaviour only, with a quote or a number behind every claim: reply speed, who starts after a silence, who repairs after friction, whether they ask questions back, how they handle plans, message length, what they bring up unprompted.",
      "No diagnosis, no attachment styles, no inferred mental health, no personality typing. Slow to reply is an observation; avoidant is a diagnosis wearing an observation's clothes, and a draft carrying one is refused outright.",
      "Thin history is stated as thin. Two occasions are never a pattern.",
      "sources is required and non-empty: name the history and the chats you read.",
    ].join(" "),
    prompt: [
      `About: ${context.displayName}`,
      "",
      "What the logged history says:",
      JSON.stringify(context.insights, null, 2),
      "",
      context.chatInsights
        ? `What the chats say:\n${JSON.stringify(context.chatInsights, null, 2)}`
        : "There are no imported chats for this person.",
      "",
      context.notes.length > 0
        ? `Notes the owner wrote:\n${context.notes.map((note) => `  ${note}`).join("\n")}`
        : "The owner has written no notes about them.",
      "",
      context.messages.length > 0
        ? [
            "Messages, oldest first:",
            ...context.messages.map(
              (message) =>
                `  [${message.sentAt}] ${message.isFromSelf ? "owner" : "them"}: ${message.body}`,
            ),
          ].join("\n")
        : "There are no messages to read.",
      "",
      `Put these in sources, plus any page you were given: ${context.sourceHints.join(", ")}`,
    ].join("\n"),
  };
}

export type PersonalityPromptContext = SketchPromptContext;

export function personalityPrompt(context: PersonalityPromptContext): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      HOUSE_RULES,
      "You are scoring how someone comes across, on a fixed set of behavioural axes, from their messages and the logged history.",
      "Each axis runs from 0 (all the way to its left end) to 100 (all the way to its right end). Score what the material shows, not what is typical.",
      "Every score carries evidence: a short quote, a count, or a habit you can point to in the messages. Confidence is low when the evidence is one message or one occasion.",
      "Leave an axis out when the material says nothing about it. Do not fill it with 50: 50 on the chart reads as middling, not unknown.",
      "Score at least four axes. If the material cannot support four, say so by not proposing a draft.",
      "No diagnosis, no clinical labels, no attachment styles, no type labels such as Myers-Briggs letters. The owner records a type themselves if they want one.",
      "sources is required and non-empty: name the history and the chats you read.",
    ].join(" "),
    prompt: [
      `About: ${context.displayName}`,
      "",
      "The axes:",
      ...PERSONALITY_AXES.map(
        (axis) => `  ${axis.key}: ${axis.left} (0) to ${axis.right} (100). ${axis.hint}`,
      ),
      "",
      "What the logged history says:",
      JSON.stringify(context.insights, null, 2),
      "",
      context.chatInsights
        ? `What the chats say:\n${JSON.stringify(context.chatInsights, null, 2)}`
        : "There are no imported chats for this person.",
      "",
      context.notes.length > 0
        ? `Notes the owner wrote:\n${context.notes.map((note) => `  ${note}`).join("\n")}`
        : "The owner has written no notes about them.",
      "",
      context.messages.length > 0
        ? [
            "Messages, oldest first:",
            ...context.messages.map(
              (message) =>
                `  [${message.sentAt}] ${message.isFromSelf ? "owner" : "them"}: ${message.body}`,
            ),
          ].join("\n")
        : "There are no messages to read.",
      "",
      `Put these in sources: ${context.sourceHints.join(", ")}`,
    ].join("\n"),
  };
}

export interface RecapPromptContext {
  conversationTitle: string | null;
  /** The window read, as dates. */
  from: string;
  through: string;
  /** How many messages come after this window, so the caller knows to go on. */
  remaining: number;
  owner: { id: string; displayName: string } | null;
  /** Who is in this chat, with every name the export gives them. */
  people: Array<{ id: string; displayName: string; senderNames: string[] }>;
  /** What is already logged around this window, so the draft adds rather than repeats. */
  knownEvents: Array<{ occurredAt: string; type: string; title: string; people: string[] }>;
  /** What is already recorded per person. */
  knownPreferences: Array<{
    displayName: string;
    interests: string[];
    dislikes: string[];
    allergies: string[];
  }>;
  messages: Array<{ sentAt: string; sender: string; body: string }>;
}

export function recapPrompt(context: RecapPromptContext): {
  system: string;
  prompt: string;
} {
  return {
    system: [
      HOUSE_RULES,
      "You are recapping a stretch of one chat: the big things that happened, and what the people in it turned out to like, dislike or be allergic to.",
      "An event is something that happened, not something talked about. Plans that were made and then happened count once, on the day they happened. Plans that never happened do not count. Small talk is not an event.",
      "A mention is not presence. Only list someone as a participant if the messages show they were there. The owner is a participant only when they were there too.",
      "Never add a bystander to a CONFLICT. A conflict is between the people who had it.",
      "Sentiment runs from -2 (bad) to 2 (great). Weight runs from 1 (ordinary) to 3 (a milestone). Most things are weight 1. durationDays is how many days it lasted: 1 for a meal or a night out, the number of days for a trip or a stay together.",
      "A preference needs the person's own words or plain behaviour behind it. Something they tried once is not an interest. An allergy is not a dislike.",
      "Skip anything already in the known events or the known preferences. The module checks again, but a duplicate you leave out is one the owner never has to discard.",
      "Every event and every preference carries a quote from the messages, copied exactly.",
    ].join(" "),
    prompt: [
      `Chat: ${context.conversationTitle ?? "untitled"}`,
      `Window: ${context.from} to ${context.through}${
        context.remaining > 0 ? ` (${context.remaining} more messages after this window)` : ""
      }`,
      "",
      context.owner
        ? `The owner: ${context.owner.id}  ${context.owner.displayName}`
        : "The owner has no record in this silo.",
      "People in this chat:",
      ...context.people.map(
        (person) =>
          `  ${person.id}  ${person.displayName}  (writes as ${person.senderNames.join(", ")})`,
      ),
      "",
      context.knownEvents.length > 0
        ? [
            "Already logged around this window:",
            ...context.knownEvents.map(
              (event) =>
                `  ${event.occurredAt}  ${event.type}  ${event.title}  (${event.people.join(", ")})`,
            ),
          ].join("\n")
        : "Nothing is logged around this window yet.",
      "",
      "Already recorded:",
      ...context.knownPreferences.map((person) =>
        [
          `  ${person.displayName}`,
          `    interests: ${person.interests.join(", ") || "none"}`,
          `    dislikes: ${person.dislikes.join(", ") || "none"}`,
          `    allergies: ${person.allergies.join(", ") || "none"}`,
        ].join("\n"),
      ),
      "",
      "Messages, oldest first:",
      ...context.messages.map(
        (message) => `  [${message.sentAt}] ${message.sender}: ${message.body}`,
      ),
      "",
      "Recap this window: a short summary, the events, and the new preferences.",
    ].join("\n"),
  };
}

/** Matches worth showing: a personId, and not a guess. */
export function confidentMatches(matches: SenderMatch[]): SenderMatch[] {
  return matches.filter(
    (match) => match.personId !== null && match.confidence !== "low",
  );
}
