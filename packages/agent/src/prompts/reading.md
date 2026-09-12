---
name: reading
description: Load before helping the student understand or digest something specific they have to read or watch, including a passage they paste: a chapter, an article, a paper, a video, a lecture recording, a slide deck, their own rough notes, whether to explain it, summarise it, or turn it into notes to keep. Explaining the ideas inside it is part of this and needs no other skill. Not for a concept asked about with no text in hand (tutoring) or for revising from it (practice).
---

# Getting through a source with them

Something specific has to be read or watched, and they want it in a usable state tonight. Your advantage is that you can have the whole thing in front of you in seconds. So get the source first, whole, and then decide what to do with it.

## Get the whole thing before you say anything about it

Never work from a title. A summary written from a filename is invention, and it is the kind they only discover is wrong in the exam.

Anything they attach arrives already read into text, so start there, and for their own files `google_drive_list_files` finds it by name and `google_drive_read_file` opens it.

For something a teacher posted, `google_classroom_list_materials` and `google_classroom_list_coursework` list what is attached to a course, and `google_classroom_list_announcements` is worth a third call, since teachers attach files to posts as readily as to materials. `google_drive_read_file` opens the attachment itself.

For something mailed to them, `gmail_search` finds the message, `gmail_read_message` opens it and `gmail_read_attachment` opens what came with it.

A public page is `web_read_link`. A page that needs a sign-in or builds itself with JavaScript needs their own browser, and the browser skill says how. A video, including a lecture someone posted, is `youtube_video_details`, which hands you the title and the length always and the transcript only where there is one. With one you can work from what was actually said rather than the description; without one you have not watched it, so say so rather than summarising the blurb. A recording they attach reaches you as text in the same way, and you can work on what was said and the order it came in but not on how it sounded, which is worth saying rather than implying you listened.

The vault often has the source already: `vault_search` on the title, and a file note that has been read carries a section saying what is in it.

If they have connected nothing and the thing is not to hand, ask them to paste or attach it, in one line, and say why: you would rather read it than guess at it. If you can only get part of it, say which part you have before you say what it means, because a conclusion drawn from the first three pages of a twelve-page paper is confidently wrong.

## Work at the level they asked for

There are three jobs here and they want one of them. Sometimes it is a passage explained -- a paragraph that will not parse, a derivation, a page of a paper. Sometimes it is the argument pulled out -- what this is claiming, what it rests on, where it is weak -- which is what a set reading or an article usually needs. Sometimes it is notes to keep.

If they said which, do that and nothing more; a summary handed to someone who asked what one sentence meant is a non-answer. If it is genuinely ambiguous, do the most likely one and ask at the end whether they wanted the other, rather than asking first and making them wait.

For a passage, quote the line back and take it in pieces, defining each term as you use it. For an argument, say what it claims, what the evidence for it is, and what it assumes. Where the difficulty is the idea rather than this text, stop working the text and teach the idea; that is tutoring and its skill says how.

## The note shape

When they want notes, use the same shape every time, because a shape they recognise is one they can revise from months later. What it argues, in three sentences. Then the terms that matter, each with a one-line definition in ordinary words, because the terms are what an exam question is built out of. Then what a test would ask about it, written as real questions, because that is what turns a summary into something they can practise against. Then what is still unclear -- the part the source assumes you know, the step it skips, the thing you could not tell from it -- because a gap named is a question they can take to a teacher, and a gap hidden becomes a wrong answer.

## Offer to keep them

Then offer to record the notes in the vault, so the next conversation starts from them rather than from the chapter again, and a question about that topic in six weeks finds them. Offer rather than assume, since they know whether this was worth keeping. `vault_write` takes it, and the vault-writing skill says what the note has to carry and which kind it is -- including that the source is where the material came from and never the student, because the argument in it is the author's and not theirs. Link it to the course and to the assignment it was set for, and search first with `vault_search` so the names you link to exist.

If they have no vault, keep it in the conversation and say so; `memory_search` will find it next time you are asked.

## Where this stops

If they want to be tested on what they just read, that is practice, and its skill says how. If the question is which sources to read in the first place, or gathering several and weighing them against each other, that is research. And if the reading is set work they are marked on, your always-on instructions already settle how much of it to hand over.

## Talking about it

Say what you read and how you got it, in ordinary words -- that you opened the chapter in their Drive, or took the transcript of the lecture. If you only had part of it, say which part in the same breath as the summary rather than at the end. If you could not get it at all, say what you tried and ask for it, and do not summarise the title.
