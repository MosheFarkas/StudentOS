import { z } from 'zod';
import type { Tool } from '../types.js';
import { unavailable } from '../types.js';
import { googleFetch, isUnavailable } from './client.js';

/**
 * Google Calendar tools.
 *
 * The point of this integration is not "show me my schedule" -- the student's
 * calendar app already does that better. It is that every other capability
 * gets to be schedule-aware, and that the agent can actually act: block out
 * study time, move a session, cancel something that is no longer happening.
 *
 * These return compact shapes rather than raw Google payloads. A calendar
 * event from the API has ~40 fields; five of them change what the agent says.
 */

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string | undefined;
  end: string | undefined;
  location?: string;
  allDay: boolean;
  link?: string;
}

function toEvent(item: GoogleEvent): CalendarEvent {
  return {
    id: item.id,
    title: item.summary ?? '(no title)',
    // Google uses `date` for all-day events and `dateTime` for timed ones.
    // Collapsing them loses the difference between "due Thursday" and "due
    // Thursday at 5pm", which is exactly what a student cares about.
    start: item.start?.dateTime ?? item.start?.date,
    end: item.end?.dateTime ?? item.end?.date,
    ...(item.location ? { location: item.location } : {}),
    allDay: item.start?.dateTime === undefined,
    ...(item.htmlLink ? { link: item.htmlLink } : {}),
  };
}

const listEventsInput = z.object({
  startIso: z.iso.datetime().describe('Start of the range, ISO 8601'),
  endIso: z.iso.datetime().describe('End of the range, ISO 8601'),
});

export const listCalendarEvents: Tool<z.infer<typeof listEventsInput>, unknown> = {
  id: 'google_calendar_list_events',
  description:
    "List the student's calendar events in a time range. Call this whenever the answer " +
    'depends on their schedule -- deadlines, availability, or planning around classes. ' +
    'Also call it before updating or deleting an event, to get the event id.',
  inputSchema: listEventsInput,

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('calendar');
    if (!token) {
      return unavailable('Google Calendar is not connected. Connect it in Settings to use this.');
    }

    const url = new URL(EVENTS_URL);
    url.searchParams.set('timeMin', input.startIso);
    url.searchParams.set('timeMax', input.endIso);
    // Not optional. Without it a weekly lecture comes back as one recurrence
    // RULE rather than its occurrences, and the agent reasons about it as a
    // single event happening once.
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '50');

    const result = await googleFetch<{ items?: GoogleEvent[] }>(url.toString(), token, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (isUnavailable(result)) return result;

    const events = (result.items ?? []).map(toEvent);
    return { events, count: events.length };
  },
};

const createEventInput = z.object({
  title: z.string().min(1).describe('Event title as the student would recognise it'),
  startIso: z.iso.datetime().describe('Start, ISO 8601 with timezone offset'),
  endIso: z.iso.datetime().describe('End, ISO 8601 with timezone offset'),
  description: z.string().optional(),
  location: z.string().optional(),
});

export const createCalendarEvent: Tool<z.infer<typeof createEventInput>, unknown> = {
  id: 'google_calendar_create_event',
  description:
    "Create an event on the student's calendar. Use this when they ask to schedule, block " +
    'out, or add something. Confirm the time with them first if it is at all ambiguous -- ' +
    'this writes to their real calendar.',
  inputSchema: createEventInput,

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('calendar');
    if (!token) {
      return unavailable('Google Calendar is not connected. Connect it in Settings to use this.');
    }

    const result = await googleFetch<GoogleEvent>(EVENTS_URL, token, {
      method: 'POST',
      body: {
        summary: input.title,
        start: { dateTime: input.startIso },
        end: { dateTime: input.endIso },
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (isUnavailable(result)) return result;

    return { created: toEvent(result) };
  },
};

const updateEventInput = z.object({
  // Required, and only obtainable from a prior list call. That ordering is a
  // safety property: the agent cannot modify an event it has not first seen.
  eventId: z.string().min(1).describe('Event id from google_calendar_list_events'),
  title: z.string().min(1).optional(),
  startIso: z.iso.datetime().optional(),
  endIso: z.iso.datetime().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
});

export const updateCalendarEvent: Tool<z.infer<typeof updateEventInput>, unknown> = {
  id: 'google_calendar_update_event',
  description:
    'Change an existing calendar event -- move it, rename it, or edit its details. ' +
    'Look the event up with google_calendar_list_events first to get its id. Only the ' +
    'fields you pass are changed.',
  inputSchema: updateEventInput,

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('calendar');
    if (!token) {
      return unavailable('Google Calendar is not connected. Connect it in Settings to use this.');
    }

    // PATCH, not PUT: PUT replaces the event, silently dropping attendees,
    // reminders, and recurrence the agent never knew about.
    const result = await googleFetch<GoogleEvent>(
      `${EVENTS_URL}/${encodeURIComponent(input.eventId)}`,
      token,
      {
        method: 'PATCH',
        body: {
          ...(input.title ? { summary: input.title } : {}),
          ...(input.startIso ? { start: { dateTime: input.startIso } } : {}),
          ...(input.endIso ? { end: { dateTime: input.endIso } } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.location ? { location: input.location } : {}),
        },
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    if (isUnavailable(result)) return result;

    return { updated: toEvent(result) };
  },
};

const deleteEventInput = z.object({
  eventId: z.string().min(1).describe('Event id from google_calendar_list_events'),
});

export const deleteCalendarEvent: Tool<z.infer<typeof deleteEventInput>, unknown> = {
  id: 'google_calendar_delete_event',
  description:
    "Delete an event from the student's calendar. This cannot be undone, so only do it " +
    'when they have clearly asked for that specific event to be removed. Look it up with ' +
    'google_calendar_list_events first and confirm which one you are deleting.',
  inputSchema: deleteEventInput,

  async execute(input, ctx) {
    const token = await ctx.google?.getAccessToken('calendar');
    if (!token) {
      return unavailable('Google Calendar is not connected. Connect it in Settings to use this.');
    }

    const result = await googleFetch<Record<string, never>>(
      `${EVENTS_URL}/${encodeURIComponent(input.eventId)}`,
      token,
      { method: 'DELETE', ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (isUnavailable(result)) return result;

    return { deleted: true, eventId: input.eventId };
  },
};
