import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectClassroomSnapshot } from './collect.js';
import type { ToolContext } from '../tools/types.js';

/**
 * A school that grants some of Classroom and not the rest.
 *
 * Every scope here is separate and schools withhold them individually --
 * announcements, materials, coursework and topics are four different grants,
 * and a school admin approving three of four is ordinary. The account this was
 * built against granted everything, which is the least informative case there
 * is.
 *
 * What must hold is that a missing scope costs exactly its own source: the
 * import still runs, everything else still lands, and the gap is reported
 * rather than passed off as an empty year.
 */

const ctx = (): ToolContext =>
  ({
    google: { getAccessToken: async () => 'token', hasScope: () => true },
  }) as unknown as ToolContext;

/** Answer each Classroom endpoint, refusing the ones named. */
function classroom(refuse: string[]) {
  vi.stubGlobal('fetch', async (url: string) => {
    const deny = refuse.find((part) => url.includes(part));
    if (deny) {
      return new Response(
        JSON.stringify({
          error: { code: 403, message: 'Request had insufficient authentication scopes.' },
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const body = /\/courses\?/.test(url)
      ? { courses: [{ id: 'c1', name: 'Chemistry' }] }
      : /announcements/.test(url)
        ? { announcements: [{ id: 'a1', text: 'A notice', creationTime: '2026-01-01T10:00:00Z' }] }
        : /courseWorkMaterials/.test(url)
          ? { courseWorkMaterial: [{ id: 'm1', title: 'A reading' }] }
          : /studentSubmissions/.test(url)
            ? {
                studentSubmissions: [
                  { id: 's1', courseId: 'c1', courseWorkId: 'w1', state: 'TURNED_IN' },
                ],
              }
            : /topics/.test(url)
              ? { topic: [{ topicId: 't1', name: 'Unit 1' }] }
              : { courseWork: [{ id: 'w1', title: 'Lab writeup' }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('collecting Classroom when a school has withheld something', () => {
  it('collects everything when everything is granted', async () => {
    classroom([]);
    const { snapshot, skipped } = await collectClassroomSnapshot(ctx());

    expect(snapshot.courses).toHaveLength(1);
    expect(snapshot.announcements).toHaveLength(1);
    expect(snapshot.materials).toHaveLength(1);
    expect(snapshot.coursework).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('loses only the source that was refused', async () => {
    classroom(['announcements']);
    const { snapshot, skipped } = await collectClassroomSnapshot(ctx());

    expect(snapshot.announcements).toHaveLength(0);
    // Everything else is untouched -- one refusal is not a failed import.
    expect(snapshot.courses).toHaveLength(1);
    expect(snapshot.materials).toHaveLength(1);
    expect(snapshot.coursework).toHaveLength(1);
    expect(skipped.join(' ')).toMatch(/announcements/);
  });

  it('says nothing was collected rather than that the year was empty', async () => {
    /*
     * Courses are the root of everything: without them there is nothing to
     * ask about. It has to be visible that the reason was a refusal, or a
     * student is told their school has no classes.
     */
    classroom(['courses?']);
    const { snapshot, skipped } = await collectClassroomSnapshot(ctx());

    expect(snapshot.courses).toHaveLength(0);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.join(' ')).toMatch(/not available|scope/i);
  });

  it('returns a whole snapshot even with nothing granted at all', async () => {
    // Every field present and empty, so a caller can loop over all of them
    // without checking each one exists.
    classroom(['classroom.googleapis.com']);
    const { snapshot } = await collectClassroomSnapshot(ctx());

    for (const key of [
      'courses',
      'coursework',
      'topics',
      'submissions',
      'announcements',
      'materials',
    ] as const) {
      expect(Array.isArray(snapshot[key])).toBe(true);
    }
  });
});
