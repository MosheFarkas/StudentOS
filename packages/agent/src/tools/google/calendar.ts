import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';
import { googleFetch, isUnavailable } from './client.js';

/**
 * Google Calendar tools.
 *
 * The point of this integration is not "show me my schedule" -- the student's
 * calendar app already does that better. It is that every other capability
 * gets to be schedule-aware. An agent that knows a midterm is Thursday
 * behaves differently from one that does not.
 *
 * So these return compact, already-summarised shapes rather than raw Google
 * payloads. A calendar event from the API has ~40 fields; five of them change
 * what the agent should say.
 */

const listEventsInput = z.object({
  startIso: z.iso.datetime().describe('Start of the range, ISO 8601'),
  endIso: z.iso.datetime().describe('End of the range, ISO 8601'),
});

interface GoogleEventList {
  items?: {
    id: string;
    summary?: string;
    location?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  }[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string | undefined;
  end: string | undefined;
  location?: string;
  allDay: boolean;
}

export const listCalendarEvents: Tool<z.infer<typeof listEventsInput>, unknown> = {
  id: 'google_calendar_list_events',
  description:
    "List the student's calendar events in a time range. Call this whenever the answer " +
    'depends on their schedule -- deadlines, availability, or planning around classes.',
  inputSchema: listEventsInput,

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('calendar');
    if (!token) {
      return unavailable('Google Calendar is not connected. Connect it in Settings to use this.');
    }

    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.searchParams.set('timeMin', input.startIso);
    url.searchParams.set('timeMax', input.endIso);
    // Not optional. Without it a weekly lecture comes back as one recurrence
    // RULE rather than its occurrences, and the agent reasons about it as a
    // single event happening once.
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '50');

    const result = await googleFetch<GoogleEventList>(url.toString(), token, ctx.signal);
    if (isUnavailable(result)) return result;

    const events: CalendarEvent[] = (result.items ?? []).map((item) => ({
      id: item.id,
      title: item.summary ?? '(no title)',
      // Google uses `date` for all-day events and `dateTime` for timed ones.
      // Collapsing them loses the distinction between "due Thursday" and
      // "due Thursday at 5pm", which is exactly what a student cares about.
      start: item.start?.dateTime ?? item.start?.date,
      end: item.end?.dateTime ?? item.end?.date,
      ...(item.location ? { location: item.location } : {}),
      allDay: item.start?.dateTime === undefined,
    }));

    return { events, count: events.length };
  },
};

// TODO(calendar): a create_event tool. Writing to a student's real calendar is
// a trust decision, not just a scope change -- gate it behind an explicit
// confirmation in the UI before the agent can do it unattended.
