/**
 * The difference between what the vault saw and what somebody made of it.
 *
 * Every note in the vault is an observation: this message was sent, this file
 * hangs off this course, this person's address is on this domain. None of it
 * says what any of it means. Meaning was being worked out separately by three
 * readers -- the digest, the pass that writes user.md, and the agent mid-turn
 * -- each from a partial view, each with no way to record that it had guessed.
 * That is why more data made the answers worse: "French" is a house here as
 * well as a subject, and whoever writes to a class is usually, but not always,
 * the person teaching it.
 *
 * A claim carries its own status. Observed means read off a note. Inferred
 * means somebody put several notes together, and then it owes evidence, a
 * confidence, and the other readings the same evidence would support.
 *
 * Settling is deliberately free of models. The model proposes and this
 * disposes, because a model asked to check its own reasoning tends to fail
 * the second time in the direction it failed the first. Everything here is a
 * count or a comparison, and every rejection is reported rather than dropped.
 */

/** A note, and the words in it that carry the claim. */
export interface Evidence {
  /** The note's name, so a person can open it. */
  note: string;
  /** The sentence it rests on, quoted rather than paraphrased. */
  quote: string;
}

export interface Claim {
  /** The note this is about. */
  subject: string;
  /**
   * What the subject is to the object, in open words.
   *
   * Not a fixed vocabulary. A closed list of edge types force-fits whatever
   * it did not anticipate, and this school has houses, form tutors, coaches
   * and heads of year -- all of which a tidy four-item list would have
   * flattened into "teaches", which is exactly the error being fixed.
   */
  relation: string;
  object: string;
  /** Read off a note, or worked out from several. */
  basis: 'observed' | 'inferred';
  /** Where it was read from. Required for an inference; see settle. */
  evidence: Evidence[];
  /** Inferences only, 0 to 1. An observation is not more or less sure. */
  confidence?: number;
  /** What else this evidence would support, if anything. */
  alternatives?: string[];
}

/** Why a claim did not survive. Reported, never silent. */
export type WithheldReason =
  /** An inference that cannot say what it was read from. */
  | 'no-evidence'
  /** Below the bar for being worth saying at all. */
  | 'low-confidence'
  /** A rival reading of the same slot, too close to separate. */
  | 'no-clear-lead'
  /** Two sources state different answers and nothing can adjudicate. */
  | 'contradicted';

export interface Withheld {
  claim: Claim;
  reason: WithheldReason;
}

export interface Settlement {
  settled: Claim[];
  withheld: Withheld[];
}

export interface SettleOptions {
  /**
   * Relations that admit one answer per subject.
   *
   * Everything else may hold many, which is the default because contention is
   * the unusual case. This is a statement about how many answers a question
   * has, not a list of questions that may be asked -- relations outside it
   * pass through untouched, so the vocabulary stays open.
   */
  single?: readonly string[];
}

/** Below this, an inference is not worth the space it takes. */
const CONFIDENT = 0.6;

/**
 * How far a leader must be clear of its nearest rival.
 *
 * The French teacher was wrong because a tie between two members of staff was
 * broken on one piece of mail against none. One is not a lead over zero, it is
 * noise that happened not to be zero, and the rule that read it as decisive
 * had no floor under it at all. Two readings this close mean the evidence does
 * not separate them, and the honest output is neither.
 */
const MARGIN = 0.2;

export function settle(claims: readonly Claim[], { single = [] }: SettleOptions = {}): Settlement {
  const settled: Claim[] = [];
  const withheld: Withheld[] = [];

  const singleValued = new Set(single);
  const slots = new Map<string, Claim[]>();

  /** Worth saying at all, once it has won whatever it had to win. */
  const assert_ = (claim: Claim) => {
    if (claim.basis === 'inferred' && (claim.confidence ?? 0) < CONFIDENT) {
      withheld.push({ claim, reason: 'low-confidence' });
      return;
    }
    settled.push(claim);
  };

  for (const claim of claims) {
    /*
     * Evidence first, and alone, because a claim with none cannot be
     * checked, shown to a student who asks why, or refuted -- so it is not a
     * claim at all and has no business competing for a slot.
     */
    if (claim.basis === 'inferred' && claim.evidence.length === 0) {
      withheld.push({ claim, reason: 'no-evidence' });
      continue;
    }

    if (!singleValued.has(claim.relation)) {
      assert_(claim);
      continue;
    }
    const slot = `${claim.subject} ${claim.relation}`;
    slots.set(slot, [...(slots.get(slot) ?? []), claim]);
  }

  /*
   * Contention is settled before confidence, not after.
   *
   * Getting this the other way round reproduces the exact bug it exists to
   * stop. The rival French teacher was a weak reading -- one piece of mail
   * against none -- and dropping her for being weak left the other name
   * unopposed and therefore certain. A rival too poor to be asserted itself
   * is still evidence that the question has more than one answer, and a
   * leader that cannot pull clear of one has not earned the slot.
   */
  for (const rivals of slots.values()) {
    if (new Set(rivals.map((c) => c.object)).size === 1) {
      assert_(rivals[0] as Claim);
      continue;
    }

    /*
     * An observation is not in competition with an inference. Where a source
     * states the answer outright, no amount of reasoning about who writes the
     * most mail gets to overrule it.
     */
    const observed = rivals.filter((c) => c.basis === 'observed');
    if (observed.length > 0) {
      if (new Set(observed.map((c) => c.object)).size > 1) {
        // Two sources, two answers, one slot. Picking either is arbitrary.
        for (const claim of rivals) withheld.push({ claim, reason: 'contradicted' });
        continue;
      }
      assert_(observed[0] as Claim);
      for (const loser of rivals.filter((c) => c.basis !== 'observed')) {
        withheld.push({ claim: loser, reason: 'no-clear-lead' });
      }
      continue;
    }

    const ranked = [...rivals].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const leader = ranked[0] as Claim;
    const runnerUp = ranked.find((c) => c.object !== leader.object);

    if (runnerUp && (leader.confidence ?? 0) - (runnerUp.confidence ?? 0) < MARGIN) {
      for (const claim of rivals) withheld.push({ claim, reason: 'no-clear-lead' });
      continue;
    }

    assert_(leader);
    for (const loser of ranked.slice(1)) {
      if (loser.object !== leader.object) withheld.push({ claim: loser, reason: 'no-clear-lead' });
    }
  }

  return { settled, withheld };
}
