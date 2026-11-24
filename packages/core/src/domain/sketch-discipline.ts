/**
 * What a sketch may contain, enforced rather than requested.
 *
 * The rule, from docs/SPEC.md section 13: observable behaviour, with a quote or
 * a number behind every claim. No diagnosis, no attachment styles, no inferred
 * mental health, no personality typing. "Slow to reply" is an observation;
 * "avoidant" is a diagnosis wearing an observation's clothes.
 *
 * A prompt only asks for that. A grammar can force the shape of a draft, and
 * this forces its content: the words below are the ones that turn a sketch into
 * a horoscope with a clinical accent, and a draft carrying one is refused
 * whatever else it says.
 */

export interface SketchFinding {
  /** Which field the term was found in. */
  field: string;
  /** The text that matched, as written. */
  term: string;
  reason: string;
}

interface Rule {
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    pattern: /\battachment style\b|\b(securely|anxiously|avoidantly)\s+attached\b|\b(anxious|avoidant|disorganised|disorganized|fearful)[- ]?(attachment|avoidant)\b/i,
    reason: "Attachment styles are a diagnosis, not an observation.",
  },
  {
    pattern: /\b(avoidant|codependent|co-dependent|narcissistic|narcissist|borderline|neurotic|histrionic)\b/i,
    reason: "That is a clinical label. Describe the behaviour you saw instead.",
  },
  {
    pattern: /\b[EI][NS][FT][JP]\b|\bmyers[- ]?briggs\b|\bmbti\b|\benneagram\b|\btype\s[1-9]w[1-9]\b|\bbig five\b|\bdisc profile\b/i,
    reason: "Personality typing was rejected: it does not help decide where to take someone to dinner.",
  },
  {
    pattern: /\b(adhd|autis(m|tic)|on the spectrum|neurodivergent|bipolar|ocd|ptsd|cptsd|depressive|clinically\s+\w+)\b/i,
    reason: "That reads as a mental health inference. Not a sketch's business.",
  },
  {
    pattern: /\b(trauma|traumatised|traumatized|triggered by|abandonment issues|daddy issues|mommy issues|love language)\b/i,
    reason: "That is inferred psychology rather than something the history shows.",
  },
  {
    pattern: /\b(diagnos(e|ed|is)|pathological|disorder)\b/i,
    reason: "A sketch does not diagnose.",
  },
];

/** The fields a draft can hide a diagnosis in. */
export interface SketchDraft {
  summary?: string | null | undefined;
  whatLands?: string | null | undefined;
  whatToAvoid?: string | null | undefined;
  opener?: string | null | undefined;
  traits?:
    | Array<{ key: string; label: string; left: string; right: string; value: number }>
    | null
    | undefined;
}

/** Every diagnosis-shaped phrase in a draft. Empty when the draft is clean. */
export function checkSketch(draft: SketchDraft): SketchFinding[] {
  const findings: SketchFinding[] = [];

  const fields: Array<[string, string | null | undefined]> = [
    ["summary", draft.summary],
    ["whatLands", draft.whatLands],
    ["whatToAvoid", draft.whatToAvoid],
    ["opener", draft.opener],
  ];

  for (const trait of draft.traits ?? []) {
    fields.push(
      [`traits.${trait.key}.label`, trait.label],
      [`traits.${trait.key}.left`, trait.left],
      [`traits.${trait.key}.right`, trait.right],
    );
  }

  for (const [field, text] of fields) {
    if (!text) continue;
    for (const rule of RULES) {
      const match = rule.pattern.exec(text);
      if (match) {
        findings.push({ field, term: match[0], reason: rule.reason });
      }
    }
  }

  return findings;
}

/** The same rules over the evidence behind each personality score. */
export function checkPersonality(
  scores: ReadonlyArray<{ key: string; evidence: string }>,
): SketchFinding[] {
  const findings: SketchFinding[] = [];
  for (const score of scores) {
    for (const rule of RULES) {
      const match = rule.pattern.exec(score.evidence);
      if (match) {
        findings.push({
          field: `scores.${score.key}.evidence`,
          term: match[0],
          reason: rule.reason,
        });
      }
    }
  }
  return findings;
}

/** One line a caller can act on, naming every term that has to go. */
export function explainFindings(findings: SketchFinding[]): string {
  const parts = findings.map(
    (finding) => `"${finding.term}" in ${finding.field}: ${finding.reason}`,
  );
  return `This sketch reads as a diagnosis rather than as observed behaviour. ${parts.join(" ")} Rewrite it as what the history shows, with a quote or a number behind each claim.`;
}
