---
name: user-doc
description: How to write the page describing a student's school life -- the one document read before every reply, and the way in to all the others. Read by the pass that runs after a vault is built.
---

# Writing down whose school this is

You are writing the one page the agent carries into every reply. Everything else it knows has to be looked up; this is what it knows before it looks.

That makes this page two things at once, and both matter.

It is a **summary**: who this student is, what they study, what else they do. Short enough to be read on every turn without the cost being noticed.

And it is a **way in**: it names the other pages, so the agent knows what exists to open. A class the page never mentions is a class the agent will not know to look up.

## The shape of it

Four sections, in this order, with these headings.

### `## Who they are`

Their name, the year they are in, and their school — with the school linked as `[[school]]` where a school page exists.

The year is given to you. Use it as given. Do not work one out from a course name, and do not adjust it because a piece of evidence you can see says something else: what you were given has already had the years since counted.

### `## What they study`

One line per subject. The subject linked as `[[class-french]]` — use the exact page names you are given — then, in the same line, the plainest useful thing about it: who teaches it, or what it covers.

This is the section that earns the page. A student saying "help me with French" should have the agent already knowing there is a French page and who teaches it.

If none of the pages you are given is a taught subject, say so in one line and move on: _"No taught subjects are recorded right now."_ That is a real state, not a gap to paper over — a student between school years has last year's classes gone and next year's not yet created, and it happens to everyone every summer. Do not list their clubs here to fill the space, and do not name a subject from anything other than the pages you were given.

### `## What else they do`

The same, for the things that are not subjects: clubs, teams, programmes, a house group. Say what they are so the agent does not treat one as a class.

You are told which pages are taught subjects and which are not. Sort them accordingly, and never move one across to balance the two sections.

Leave the section out entirely if there are none.

### `## What I know about them`

What they have told you, linked as `[[chats]]` where that page exists. A few lines at most — the page itself holds the detail. Preferences about how they want to be answered belong here, because acting on those does not deserve a lookup first.

Leave it out if nothing has been kept.

## What does not go in

**Anything that expires.** No deadlines, no marks, no what-is-due, no "currently". This is rewritten when a term changes, not when a week does.

**Numbers.** Not how many assignments, not how many notes, not how many courses. They spend the budget and change nothing about how a student is answered.

**Anybody else.** Not a teacher's opinion, not a classmate, not a parent. Teachers are named on the class pages, where they belong.

**Anything you were not given.** No teacher you were not told about, no school you were not told about, no year you were not told about. Every wrong fact this product has ever stored came from a pass that was asked for something and therefore produced it.

## How to write about how they are doing

Do not.

Not that they are struggling, not that they are doing well, not that they are conscientious or behind or bright. You are describing a school life, not appraising a person — and unlike a reply, which is read once and forgotten, this is read before every future answer and quietly becomes how they are treated.

## The budget

You will be told the character limit. Stay inside it.

If it will not fit, cut in this order: the last section first, then the detail after each subject link, then the clubs. Never cut a subject entirely — a missing link is a page the agent never learns exists, which is worse than a line with nothing after it.

## How to write it

Markdown, and use it properly: the headings above, one short line per item, no paragraphs of prose.

Third person, plain, present tense. "Lucas is in Grade 11 at [[school]]", not "The student appears to be".

Link with `[[page-name]]`, using only the page names you were given. A link to a page that does not exist opens nothing, and the agent will keep trying it.
