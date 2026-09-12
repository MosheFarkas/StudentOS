---
name: submitting
description: Load before handing work in: checking a piece against the brief and its format, attaching the right file, turning it in on Classroom or a portal, confirming it went, or un-submitting to fix something. Not for making the work (writing, presenting, data) or for knowing what is due (planning).
---

# Handing work in

Most lost marks at this stage have nothing to do with the quality of the work: a missing cover sheet, a word count over by four hundred, a file the teacher cannot open. Turning it in is also the last thing you do for them that cannot be taken back.

## Read the brief again before you read the work

Get the instructions back in front of you first: `google_classroom_list_coursework` for the title, the instructions and the due date, `google_classroom_list_materials` where the rubric was posted to the class separately, and `vault_search` for the assignment note, which is where a change the teacher announced in a message will have been recorded. Where there is no Classroom, ask them to paste the brief or attach the sheet; attachments arrive already read.

Then check the piece against it, item by item, and say what is wrong rather than that something is. Their name on it, in the form the teacher asked for. The format: the referencing style, line spacing, a title page if one was wanted. The length, against the stated limit, and whether the limit includes the references. The file type, since a page exported from one app opens as a mess in another. And every part present -- the bibliography, the appendix, the reflection paragraph, the declared word count -- because a brief with four components is marked as four components and a missing one scores nothing rather than badly.

## Getting the right file, not the newest one

`google_drive_list_files` finds the candidates and `google_drive_read_file` tells you which is which. Open the one you think is right and quote its opening line back to them before attaching anything, because the newest file is not reliably the right one and a filename with "final" in it is the least trustworthy signal there is. Two minutes here prevents submitting Tuesday's draft, which is not recoverable once a teacher has read it.

If Drive is not connected, ask them to attach the file to the conversation so you can check it against the brief, then say plainly that the upload is theirs to do and walk them through where.

## Attaching and turning in

Everything here needs three ids -- the course, the coursework and the submission -- and `google_classroom_list_submissions` is where all three come from, so call it first. Then `google_classroom_attach_file` puts the file on the submission and `google_classroom_turn_in` hands it over. Before either, say what you are about to attach -- the filename, and which assignment in which course -- and do it only when they say to go ahead, because turning in is visible to the teacher the moment it happens and the timestamp is often what decides whether the work counts as late. That is also why you never turn something in as a side effect of being asked to check it: checking and handing in are two different requests, and only one is irreversible.

## Un-submitting, and what it costs

`google_classroom_unsubmit` pulls the work back so they can fix and resubmit. It is the right move when something real is wrong -- the wrong file, a missing section -- and it carries a cost worth saying first: the submission is withdrawn and the resubmission is stamped at the new time, so if the deadline has gone the work may land as late when it was not. Say that, wait for them to agree, and have the corrected file ready so the gap is minutes rather than hours.

## When it is a portal rather than Classroom

`portal_read` shows what the school's own upload page is asking for, and `portal_refresh` gets it fresh when the capture is old, which matters here because an upload window that has closed is the whole answer. Driving the page itself is the browser skill's business. Where a portal cannot be driven -- most file pickers reach into their own machine and no tool can hand a file across that gap -- say so plainly and give the steps instead: the page to open, the button, the field names, what to attach. Being told exactly where to click is a real answer; pretending the upload is under way is not.

## Confirm it actually went

Call `google_classroom_list_submissions` afterwards and look at the state and the time. Say it is in when you have seen it change and not before, because the failure people remember is being told something was handed in when it was not. If the state has not moved, say what you see rather than assuming lag, and try again or tell them to check themselves.

## Record that it happened

A hand-in happened at a moment, so it is an episode, and vault-writing says how to write it and what to link it to -- the assignment and the course, so the next question about this piece starts from the fact that it went in and when. Record an un-submit and a resubmission the same way, because the second timestamp is the one that matters if a late penalty comes back with the mark.

## Where this stops and something else starts

Whether the work is any good is feedback's question and not this one's, so a hand-in check that turns into advice about the argument or the writing moves there. What is due, when, and in what order is planning's job. What the mark was when it comes back, whether it counts as late, and what the teacher's comment is asking for is progress. Making the work itself belongs to the skills for writing, presenting and data; this one starts once there is something to hand in.

## Saying it back

Give the check as sentences, each naming one thing to fix and where in the piece it is, and say plainly when there is nothing to fix, since that is the answer they were hoping for and deserves a sentence rather than silence. Afterwards, one sentence: what went in, to which assignment, and when.
