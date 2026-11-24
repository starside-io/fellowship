/**
 * The payload this package consumes, and the only thing it knows about the
 * rest of the system.
 *
 * It is `people.graph` as it arrives over POST /rpc, which means dates are
 * strings: the server types them as Date, JSON does not carry one, and
 * pretending otherwise is how a graph ends up drawing NaN. Everything here
 * takes `string | Date` and normalizes with toDate.
 *
 * Nothing in this package reads a database, calls a tool or knows a host
 * exists. Hand it a payload and it draws; that is the whole contract, and it
 * is why the graph is the one view that would survive being pointed at a
 * different data module.
 */

export type GraphDate = string | Date | null;

export interface GraphCircle {
  id: string;
  name: string;
  colour: string;
}

export interface GraphPerson {
  id: string;
  displayName: string;
  avatarColor: string;
  isSelf: boolean;
  circles: GraphCircle[];
  /** Score of the link with the self record, 0 when there is none. */
  closeness: number;
}

export interface GraphEventParticipant {
  personId: string;
  sentiment: number | null;
}

export interface GraphEvent {
  id: string;
  occurredAt: GraphDate;
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
  lastEventAt: GraphDate;
  pinned: boolean;
  manualScore: number | null;
  /** True for a synthesized "knows them" thread with no Link row behind it. */
  implicit: boolean;
}

export interface GraphPayload {
  people: GraphPerson[];
  events: GraphEvent[];
  links: GraphLink[];
}
