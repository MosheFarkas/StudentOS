/**
 * Vaults small enough to know the right answer for.
 *
 * Every case here is a failure this product actually shipped, reduced to the
 * few notes that caused it. That matters more than volume: a corpus of
 * plausible-looking invented schools would measure whether a model can read,
 * which was never in doubt. What was in doubt is whether it can decline, and
 * these are the shapes it declined to decline on -- a classmate who emails
 * about one subject, a head of year who writes to every class, a house sharing
 * its name with a subject, a template line that parses as a name.
 *
 * `expect: null` is the answer in most of them, and that is the point. A vault
 * that says nothing about who teaches maths is in better shape than one that
 * says the wrong thing, because a wrong teacher is read aloud before every
 * conversation that student ever has.
 */

export interface FixtureNote {
  name: string;
  /** Staff and students are told apart by mail domain and nothing else. */
  email?: string;
  full?: string;
}

export interface FixtureEpisode {
  id: string;
  actor: string;
  body: string;
  /** Defaults to a date inside the school year. */
  on?: string;
}

export interface InterpretationCase {
  id: string;
  /** What went wrong when this shape reached production. */
  trap: string;
  course: string;
  people: FixtureNote[];
  episodes: FixtureEpisode[];
  /** The correct answer, or null when the honest answer is that nobody knows. */
  expect: string | null;
}

const STUDENT_DOMAIN = 'wearelcc.ca';
export { STUDENT_DOMAIN };

/**
 * Staff and students, slugged the way the importer slugs them.
 *
 * First name then surname, because the surname is read off the last segment
 * of the slug everywhere else in the vault. An earlier version of these
 * fixtures had it the other way round, which quietly turned every "surname"
 * into a first name and disarmed the one case built to test surname
 * collisions -- a fixture that agrees with a bug is worse than no fixture.
 */
const slugOf = (full: string) =>
  full
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .join('-');

const staff = (full: string) => ({ name: slugOf(full), full, email: `${initial(full)}@lcc.ca` });
const pupil = (full: string) => ({
  name: slugOf(full),
  full,
  email: `${initial(full)}@${STUDENT_DOMAIN}`,
});
const initial = (full: string) => {
  const parts = full.split(' ');
  return `${(parts[0] ?? '').charAt(0)}${parts.at(-1) ?? ''}`.toLowerCase();
};

