# Why the draft and the check exist

Version 1.2.0 adds two optional steps around the writing of a recap: a **draft** before it and a **check** after it. This page says what problem they answer, how that was measured, what the measurement does not show, and what it costs. Both steps are off by default; [the README](../README.md) says how to switch them on.

## The problem

A recap is written by the session itself, from memory, when its context is nearly full. That is the point of the tool: the session decides what mattered. The recap then replaces the oldest part of the conversation, and whatever did not make it into the recap is gone for that session. But memory at that moment is uneven, and the session cannot see where.

In the measurement described below, two things went wrong, and neither was visible to the session.

**What the session did survived; what others decided faded.** The session remembered what it built. It was much weaker on decisions made by someone else during the period: the operator's corrections, a rule agreed in passing, a "no" that closed a path. Those are the things a later session most needs, because without them it repeats the question or reopens the path.

**The story got tidied.** Writing from memory, the session turned a messy period into a clean one. Who caught a mistake, who asked for what, whether something was checked or only assumed: these drifted toward the version that reads well. The session read its own tidy version as memory.

A forgotten thing leaves no gap to notice, so there is no signal a session could follow to find what it has lost. Something outside the session has to show it.

## The two steps

**The draft.** Before writing, a separate model that has never seen the session reads the part of the conversation that is about to be replaced (the period before the cut), in order, and writes short lines: what was learned, what was decided, and who said it. The session reads all of those lines, closes the file, and writes the recap itself, from memory, in its own words. The draft reminds; it does not write. Lines are not copied in.

**The check.** After writing, another separate model compares the finished recap with the record of the period and reports what does not fit: statements the record contradicts, things from after the cut, claims about the session the record does not support, promises still open that the recap leaves out, decisions of the operator it does not carry. The session edits once. An untruth is fixed or removed; an omission is the session's call. There is no second round.

The check was not in the first design. It was added after an early trial of the draft, when a reader's line about the session turned out to be false and the session took it into its recap without noticing. A draft is a set of traces, not the truth, and a longer recap has more places to be wrong.

## How it was measured

The measurement was made on one long-lived session, on one period of eleven days of work, when its context was nearly full and the recap was needed, not staged. The session measured is the one that built this tool, and it ran the readers, the judges and the comparison itself.

1. The session wrote a recap from memory alone and set it aside.
2. Readers produced the draft. The session read all of it and wrote a second recap, again from memory. In both rounds below, the draft was made by four smaller readers in parallel, each reading a quarter of the period. The single reader that is now the default was compared afterwards, by one comparing model on the same period, not by the judges (see the end of this section).
3. Ten judges, each a fresh model run with no knowledge of the session, were given both texts as X and Y and asked plain questions: what would you know after each, what could harden into a false fact, what will not matter in a month, which would you rather be left with. Nothing in the questions named the draft, and the judges were told that length is not an advantage either way. Which text was X was swapped from judge to judge. Five of the judges also had a record of the period to count errors against. For three it was the full record: a text export of the period in time order, with what was said and what the tools returned. For two it was the draft itself.
4. The second recap was then checked and edited, and the ten judges were run again: the memory-only recap against the final one.

The rule for reading the result was written down before the judges ran. Eight judges count; the two whose record was the draft are shown but not counted. Six of the eight for the recap written with the draft: a difference was seen. Six of the eight for the memory-only recap: the draft made it worse. Anything else, or more than two judges missing: no difference seen.

**Round 1: memory only, against the recap written after the draft, before any check.** All eight counted judges chose the recap written after the draft; the two not counted chose the same. Five judges chose X and five chose Y, so the position of a text did not decide.

| Judge with the full record | Errors, memory only | Errors, after the draft | Items that mattered: memory only | Items that mattered: after the draft |
|---|---|---|---|---|
| A | 4 | 6 | 25 of 40 | 39 of 40 |
| B | 8 | 12 | 20 of 31 | 31 of 31 |

The third judge with the full record could not hold all of it in this round: it read the first part in order and checked the rest by search, and found no errors in either text.

**Round 2: memory only, against the final recap, after the check and the edit.** Again all eight counted judges chose the final recap, the two not counted chose the same, and five chose X and five chose Y.

| Judge with the full record | Errors, memory only | Errors, final | Items that mattered: memory only | Items that mattered: final |
|---|---|---|---|---|
| A | 12 | 6 | 25 of 40 | 40 of 40 |
| B | 7 | 1 | 19 of 31 | 31 of 31 |
| C | 7 | 3 | 22 of 32 | 32 of 32 |

Each judge made its own list of what mattered and its own list of errors. The memory-only text was the same in both rounds, and judge A counted its errors as 4 and then 12, while judge B counted its items as 20 and then 19. So what holds is the direction, not the numbers: in round 1 both judges counted more errors in the longer recap than in the short one; in round 2 all three counted fewer errors in the final recap than in the memory-only one.

Lengths: 11,006 characters from memory alone, 18,005 after the draft, 18,940 after the check and the edit.

What the judges said in their reports was consistent: the memory-only recap was cleaner and read more easily, and what it dropped was mostly rules, limits and corrections agreed in conversation.

**One reader or several.** The draft was then made a second time on the same period by one large-context model reading everything, and one further model compared the two drafts with the record against its own list of 40 items that mattered. This is a single run by a single comparing model. It found all 40 in the single reader's draft and no false lines; it found 37 in the four readers' draft and four errors, two of them about the session itself; and it named one case where a reader of one quarter could not know how something begun there ended later. On that basis one reader is the default and the parallel form is an option. No recap written from the single reader's draft has been judged.

## What this does not show

- It is one session and one period. Nothing here says how large the effect is for another kind of work.
- The judges are models, and models of one maker. Ten of them agreeing is ten runs agreeing, not ten independent opinions. Two of the ten ran on the same model as the session itself.
- Both recaps were written by the same session, one after the other. Part of the difference may be the second pass over the same period, not the draft.
- The recap written after the draft was longer. The judges were told that length is not an advantage, but a fuller text may still have drawn them.
- The session already knew what it tends to lose: an earlier experiment on the same session had shown it. Its memory-only recap was probably better than it would otherwise have been, so the gap may be understated.
- No round compared the same recap before and after the check with the same judges. That the check lowers the error count is read across two rounds in which the unchanged text was itself counted differently.
- The session was meant to see only the tally of the first round before going on. The tool that ran the judges returned their full reports into the session, so that rule did not hold. The edit between the rounds was made from the check report alone.
- The default reader was compared by one model on one period, as described above.

## What it costs

The reader and the checker are ordinary headless Claude Code runs on the operator's account; each prints its own cost when it ends. On the period measured here, about 770,000 characters of record, the single reader took about ten minutes and about half a million tokens, and the check a few minutes more. Neither runs inside the session's context: the session pays only for reading the draft (about 23,000 tokens for that period) and the report.

Because they spend the operator's usage, both steps are off until the operator turns them on. A session whose recaps are short, or whose work lives mostly in files rather than in conversation, may not need them.
