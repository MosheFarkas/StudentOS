import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';

/**
 * Google Classroom tools.
 *
 * STUB -- shapes only, no API calls.
 *
 * Read ./scopes.ts before implementing. Classroom is the most likely
 * integration to be unavailable for a given student, and for reasons entirely
 * outside their control: their Workspace admin has to have configured this app
 * before an under-18 account can use it at all.
 *
 * Treat "not available" as the normal case, not the error case. Every Classroom
 * capability needs a defined behaviour for a student who cannot grant the
 * scope, and the agent should stay useful without it.
 */

const listCourseworkInput = z.object({
  courseId: z.string().optional().describe('Restrict to one course. Omit for all courses.'),
  includeCompleted: z.boolean().default(false),
});

export const listCoursework: Tool<z.infer<typeof listCourseworkInput>, unknown> = {
  id: 'google_classroom.list_coursework',
  description:
    "List the student's assignments and their due dates. Call this when the question " +
    'involves upcoming work, deadlines, or what a course requires.',
  inputSchema: listCourseworkInput,

  async execute(_input, ctx) {
    const token = await ctx.google?.getAccessToken('classroom');
    if (!token) {
      // Deliberately says "or your school has not approved" -- for a managed
      // under-18 account this is not something the student can fix, and a bare
      // "not connected" sends them in a loop trying to connect it.
      return unavailable(
        'Google Classroom is not connected, or your school has not approved Student OS. ' +
          'You can still use everything else.',
      );
    }

    // TODO(oauth): GET https://classroom.googleapis.com/v1/courses
    //   then /v1/courses/{courseId}/courseWork for each active course.
    // Handle 403 admin_policy_enforced distinctly from a generic failure -- it
    // means the admin blocked the app, and the student needs to be told that
    // rather than shown a retry button.
    return unavailable('Classroom integration is not implemented yet.');
  },
};
