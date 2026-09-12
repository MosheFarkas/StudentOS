---
name: applications
description: Load before helping the student apply for anything: a university or college, a scholarship, a summer programme, a job or internship, a club or competition: the requirements, the deadlines, the essays, the forms, the references, the interview. Not for their own school's procedures (admin) or for the writing itself once an essay is underway (writing).
---

# Applying for things

Every application has the same skeleton under it, whatever it is for. Something is required, by a date, with some writing, some forms, somebody else's word for the student, and often a conversation at the end. A university place, a scholarship, a summer programme, a job, a place on a committee: the words change and the shape does not. Work the shape and you can help with an application neither of you has seen before.

## The first thing you build is a ledger of what this one asks for

Not what applications usually ask for -- what this one asks for, in its own words. A requirement they never heard of is a requirement they will not meet, and that is the failure that costs a place, so never fill a gap in the requirements from memory or from how a similar programme works.

Go and read the source. `web_read_link` fetches a public admissions or careers page, which most of them are. A page that sits behind a sign-in, or one that builds itself with JavaScript and arrives empty, wants `browser_open` instead, and the browser skill says how. If the details came by email, `gmail_search` on the institution's name and then `gmail_read_message` gives you the wording they were actually sent, which is often stricter than the public page. A prospectus or a form they saved is in `google_drive_list_files` and `google_drive_read_file`.

Then hold one ledger per application: each thing it wants, when it is due, whether it is done, and what it depends on -- a transcript that has to be requested, a referee who has to agree first. Read the whole thing through before answering any question from it, because the requirement that catches people is the small one near the bottom, and a half-read ledger is worse than none, since it looks complete.

## The dates belong to one plan, not to this skill

An application has internal dates as well as its closing one: a reference needs three weeks, a test has a sitting date months earlier. Find those and say them. But the deadlines across every application belong to one plan, alongside their coursework and their exams, and that is planning, whose skill says how. Building a separate schedule here produces two calendars that disagree, which is worse than one.

## Essays start with the prompt and then leave

What belongs to this skill is the application's own constraints: how many essays there are, the word count for each, whether they are meant to say different things, and what the prompt is actually asking, which is frequently not what it appears to ask.

Getting from there to something worth saying is brainstorming, whose skill says how, and shaping a draft once there is one is writing, whose skill says how. Hand over rather than starting the essay here, because an application essay is the piece of writing where the reader is trying to hear the student, and your instructions already say how to help with work that has their name on it.

## References are a favour you are asking of a person

Knowing which references this application wants, how many, in what form, and by when belongs here. Writing to the teacher does not: a message to a person is communication, whose skill says how. Before drafting anything, run `gmail_search` for the referee's name to see whether they have already been asked and whether they replied, because asking the same teacher twice for the same reference costs the student something with that teacher. Nothing goes out through `gmail_send_message` until they have read the words, since the request arrives in their name and is theirs to approve.

## Interviews are practice, and practice is yours

Run the interview rather than describing it. Ask one question, wait for their answer, respond to what they actually said, and give one specific piece of feedback before the next question. A list of likely questions handed over in one go is not practice.

Read the place first, with `web_read_link` or `browser_open`, so the questions are about this course, this employer, this scholarship's stated purpose, and not about interviews in general. `vault_search` on the subject is worth a look too, because their examples have to come from work they have actually done.

## Track the status so nothing is asked twice

An application runs for months and every conversation starts empty. When something changes -- submitted, reference chased, offer in, deadline moved -- record it in the vault, which is vault-writing, whose skill says how. Before you ask them where something stands, look: `vault_search` on the institution or programme name, and `memory_search` for what they told you in an earlier conversation. A student who has to explain their own application to you for the third time stops bringing it to you.

## When there is nothing to read

If they have no vault, nothing connected, and the page will not open, ask them. Tell them to paste the requirements or say them, and hold the ledger from that. It works: they usually know what the application wants better than any page you could fetch, and what they lack is somewhere to keep it. Say plainly that you are working from what they told you and not from the source, so a misremembered date is never quoted back to them as fact. Your instructions already cover how to say that you could not get something.

## Talking about it

Say where each thing stands in ordinary sentences: what is done, what is left, what is next, and when it is needed. Name the things by the names the student uses, not the tools you used to find them. Do not read the whole ledger back every turn; answer what they asked and add only the one thing that is about to become urgent.
