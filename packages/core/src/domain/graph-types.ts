// Shared contract between the graph data layer and the graph UI.
// Client-safe: no Prisma imports.

export interface GraphPerson {
  id: string;
  displayName: string;
  avatarColor: string;
  isSelf: boolean;
  circles: { id: string; name: string; colour: string }[];
  // Score of the link between this person and the self node, 0 when none.
  closeness: number;
}

export interface GraphEventParticipant {
  personId: string;
  sentiment: number | null;
}

export interface GraphEvent {
  id: string;
  occurredAt: Date;
  type: string;
  sentiment: number;
  weight: number;
  participants: GraphEventParticipant[];
}

export interface GraphLink {
  aPersonId: string;
  bPersonId: string;
  tie: string;
  score: number;
  eventCount: number;
  lastEventAt: Date | null;
  pinned: boolean;
  manualScore: number | null;
  /** True for synthesized "knows them" threads that have no Link row. */
  implicit: boolean;
}

// events carry enough raw data for the client to replay scores over a
// date range with the shared scoring lib.
export interface GraphPayload {
  people: GraphPerson[];
  events: GraphEvent[];
  links: GraphLink[];
}

export interface ConnectionEntry {
  person: {
    id: string;
    displayName: string;
    avatarColor: string;
    circles: { id: string; name: string; colour: string }[];
  };
  tie: string;
  score: number;
  eventCount: number;
  lastEventAt: Date | null;
}
