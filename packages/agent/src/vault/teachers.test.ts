import { describe, expect, it } from 'vitest';
import { teacherFor } from './teachers.js';

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
