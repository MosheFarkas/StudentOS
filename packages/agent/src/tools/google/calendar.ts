import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';

/**
 * Google Calendar tools.
 *
 * STUB -- shapes only, no API calls. Implement after the OAuth flow exists.
 *
 * Design note for whoever implements this: the point of the calendar
 * integration is not "show me my schedule", which the student's calendar app
 * already does better. It is that every other capability gets to be
 * schedule-aware -- an agent that knows a midterm is Thursday behaves
 * differently from one that does not. Prefer returning compact, summarised
 * context that other tools and the prompt can use over dumping raw event JSON
 * into the model's context.
 */

const listEventsInput = z.object({
  startIso: z.iso.datetime().describe('Start of range, ISO 8601'),
  endIso: z.iso.datetime().describe('End of range, ISO 8601'),
});

export const listCalendarEvents: Tool<z.infer<typeof listEventsInput>, unknown> = {
  id: 'google_calendar.list_events',
  description:
    "List the student's calendar events in a time range. Call this whenever the answer " +
    'depends on their schedule -- deadlines, availability, or planning around classes.',
  inputSchema: listEventsInput,

  async execute(_input, ctx) {
    const token = await ctx.google?.getAccessToken('calendar');
    if (!token) {
      return unavailable('Google Calendar is not connected. Connect it in Settings to use this.');
    }

    // TODO(oauth): GET https://www.googleapis.com/calendar/v3/calendars/primary/events
    //   ?timeMin=startIso&timeMax=endIso&singleEvents=true&orderBy=startTime
    // `singleEvents=true` is not optional -- without it, recurring events come
    // back as rules rather than occurrences and the agent will reason about a
    // weekly lecture as though it happens once.
    // Return { id, summary, start, end, location } only; drop the rest.
    return unavailable('Calendar integration is not implemented yet.');
  },
};

// TODO(calendar): a create_event tool, once there is a reason for the agent to
// write. Writing to a student's real calendar is a trust decision, not just a
// scope change -- gate it behind an explicit confirmation in the UI.