export const INTERPRETATION_CASES: InterpretationCase[] = [
  {
    id: 'clear-teacher',
    trap: 'The easy case. If this fails, the pass is too shy to be useful.',
    course: 'chemistry-10',
    people: [staff('Anna Bell')],
    episodes: [
      {
        id: 'c1',
        actor: 'Anna Bell',
        body: 'Mrs Bell here. Your titration write-ups are marked and back on Monday. We will start Unit 4 in class on Tuesday. In [[chemistry-10]].',
      },
      {
        id: 'c2',
        actor: 'Anna Bell',
        body: 'Reminder: the practical assessment I set is due Friday. Bring your lab books to my lesson. In [[chemistry-10]].',
      },
    ],
    expect: 'Anna Bell',
  },

  {
    id: 'classmate-only-writes-about-maths',
    trap: 'A Grade 10 student was named the maths teacher. She emailed about maths and nothing else, which looks exactly like devotion to one subject and is in fact what struggling with one subject looks like.',
    course: 'maths-10',
    people: [pupil('Daniella Malka'), staff('Chris George')],
    episodes: [
      {
        id: 'm1',
        actor: 'Daniella Malka',
        body: 'does anyone understand q7 on the sheet? In [[maths-10]].',
      },
      {
        id: 'm2',
        actor: 'Daniella Malka',
        body: 'has anyone started the review problems yet, im stuck on the whole page. In [[maths-10]].',
      },
      {
        id: 'm3',
        actor: 'Daniella Malka',
        body: 'is the test still tuesday? In [[maths-10]].',
      },
      {
        id: 'm4',
        actor: 'Chris George',
        body: 'Mr George. The unit test is Tuesday as scheduled. I have posted the review problems and I will go over them in class Monday. In [[maths-10]].',
      },
    ],
    expect: 'Chris George',
  },

  {
    id: 'house-shares-a-name-with-a-subject',
    trap: 'The failure that started this. French is a house here as well as a subject, and the head of French house was named the French teacher. Two uses of one word are two things until something joins them.',
    course: 'french-10',
    people: [staff('Lucia Coretti')],
    episodes: [
      {
        id: 'f1',
        actor: 'Lucia Coretti',
        body: 'Mme Coretti, Head of French House. House points assembly is Thursday in the gym. French House is currently second. In [[french-10]].',
      },
      {
        id: 'f2',
        actor: 'Lucia Coretti',
        body: 'Mme Coretti. French House sign-ups for the swim gala close Friday. All houses compete. In [[french-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'head-of-year-writes-to-every-class',
    trap: 'A head of year was named the teacher of a course he wrote to constantly. He wrote to every course he looked after, which is what heads of year do.',
    course: 'history-10',
    people: [staff('Chris George'), staff('Gillian Shadley')],
    episodes: [
      {
        id: 'h1',
        actor: 'Chris George',
        body: 'Mr George, Head of Grade 10. Reminder to all Grade 10 classes that reports go home Friday and the assembly is moved to period 3. In [[history-10]].',
      },
      {
        id: 'h2',
        actor: 'Chris George',
        body: 'Mr George, Head of Grade 10. Please make sure your locker is cleared before the break. This applies across the grade. In [[history-10]].',
      },
      {
        id: 'h3',
        actor: 'Chris George',
        body: 'Mr George, Head of Grade 10. Photo day is Wednesday, full uniform for every Grade 10 class. In [[history-10]].',
      },
      {
        id: 'h4',
        actor: 'Gillian Shadley',
        body: 'Ms Shadley. I have marked your source analyses and we will go through them in Thursday period. The essay I set on the causes of the war is due the following week. In [[history-10]].',
      },
    ],
    expect: 'Gillian Shadley',
  },

  {
    id: 'two-staff-named-equally',
    trap: 'The exact French error: a tie between two members of staff was broken on one piece of mail against none, and the answer it produced was wrong. One is not a lead over zero.',
    course: 'spanish-10',
    people: [staff('Anna Marzilli'), staff('Marie Duval')],
    episodes: [
      {
        id: 's1',
        actor: 'Anna Marzilli',
        body: 'Mme Marzilli. Vocabulary quiz Thursday. In [[spanish-10]].',
      },
      {
        id: 's2',
        actor: 'Marie Duval',
        body: 'Mme Duval. Please bring your workbooks Thursday. In [[spanish-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'attached-parses-as-a-name',
    trap: '"M. Attached" was named a teacher eight times over, because every note listing a file says "Attached:" and M. is a French title in a bilingual school.',
    course: 'geography-10',
    people: [staff('Luc Tremblay')],
    episodes: [
      {
        id: 'g1',
        actor: 'Google Classroom',
        body: 'New material posted. Attached: map-skills-worksheet.pdf. Attached: rivers-diagram.png. In [[geography-10]].',
      },
      {
        id: 'g2',
        actor: 'Google Classroom',
        body: 'New material posted. Attached: glaciation-notes.pdf. In [[geography-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'trip-organiser',
    trap: 'Writing to a class often is what teachers do. It is also what trip organisers, librarians and the person running the bus list do.',
    course: 'biology-10',
    people: [staff('Ngozi Okafor')],
    episodes: [
      {
        id: 'b1',
        actor: 'Ngozi Okafor',
        body: 'Ms Okafor. Field trip consent forms for the wetlands visit are due Friday. Coach leaves at 7.30am. In [[biology-10]].',
      },
      {
        id: 'b2',
        actor: 'Ngozi Okafor',
        body: 'Ms Okafor. Reminder about the wetlands trip: packed lunch, waterproofs, no phones on the coach. In [[biology-10]].',
      },
      {
        id: 'b3',
        actor: 'Ngozi Okafor',
        body: 'Ms Okafor. The trip has been moved to the following Tuesday because of the forecast. In [[biology-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'club-lead-is-not-a-teacher',
    trap: 'A club that once posted a form has set work. That does not make whoever runs it anybody’s teacher, and the document is not supposed to say it does.',
    course: 'model-un',
    people: [staff('Irina Petrov')],
    episodes: [
      {
        id: 'u1',
        actor: 'Irina Petrov',
        body: 'Ms Petrov. Position papers for the conference are due before we travel. Delegations will be assigned at the Wednesday lunch meeting. In [[model-un]].',
      },
      {
        id: 'u2',
        actor: 'Irina Petrov',
        body: 'Ms Petrov. Reminder that Model UN meets Wednesday lunchtime in room 12. New members welcome. In [[model-un]].',
      },
    ],
    expect: null,
  },

  {
    id: 'admin-notice-only',
    trap: 'Presence is not a relation. Somebody named in a course is involved in it; nothing about that says what they do there.',
    course: 'english-10',
    people: [staff('Sofia Ramirez')],
    episodes: [
      {
        id: 'e1',
        actor: 'Sofia Ramirez',
        body: 'Ms Ramirez, Library. Overdue books for this class must be returned before the end of term. In [[english-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'teacher-who-also-runs-a-club',
    trap: 'The rule that rewarded exclusivity threw out the real teacher for also coaching robotics, and handed the subject to a classmate who only ever wrote about it.',
    course: 'physics-10',
    people: [staff('Ken Nakamura')],
    episodes: [
      {
        id: 'p1',
        actor: 'Ken Nakamura',
        body: 'Mr Nakamura. Robotics club is cancelled this Thursday, we will meet next week instead. In [[robotics-club]].',
      },
      {
        id: 'p2',
        actor: 'Ken Nakamura',
        body: 'Mr Nakamura. I have marked your momentum problem sets. We will cover circular motion in Monday’s lesson and the homework I set is due Wednesday. In [[physics-10]].',
      },
      {
        id: 'p3',
        actor: 'Ken Nakamura',
        body: 'Mr Nakamura. Practical write-ups are due at the start of my Thursday class. In [[physics-10]].',
      },
    ],
    expect: 'Ken Nakamura',
  },

  {
    id: 'shared-surname',
    trap: 'Surname matching joined two different people at this school. A parent and a member of staff sharing a surname is not exotic, and neither is a sibling.',
    course: 'drama-10',
    people: [staff('Anna Bell'), pupil('Tom Bell')],
    episodes: [
      {
        id: 'd1',
        actor: 'Tom Bell',
        body: 'anyone know if we need scripts printed for tomorrow? In [[drama-10]].',
      },
      {
        id: 'd2',
        actor: 'Tom Bell',
        body: 'i can bring the props if someone else does the lights. In [[drama-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'former-teacher-left',
    trap: 'A course that changed hands. The recent half of the evidence is the half that is still true, and a count over the whole year prefers whoever was there longest.',
    course: 'geometry-10',
    people: [staff('Joao Silva'), staff('Tolu Adeyemi')],
    episodes: [
      {
        id: 'x1',
        actor: 'Joao Silva',
        body: 'Mr Silva. Proofs homework due Friday. In [[geometry-10]].',
        on: '2025-09-15',
      },
      {
        id: 'x2',
        actor: 'Joao Silva',
        body: 'Mr Silva. We will finish circle theorems this week. In [[geometry-10]].',
        on: '2025-10-02',
      },
      {
        id: 'x3',
        actor: 'Joao Silva',
        body: 'Mr Silva. This is my last week before I move schools. Ms Adeyemi will take over the class. In [[geometry-10]].',
        on: '2025-11-20',
      },
      {
        id: 'x4',
        actor: 'Tolu Adeyemi',
        body: 'Ms Adeyemi. I am taking this class from now on. Your trigonometry assignment is due Thursday and I will mark it over the weekend. In [[geometry-10]].',
        on: '2026-01-12',
      },
      {
        id: 'x5',
        actor: 'Tolu Adeyemi',
        body: 'Ms Adeyemi. We will start the revision unit in Monday’s lesson. In [[geometry-10]].',
        on: '2026-02-03',
      },
    ],
    expect: 'Tolu Adeyemi',
  },

  /*
   * Below here: cases built to make a careful proposer confident and wrong.
   *
   * The first twelve were the failures this product shipped, and the
   * abstention contract cleared all of them -- which left nothing for the
   * refutation step to catch and no way to tell whether it works. A step whose
   * value cannot be measured is a step that gets kept for the wrong reasons.
   * These are the shapes where saying something plausible is easiest.
   */

  {
    id: 'teacher-never-writes',
    trap: 'The strongest bait there is. The person who actually teaches this class never emails; a prefect on the staff mail system runs everything visible about it. Every signal points at somebody who is not the answer.',
    course: 'latin-10',
    people: [staff('Robert Hale')],
    episodes: [
      {
        id: 'l1',
        actor: 'Robert Hale',
        body: 'Mr Hale, Academic Support. I am posting the vocabulary lists for this class on behalf of the department. Translation practice is due Friday. In [[latin-10]].',
      },
      {
        id: 'l2',
        actor: 'Robert Hale',
        body: 'Mr Hale, Academic Support. Reminder that the declension quiz has been set for this class. Please complete it before the lesson. In [[latin-10]].',
      },
      {
        id: 'l3',
        actor: 'Robert Hale',
        body: 'Mr Hale, Academic Support. I have uploaded the marked translations for this class. In [[latin-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'covering-a-lesson',
    trap: 'A colleague taking one lesson looks exactly like the person who teaches the course, unless you read the sentence that says otherwise.',
    course: 'economics-10',
    people: [staff('Eszter Varga')],
    episodes: [
      {
        id: 'ec1',
        actor: 'Eszter Varga',
        body: 'Ms Varga. I am covering this class today while your usual teacher is at a conference. Please continue with the supply-and-demand questions. In [[economics-10]].',
      },
      {
        id: 'ec2',
        actor: 'Eszter Varga',
        body: 'Ms Varga. Covering again on Thursday. I will collect the questions I set on Tuesday. In [[economics-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'department-head-speaks-for-the-team',
    trap: 'Institutional we. A head of department writing "we have set" sounds like the person who set it, and is not.',
    course: 'art-10',
    people: [staff('Claire Dubois')],
    episodes: [
      {
        id: 'a1',
        actor: 'Claire Dubois',
        body: 'Mme Dubois, Head of Visual Arts. We have set the portfolio deadline for all Grade 10 art classes as the last Friday of term. Your teacher will confirm the hand-in arrangements. In [[art-10]].',
      },
      {
        id: 'a2',
        actor: 'Claire Dubois',
        body: 'Mme Dubois, Head of Visual Arts. The department has arranged a gallery visit for every Grade 10 art class. In [[art-10]].',
      },
    ],
    expect: null,
  },

  {
    id: 'student-teacher-on-placement',
    trap: 'A trainee does everything a teacher does and is introduced once, in a sentence nobody rereads.',
    course: 'music-10',
    people: [staff('Ada Okonkwo'), staff('Erik Lindqvist')],
    episodes: [
      {
        id: 'mu1',
        actor: 'Erik Lindqvist',
        body: 'Mr Lindqvist. I would like to introduce Miss Okonkwo, who is on teaching placement with us this term and will be taking some of your lessons. In [[music-10]].',
      },
      {
        id: 'mu2',
        actor: 'Ada Okonkwo',
        body: 'Miss Okonkwo. Your composition drafts are due Monday and I will give feedback in the lesson. In [[music-10]].',
      },
      {
        id: 'mu3',
        actor: 'Ada Okonkwo',
        body: 'Miss Okonkwo. Please bring your manuscript books to Wednesday’s class. In [[music-10]].',
      },
      {
        id: 'mu4',
        actor: 'Ada Okonkwo',
        body: 'Miss Okonkwo. I have marked the listening tests and we will go over them together. In [[music-10]].',
      },
    ],
    expect: 'Erik Lindqvist',
  },

  {
    id: 'parent-volunteer-on-staff-mail',
    trap: 'The domain rule does most of the work here, and this is the case that breaks it: a volunteer with a staff address, doing organising that reads as teaching.',
    course: 'design-10',
    people: [staff('James Whitfield')],
    episodes: [
      {
        id: 'de1',
        actor: 'James Whitfield',
        body: 'James Whitfield, parent volunteer. I will be in on Wednesdays to help with the workshop tools. Please bring your project sketches so I can help you plan the build. In [[design-10]].',
      },
      {
        id: 'de2',
        actor: 'James Whitfield',
        body: 'James Whitfield, parent volunteer. Materials for the build have arrived. See me in the workshop on Wednesday. In [[design-10]].',
      },
    ],
    expect: null,
  },
];
