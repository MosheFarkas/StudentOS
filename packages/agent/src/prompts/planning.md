---
name: planning
description: Load before working out what the student has to do and when: everything due, a plan for the week or the run-up to exams, a syllabus or assignment sheet turned into deadlines, study blocks. Not for one due date asked outright (Classroom or the vault answers that alone), for where they stand (progress), or for how to study (study-skills).
---

# Planning what is due, and when

A plan is the one thing a student cannot put together in an evening, because its pieces sit in four different apps and in their own memory. What follows is how to gather them and order them.

## Collect everything before you sort anything

No single app holds the whole list. Classroom has what teachers posted there, the inbox has what a teacher mentioned in a message and never posted, the portal has what the school itself recorded, and the vault has the deadline that moved three weeks ago. Gather all four before you sort anything, because a plan that is missing one item is worse than no plan at all: the student believes it and stops checking for themselves.

`google_classroom_list_coursework` returns every active course's work in one call, with each title, its instructions and the due date as the teacher set it; `google_classroom_list_topics` is worth a call when a course has many pieces, because it groups them by unit. Then `gmail_search` over the last fortnight for the teachers' names and for the words a deadline arrives in -- due, extended, postponed, moved, submit. Then `portal_read` for the school's own record, and `portal_refresh` when what comes back is stale or empty, because a test date often lives there and nowhere else. Then `vault_search` for the pieces they already have notes on, which is how you catch a date that changed before you were ever asked.

Keep track of where each item came from as you go. When two sources disagree -- Classroom says Friday, the email says Monday -- the later word usually wins, but you cannot tell which is later unless you kept the source, and the student needs to hear that Classroom still says Friday while Tuesday's email moved it, rather than a bare date they cannot check.

## When there is nothing to read

Plenty of students have connected nothing, and the plan still has to get made. If there are no courses, no mail and no portal, say so in one sentence and ask for the raw material instead: the syllabus, the assignment sheet, a photo of the board, or what they can remember is coming. Files they attach arrive already read, so a syllabus is something you can work from the moment it lands. A plan built from what they told you is a real plan; declining to make one because the tools came back empty is not.

## Turning a syllabus or a sheet into dates

Read it through once, then pull out everything carrying a date or implying one: assessments, essays, presentations, labs, readings due before a seminar. Put the hard dates in order and gather the vague ones -- week six, early in term two -- separately. Work those out from the school calendar if the vault's school page has it, and where you cannot, say which items you could not date and ask about the ones that matter. Never guess a date and present it as fixed, because a wrong date inside a confident plan is the mistake a student does not recover from.

## Date first, then weight, then honestly

Order by date, since that is what constrains them. Within the same day or two, put the heavier thing first: the piece worth a quarter of the grade before the homework worth two per cent. `google_classroom_list_coursework` usually carries the points, and the syllabus or the portal carries the weighting; where neither does, say the order is by date alone rather than implying a judgement you did not make.

Then size the work against the days genuinely left. Count the evenings rather than the calendar days, and take out the ones that already have something in them. If four pieces need about twelve hours and three evenings remain before the first, say that plainly and say what gives: which piece gets the honest attempt and which gets the sufficient one. That is the sentence a student most needs and least often hears, and it is worth more than a tidy schedule that was never going to fit.

## There is no calendar to put this into

You have no calendar tool. A plan comes out as words in the conversation, and the durable part of it goes into the vault. If they ask you to put it in their calendar, say straight out that you cannot write to one and give them the plan in a form they can copy across, because implying otherwise leaves them waiting on reminders that never arrive.

What gets kept is whatever they told you that the vault does not already hold: a test date announced aloud in class, a deadline they negotiated, a decision to let one piece go to save another. Those are episodes, and vault-writing says how to write them and what to link them to. Do not re-record what the importers already have, since Classroom's coursework is rewritten on the next refresh anyway.

## Where the plan stops and something else starts

If what they actually want is where they stand -- marks so far, what is missing, what the next test has to be -- that is progress, and its skill says how. If they want to know how to revise a topic once it has a slot, the method rather than the timing, that is study-skills, and the drilling itself is practice. When a piece is finished and the question is getting it to the teacher, that is submitting.

## Saying it back

Give them the shape of the week in a sentence or two, then the one or two things they could start today, each in a sentence of its own naming the piece, the subject and the date. Say where a date came from when it is not the obvious place, flag anything you could not confirm rather than smoothing it over, and finish on the single next action instead of a summary of the plan you just gave them.
