---
name: progress
description: Load before telling the student where they stand: grades so far, what is missing or late, what a mark or a teacher's comment means, what they need on the next test, how a course is going overall. Not for what comes next (planning) or for improving a piece of work (feedback).
---

# Working out where they stand

Where they stand is a question no single record answers on its own. What follows is the arithmetic of a term: what came back, what is missing, and what the next mark has to be.

## Three records, and the different half each one knows

`google_classroom_list_submissions` tells you the state of every piece: whether it was turned in, when, whether it came back, and what it scored out of what. The portal, through `portal_read` and `portal_refresh` when that is stale, is the school's own gradebook, and usually the only place a term grade or weighted average exists. The vault holds the history: `vault_search` finds the assignment note and the episodes hanging off it, which is where a revised mark or a teacher's comment survives.

Read all three when the question is how a course is going, because each answers something the others cannot. Classroom says what happened to the work, the portal says what it counted for, and the vault says what was said about it. Where Classroom and the portal disagree on a number, the portal is the record the school acts on and Classroom is the teacher's working copy; say which one you are quoting, so the student knows which one to argue with.

If none of it is connected -- no Classroom, no portal, nothing in the vault -- ask for what they can see themselves: the last few marks and what each was out of. Four numbers read off a screen answer most of what they are asking, and faster than explaining what they would have to connect first.

## Returned, missing and late are three different things

Do not collapse them, because each one calls for something different tonight. Returned means it was handed in and marked and the number is real. Missing means the date has passed and nothing was submitted, the only category that is urgent this evening. Late means it went in after the date, which may or may not have cost marks depending on the school's policy -- the school page in the vault often has that, and finding it where it is not is admin's job.

When you list what is missing, list only what is genuinely missing: no submission and a date in the past. A draft sitting unsubmitted in Classroom looks identical to nothing at all from outside, so if the state shows one exists, say so, because having written it and not turned it in is a different evening from not having written it. Work set and not yet due is not missing, and belongs to planning rather than here.

## What the next mark has to be, with the assumptions said out loud

Do the arithmetic, and give the assumptions in the same breath, because the answer is only ever as good as the weighting. If the syllabus or the portal gives the split -- coursework forty, exam sixty -- say what you used, then the mark they need, then what happens at the edges: what a pass now takes, and what has gone out of reach. A student can act on needing about 68 on the final for a B assuming the exam is sixty per cent. They cannot act on a number with no working behind it.

When the weighting is nowhere -- nothing in the portal, no outline in Drive, nothing in the vault -- say so rather than quietly assuming everything counts equally, because that assumption produces a confident wrong number and they will plan their term around it. Then do the useful thing anyway: give the average as it stands, say what the answer would be under a couple of plausible splits, and say where the real weighting would be found. `google_drive_list_files` and `google_drive_read_file` often turn up the course outline shared at the start of term, and `google_classroom_list_materials` finds it where the teacher posted it to the class instead.

## Turning a teacher's comment into a change

A returned piece usually carries words as well as a number, in the Classroom submission, in the returned file, or in a message that `gmail_search` will find under the assignment's name. Read the comment and say the change it implies, in their terms and against their actual work. Needs more analysis nearly always means the paragraphs stop at description and the next has to say what it means and why it matters. Structure usually means the order of the argument rather than the headings. Point at the specific place in their piece where it applies, because a comment they cannot locate is a comment they will get again.

Stop there. Going through the draft line by line is feedback, and its skill says how. If what falls out of all this is that they have four pieces to recover and three weeks to do it in, that is a plan, so hand it to planning rather than sketching a half one here.

## Keeping what only they know

Marks, revisions and the reasons behind them sometimes exist only in the conversation -- a teacher who said the grade would be adjusted, a resit they agreed to, a piece they were told not to worry about. That happened, so it is an episode, and vault-writing says how to record it and what to link it to so the next answer about this course starts from it.

## Saying where they stand

Lead with the honest headline in one sentence, because that is what they asked and burying it reads as evasion. Then the marks that matter, each in a sentence of its own naming the subject, the piece and the score, and then what is missing, most urgent first and named the same way.

If a number looks wrong, or two sources disagree, say so plainly instead of silently picking one. And never soften a bad set of marks into something vaguer than it is: say what it is, then what can still be done about it.
