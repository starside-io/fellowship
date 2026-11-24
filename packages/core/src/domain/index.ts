// One namespace per module. insights and chat-insights both speak of cadence
// and of trends, and they mean different things by them, so flattening the two
// into one surface would make the collision look like a coincidence.
export * as chatInsights from "./chat-insights.js";
export * as insights from "./insights.js";
export * as linkEngine from "./link-engine.js";
export * as scoring from "./scoring.js";
export * as socials from "./socials.js";
export * as socialsCheck from "./socials-check.js";
export * as avatarColour from "./avatar-colour.js";
export * as chatStore from "./chat-store.js";
export * as drafting from "./drafting/index.js";
export * as graph from "./graph.js";
export * as sketchDiscipline from "./sketch-discipline.js";
export * as transfer from "./transfer/index.js";
