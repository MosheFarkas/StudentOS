---
name: communication
description: Load before writing or sending a message for the student, or sorting their inbox: a question or request to a teacher, an extension request, a reply to a group, an email to an office, what needs answering today. Not for reading mail to answer a question (that is search, no skill), for the procedure behind a request (admin), or for what to say to their own project group (group-work).
---

# Writing to a person, and sorting the inbox

Two jobs share this skill: writing a message in this student's voice, and turning an inbox they have been avoiding into a short list of what needs them.

## Find out who they are before you write a word

Look the person up first. `vault_search` on the name and `vault_open` on their page give you the role, the course they teach this student, and the history: what they have set, what they have already been asked, whether the last exchange ended well. Then `gmail_search` for previous threads with them, which is the only place the register lives -- whether the student writes "Dear Mrs Bell" or "hi Sarah", whether the teacher signs off with a first name, how long their replies run. Match what is already there, because a message in a register that is not this student's reads as though somebody else wrote it, which is exactly what happened, and the teacher is the one person who would notice.

Get the address from the vault's person note or from a previous thread. `google_classroom_list_courses` gives you a teacher's name where the vault has none, but never assemble an address out of a naming pattern you inferred: a message to a wrong address at a school domain can land on a stranger.

If nothing is connected and the vault is empty, write the draft anyway from what they tell you, and put one question at the end about how they normally address this person. One question, because the draft is most of the value and they can correct a salutation in a second.

## A request is three sentences

Situation, ask, date. What has happened, what they would like, and by when -- plus a subject line that states the ask rather than the subject area, since teachers read mail on a phone between lessons and a message whose subject says "Extension request, Cold War essay" gets opened and one that says "History" does not. Three sentences get answered; five paragraphs get postponed to an evening that never comes.

An extension request follows the same shape and nothing more: what happened, the new date they are proposing, and the offer to send what they have so far. Do not pad it with apology, do not stack up justification, and never invent a reason they did not give you -- an excuse you made up is one they will have to defend in person. If they have not given you a reason at all, say in the draft only that they are asking, and ask them whether they want to say why.

## Show it, then send it

Put the draft in your reply, with the address it will go to and the subject, and send with `gmail_send_message` only once they have said yes to that text. Mail cannot be recalled, it is read by someone who has power over their grade, and it is the one thing you do that leaves the conversation permanently. If they told you to send before they had seen anything, still show the words and ask once, at the end of the reply, because they were agreeing to a message they had not read.

The same holds for a reply into an existing thread: `gmail_read_message` for what is actually being answered, `gmail_read_attachment` where the point of the mail is the file attached to it, then the draft, then their word, then send.

## Sorting the inbox into six piles

Pull the window with `gmail_search` -- the last week is usually right -- and open with `gmail_read_message` only the ones whose subject is not enough to place. Then sort every message into one of six: reply now, where a person is waiting and a date is attached; reply, which needs an answer but not today; act, where no reply is wanted but something must be done, a form filled, a slot booked; waiting, where they have already answered and the ball is with someone else; reference, worth keeping and needing nothing, a timetable or a receipt; and noise, which is newsletters and automated notices that change nothing. The value is that the first two piles are usually shorter than they feared and the last is usually longer.

`gmail_modify_message` takes a message out of the inbox and `gmail_trash_message` throws it away. Show what you would archive and archive only what they agreed to, because a message they cannot find later is a real cost and undoing it means hunting through a folder. Never trash on a guess: trash is recoverable for thirty days and archiving is recoverable for good, so anything you are unsure about is archived rather than trashed.

## Where the message stops and something else starts

If what they want is the procedure behind the request rather than the message -- what the extension policy actually is, which office handles it, what form comes first -- that is admin, and its skill says how. Write the message after you know the procedure, not instead of knowing it, because a polite mail to the wrong person costs a week. And if this is one of four messages chasing the same project, with contributions to collect and parts to merge, that is group-work.

Whatever comes back that changes something -- an extension granted, a date moved, a meeting fixed -- happened, so it is an episode, and vault-writing says how to record it.

## Saying it back

Say who it is going to and why in one sentence, then the draft itself with nothing around it, because anything you wrap it in gets copied along with it. Once it has gone, one sentence saying so and to whom. Do not paste the message back a second time, and do not narrate the triage: give each message that needs something its own short sentence, with the pile it landed in and what it wants from them, and give reference and noise as counts rather than lists.
