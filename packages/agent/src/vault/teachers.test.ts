import { describe, expect, it } from 'vitest';
import { teacherFor, teacherFromMail } from './teachers.js';

/**
 * Working out who teaches a course, from what they wrote in it.
 *
 * Classroom knows the answer and will not say without a roster scope a school
 * has to approve -- userProfiles.get is a 403 on this account. What is left is
 * the announcements themselves, where a teacher routinely names themselves.
 *
 * Measured across nineteen real courses, that is a sparse and noisy signal: it
 * names the supervisor of the Personal Project and the head of the business
 * club, and says nothing at all about maths, English or science. So the job
 * here is not to find a teacher for every course. It is to be right when it
 * speaks and silent when it cannot be.
 */

const said = (...texts: string[]) => texts;

describe('naming the teacher of a course', () => {
  it('names somebody the announcements keep mentioning', () => {
    expect(
      teacherFor(
        said(
          'Ms. Takacs will collect the process journals on Friday.',
          'Bring your draft to Ms. Takacs before the deadline.',
          'Ms Takacs has posted the criterion B guidance.',
        ),
      ),
    ).toBe('Ms Takacs');
  });

  it('treats "Ms." and "Ms" and a possessive as one person', () => {
    // A real course had Mr Shaw's(9), Mr Shaw(3) and Mr Shaws(2), which is one
    // man mentioned fourteen times and looks like three people who lost.
    expect(
      teacherFor(
        said(
          "Mr Shaw's office hours are Tuesday.",
          'See Mr. Shaw about the pitch.',
          'Mr Shaw will judge.',
        ),
      ),
    ).toBe('Mr Shaw');
  });

  it('says nothing when two names are mentioned as often as each other', () => {
    /*
     * Robotics had Mr Olive twice and Mr Skrovanek twice. One of them may
     * teach it and the other may run the club, and picking the first
     * alphabetically would be inventing an answer.
     */
    expect(teacherFor(said('Mr. Olive is away.', 'Ask Mr. Skrovanek.'))).toBeNull();
  });

  it('says nothing when a course has no announcements at all', () => {
    // Grade 10 Math, on a real account: nothing to read, so nothing to say.
    expect(teacherFor([])).toBeNull();
  });

  it('says nothing when the announcements name nobody', () => {
    // Enriched English had twelve announcements and not one name in them.
    expect(teacherFor(said('The essay is due Friday.', 'Read chapter four.'))).toBeNull();
  });

  it('is not fooled by a word that follows a title-shaped abbreviation', () => {
    /*
     * "M. Attached" was named the teacher of Le Parlement des jeunes eight
     * times over, because every note listing a file says "Attached:" and M.
     * is a French title. A regex that will believe anything capitalised will
     * eventually put a filename in front of every conversation.
     */
    expect(
      teacherFor(said('Attached: the bill.', 'Attached: the schedule.', 'Attached: notes.')),
    ).toBeNull();
  });

  it('wants more than a single passing mention', () => {
    // One reference is somebody named in passing, not somebody who teaches.
    expect(teacherFor(said('Ms. Lafave sent this over.'))).toBeNull();
  });
});

describe('naming a teacher from who writes about the course', () => {
  /**
   * The second signal, and the better one.
   *
   * Announcements name a teacher for four courses of nineteen and say nothing
   * about maths, English or science. But mail carries a sender, and a teacher
   * writes to their own class: on a real account Daniella Malka's course mail
   * was 100% about Grade 10 Math and Mrs Irwin's was 100% about enriched
   * English -- the two subjects the announcements knew nothing about.
   *
   * Exclusivity is what makes it work. The most prolific sender overall wrote
   * about maths, French and robotics alike, which is what an administrator
   * looks like and is exactly the correlation that produced a wrong teacher
   * the first time.
   */
  it('names somebody who writes about one course and nothing else', () => {
    expect(
      teacherFromMail(
        [
          { actor: 'Daniella Malka', courses: ['grade-10-math'] },
          { actor: 'Daniella Malka', courses: ['grade-10-math'] },
          { actor: 'Daniella Malka', courses: ['grade-10-math'] },
        ],
        'grade-10-math',
      ),
    ).toBe('Daniella Malka');
  });

  it('ignores somebody who writes about everything', () => {
    // The shape of an administrator, and the trap that started all this.
    const everywhere = [
      { actor: 'Chris George', courses: ['grade-10-math'] },
      { actor: 'Chris George', courses: ['french-10'] },
      { actor: 'Chris George', courses: ['robotics'] },
      { actor: 'Chris George', courses: ['grade-10-math'] },
    ];
    expect(teacherFromMail(everywhere, 'grade-10-math')).toBeNull();
  });

  it('wants more than one or two letters before it believes anyone', () => {
    expect(
      teacherFromMail(
        [{ actor: 'A Passing Stranger', courses: ['grade-10-math'] }],
        'grade-10-math',
      ),
    ).toBeNull();
  });

  it('treats a titled and untitled rendering of one person as one person', () => {
    // A real vault held Sarah Mahoney (7) and Ms. Mahoney (4), one woman.
    expect(
      teacherFromMail(
        [
          { actor: 'Sarah Mahoney', courses: ['drama'] },
          { actor: 'Ms. Mahoney', courses: ['drama'] },
          { actor: 'Sarah Mahoney', courses: ['drama'] },
        ],
        'drama',
      ),
    ).toBe('Sarah Mahoney');
  });

  it('says nothing when nobody writes about the course at all', () => {
    expect(teacherFromMail([], 'grade-10-math')).toBeNull();
  });
});
