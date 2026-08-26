import { describe, expect, it } from 'vitest';
import { findTeacher, type TeacherEvidence } from './teachers.js';

/**
 * Who teaches a course.
 *
 * Classroom knows and will not say without a roster scope the school has to
 * approve. Two things in the vault answer it instead, and neither alone is
 * enough.
 *
 * The school puts students on one mail domain and staff on another, which is
 * the fact everything here rests on. Without it the maths teacher lost to a
 * classmate: she wrote only ever about maths and he also coached robotics, so
 * a rule rewarding exclusivity picked her and threw him out.
 *
 * With students gone, whoever writes to a class about it is usually its
 * teacher -- but not always, because a year head writes to every class. So
 * where a course's own announcements name somebody, the teacher must be one
 * of those names. That is what keeps the year head out of French.
 */

const evidence = (over: Partial<TeacherEvidence> = {}): TeacherEvidence => ({
  postedNames: [],
  staffMail: [],
  ...over,
});

describe('finding the teacher of a course', () => {
  it('takes the one member of staff who writes about it', () => {
    // Grade 10 Math posts no announcements at all and exactly one member of
    // staff writes about it. That is the teacher.
    expect(findTeacher(evidence({ staffMail: [{ name: 'Chris George', letters: 9 }] }))).toBe(
      'Chris George',
    );
  });

  it('does not mistake a classmate for a teacher', () => {
    /*
     * The failure that started this. A classmate emails about maths homework
     * and about nothing else, which looks exactly like devotion to one
     * subject. Only staff are ever candidates, so she is not in this list at
     * all -- and the rule that admits people is the mail domain, not the shape
     * of their correspondence.
     */
    expect(findTeacher(evidence({ staffMail: [] }))).toBeNull();
  });

  it('keeps a year head out of a class he only writes to', () => {
    /*
     * The same man writes about maths, French and robotics. He teaches one of
     * them. French posts announcements naming two other people and never him,
     * so he cannot be the French teacher whatever the postbag says.
     */
    expect(
      findTeacher(
        evidence({
          postedNames: ['Ms Coretti', 'Ms Marzilli'],
          staffMail: [
            { name: 'Chris George', letters: 6 },
            { name: 'Lucia Coretti', letters: 1 },
          ],
        }),
      ),
    ).toBe('Lucia Coretti');
  });

  it('says nothing when the announcements and the postbag name nobody in common', () => {
    // Robotics: the announcements name two people, and a third writes the
    // mail. Something is going on and none of it is certain.
    expect(
      findTeacher(
        evidence({
          postedNames: ['Mr Olive', 'Mr Skrovanek'],
          staffMail: [{ name: 'Chris George', letters: 3 }],
        }),
      ),
    ).toBeNull();
  });

  it('prefers the busiest writer when several staff are named in announcements', () => {
    expect(
      findTeacher(
        evidence({
          postedNames: ['Ms Mahoney'],
          staffMail: [
            { name: 'Sarah Mahoney', letters: 7 },
            { name: 'Chris George', letters: 3 },
          ],
        }),
      ),
    ).toBe('Sarah Mahoney');
  });

  it('refuses to choose between two members of staff with nothing to separate them', () => {
    expect(
      findTeacher(
        evidence({
          staffMail: [
            { name: 'Ms Bergman', letters: 4 },
            { name: 'Mrs Owen', letters: 4 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('says nothing when nobody at all writes about the course', () => {
    expect(findTeacher(evidence())).toBeNull();
  });
});
