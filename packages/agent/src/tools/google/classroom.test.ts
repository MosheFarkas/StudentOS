import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listAnnouncements,
  listCourseMaterials,
  listCourses,
  listSubmissions,
  MODEL_PAGE,
} from './classroom.js';
import type { ToolContext } from '../types.js';

/**
 * What one tool call is allowed to put into a conversation.
 *
 * Measured on a real account, a single call to list_materials returned 46,613
 * tokens and list_announcements 37,751. Two of them in one turn is 84,000
 * tokens before the model has said anything -- which on a 200k-per-minute
 * limit is a turn that fails outright, and on any account is a turn that costs
 * more than the entire one-off import of the student's Drive.
 *
 * A year of school genuinely is that much material. The tools are not the
 * place to hand all of it over at once.
 */

const ctx = (): ToolContext =>
  ({
    google: { getAccessToken: async () => 'token', hasScope: () => true },
  }) as unknown as ToolContext;

/** A course, and `many` items posted to it. */
function school(many: number, key: 'announcements' | 'courseWorkMaterial') {
  const items = Array.from({ length: many }, (_, i) => ({
    id: `x${i}`,
    text: `Notice number ${i}. `.repeat(40),
    title: `Material number ${i}`,
    creationTime: `2026-0${(i % 9) + 1}-01T10:00:00Z`,
  }));

  vi.stubGlobal('fetch', async (url: string) => {
    const body = /\/courses\?/.test(url)
      ? { courses: [{ id: 'c1', name: 'Chemistry' }] }
      : { [key]: items };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('how much a list tool hands back', () => {
  it('gives the model a page of announcements, not the whole year', async () => {
    school(257, 'announcements');
    const result = (await listAnnouncements.execute({} as never, ctx())) as {
      announcements: unknown[];
      total: number;
    };

    expect(result.announcements).toHaveLength(MODEL_PAGE);
    expect(result.total).toBe(257);
  });

  it('says what it left out, so the model knows the answer is partial', async () => {
    // Silently truncating is worse than not answering: the model reports "that
    // is everything" about a slice it was never told was a slice.
    school(257, 'announcements');
    const result = (await listAnnouncements.execute({} as never, ctx())) as { more: string };
    expect(result.more).toMatch(/257/);
    expect(result.more).toMatch(/course/i);
  });

  it('gives the whole year to a caller that asks for it', async () => {
    // The vault importer needs every one of them, and it pays no model call to
    // read them -- so the cap belongs to the conversation, not to the tool.
    school(257, 'announcements');
    const result = (await listAnnouncements.execute({ limit: 5000 } as never, ctx())) as {
      announcements: unknown[];
    };
    expect(result.announcements).toHaveLength(257);
  });

  it('caps materials the same way', async () => {
    school(230, 'courseWorkMaterial');
    const result = (await listCourseMaterials.execute({} as never, ctx())) as {
      materials: unknown[];
      total: number;
    };
    expect(result.materials).toHaveLength(MODEL_PAGE);
    expect(result.total).toBe(230);
  });

  it('narrows to one course when asked', async () => {
    /*
     * The way out of a truncated answer. Without it the model's only options
     * are the first page or nothing, and "what did my drama teacher post" is
     * unanswerable for a student whose drama notices are not in the newest
     * twenty-five.
     */
    school(30, 'announcements');
    const mine = (await listAnnouncements.execute({ course: 'Chemistry' } as never, ctx())) as {
      announcements: unknown[];
    };
    expect(mine.announcements.length).toBeGreaterThan(0);

    const other = (await listAnnouncements.execute({ course: 'Physics' } as never, ctx())) as {
      announcements: unknown[];
    };
    expect(other.announcements).toHaveLength(0);
  });
});

describe("which courses count as the student's", () => {
  /*
   * A school archives a course when the year ends. On a real account in
   * August, six of nineteen were archived -- both History courses, Science and
   * Technology, Model UN, Debating and the IB Personal Project -- and the
   * vault had none of them, so "what did I get in Science" had no course to
   * even look in.
   *
   * Day to day a student means their current classes, so a conversation still
   * gets those by default. The vault is the opposite case: last year is
   * exactly what it is for.
   */
  function courses(states: Record<string, string[]>) {
    vi.stubGlobal('fetch', async (url: string) => {
      /*
       * getAll, because courseStates is a repeated parameter. Splitting a
       * single value on commas is what the code did, and this stub agreed with
       * it -- so a green test sat on top of a request Classroom answers with a
       * 400. A stub has to model the API, not the caller.
       */
      const asked = new URL(url).searchParams.getAll('courseStates');
      const wanted = asked.length > 0 ? asked : Object.keys(states);
      const list = wanted.flatMap((state) =>
        (states[state] ?? []).map((name, i) => ({
          id: `${state}-${i}`,
          name,
          courseState: state,
        })),
      );
      return new Response(JSON.stringify({ courses: list }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('asks for a repeated parameter, which is the only form Classroom accepts', async () => {
    // `courseStates=ACTIVE,ARCHIVED` is a 400. Verified against the real API,
    // after the comma-joined version took a whole import to zero courses.
    let seen = '';
    vi.stubGlobal('fetch', async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ courses: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await listCourses.execute({ includeArchived: true } as never, ctx());
    expect(seen).toContain('courseStates=ACTIVE&courseStates=ARCHIVED');
    expect(seen).not.toContain('ACTIVE,ARCHIVED');
  });

  it('gives a conversation the classes they are in now', async () => {
    courses({ ACTIVE: ['Grade 10 Math'], ARCHIVED: ['Extended History of Quebec and Canada 10'] });
    const result = (await listCourses.execute({} as never, ctx())) as {
      courses: { name: string }[];
    };
    expect(result.courses.map((c) => c.name)).toEqual(['Grade 10 Math']);
  });

  it('gives the importer last year as well, when it asks', async () => {
    courses({ ACTIVE: ['Grade 10 Math'], ARCHIVED: ['Extended History of Quebec and Canada 10'] });
    const result = (await listCourses.execute({ includeArchived: true } as never, ctx())) as {
      courses: { name: string }[];
    };
    expect(result.courses.map((c) => c.name).sort()).toEqual([
      'Extended History of Quebec and Canada 10',
      'Grade 10 Math',
    ]);
  });

  it('keeps the state the school itself put the course in', async () => {
    /*
     * The only authoritative answer to whether a course is over.
     *
     * Everything else in this product infers it -- from the date of the last
     * assignment, from whether anybody still posts. A school archiving a course
     * when the year ends is the school saying so, and it arrived on every
     * response all along with nothing keeping it.
     */
    courses({ ACTIVE: ['Grade 11 Math'], ARCHIVED: ['Grade 10 History'] });
    const result = (await listCourses.execute({ includeArchived: true } as never, ctx())) as {
      courses: { name: string; courseState?: string }[];
    };
    expect(Object.fromEntries(result.courses.map((c) => [c.name, c.courseState]))).toEqual({
      'Grade 11 Math': 'ACTIVE',
      'Grade 10 History': 'ARCHIVED',
    });
  });
});

describe('the work a student handed in', () => {
  /*
   * A submission's attachments are shaped differently from a coursework
   * material's. Coursework nests it -- {driveFile: {driveFile: {...}}} --
   * and a submission does not: {driveFile: {id, title}}. Reusing the
   * coursework mapper on a submission silently produced nothing, and the
   * importer's own test did not catch it because its fixture handed over
   * attachments that were already mapped. It tested the importer; nothing
   * tested the shape the API actually returns.
   */
  it("reads the student's own file off a submission", async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body = /\/courses\?/.test(url)
        ? { courses: [{ id: 'c1', name: 'Chemistry' }] }
        : {
            studentSubmissions: [
              {
                id: 's1',
                courseId: 'c1',
                courseWorkId: 'w1',
                state: 'TURNED_IN',
                assignmentSubmission: {
                  attachments: [
                    {
                      driveFile: {
                        id: 'mine-1',
                        title: 'Lucas Liu - Activities Ch 4',
                        alternateLink: 'https://drive/mine-1',
                      },
                    },
                  ],
                },
              },
            ],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = (await listSubmissions.execute({} as never, ctx())) as {
      submissions: { attachments?: { title: string; fileId?: string }[] }[];
    };

    const mine = result.submissions[0]?.attachments ?? [];
    expect(mine).toHaveLength(1);
    expect(mine[0]?.title).toBe('Lucas Liu - Activities Ch 4');
    expect(mine[0]?.fileId).toBe('mine-1');
  });
});
