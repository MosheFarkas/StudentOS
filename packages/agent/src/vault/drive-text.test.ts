import { describe, expect, it } from 'vitest';
import { textFromDriveRead } from './drive-text.js';
import { unavailable } from '../tools/types.js';

/**
 * Telling a fact about a file from a circumstance around it.
 *
 * The reader marks a file it cannot read, so it never pays to try again. That
 * is right when the file genuinely holds no text, and badly wrong when the
 * problem is access: Drive access is an elective scope, so on most accounts
 * the reader would mark every single file "nothing readable in this file",
 * permanently, and never look again even after the student granted it.
 *
 * A permission is not a property of a document.
 */

const read = (content: string) => ({ name: 'x', mimeType: 'application/pdf', content });

describe('what a Drive read result means', () => {
  it('hands back the text when there is text', () => {
    expect(textFromDriveRead(read('Question 1. Define inertia.'))).toBe(
      'Question 1. Define inertia.',
    );
  });

  it('says "no text" when the file itself has none', () => {
    // A fact about the document. Worth recording so it is never retried.
    for (const reason of [
      'I looked at "photo.jpg" but could not find any readable text in it.',
      '"Slides" is a folder, not a document. Use google_drive_list_files.',
      'Google returned an error: This file cannot be exported by the user.',
      '"Exam.pdf" is a PDF I could not read -- it may be password protected.',
      'I cannot read "Alertus-Mac.pkg" yet (application/octet-stream).',
    ]) {
      expect(textFromDriveRead(unavailable(reason))).toBeNull();
    }
  });

  it('throws when the problem is getting at the file, not the file', () => {
    /*
     * Drive access is elective. Without it every read comes back like this,
     * and treating that as "this document is empty" would write a permanent
     * lie onto every file in the vault on the very first pass.
     */
    for (const reason of [
      'Drive is not connected. Connect it in Settings to let me read your files.',
      'That file does not exist, or it is not shared with you.',
      'Google Classroom is not connected, or your school has not approved Contexto.',
    ]) {
      expect(() => textFromDriveRead(unavailable(reason))).toThrow();
    }
  });

  it('treats an unrecognised refusal as a circumstance, not a verdict', () => {
    // Retrying costs one request. Marking wrongly costs the file for ever, so
    // the doubt goes to the side that is recoverable.
    expect(() => textFromDriveRead(unavailable('Something nobody has seen before'))).toThrow();
  });

  it('says "no text" for a file that reads as nothing but whitespace', () => {
    expect(textFromDriveRead(read('   \n  \n '))).toBeNull();
  });
});
