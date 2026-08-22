import { createContext, useContext, useEffect } from 'react';

/**
 * Whether the screen the student is looking at has work in flight.
 *
 * The mark in the header folds while the agent is working, and the header
 * does not know that -- the conversation does. Rather than have the header
 * poll a second time and risk the two disagreeing, whichever screen holds the
 * answer says so, and the header is told.
 *
 * Deliberately about the open screen and not about the account. A turn
 * running in a conversation nobody is looking at is not what this describes;
 * that is the conversation's own business, and it says so where the question
 * was asked.
 */
const WorkingContext = createContext<(working: boolean) => void>(() => {});

export const WorkingProvider = WorkingContext.Provider;

/**
 * Tell the header what this screen is doing, for as long as it is mounted.
 *
 * Cleared on the way out, so a student who leaves a conversation mid-answer
 * does not leave the mark folding over a screen with nothing happening on it.
 */
export function useReportWorking(working: boolean): void {
  const report = useContext(WorkingContext);
  useEffect(() => {
    report(working);
    return () => report(false);
  }, [report, working]);
}
