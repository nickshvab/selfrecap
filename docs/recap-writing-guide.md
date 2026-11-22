# How to write a recap

> Notes on the writing. The examples below are illustrations: replace them with your own.

A recap is not a summary written for an outside reader. It is a message the session writes for itself after the restart, read on resume as the opening of its history. The goal is that the resumed session can pick up the work where it left off: what was decided, what is open, how the work is done here. Write it as the session's own account, not as a report about someone else's work.

This guide is about the writing. The mechanics (find a cut point, dry-run, execute, restart) are in [walkthrough.md](./walkthrough.md); the data shapes are in [protocol.md](./protocol.md).

---

## Choose the cut at a real seam

The cut point should be a genuine phase boundary — the end of one mode of work just before a different one starts — not an arbitrary percentage of the file. A clean seam makes the recap easy to write (it has a natural scope) and the resumed transcript easy to read (the recap ends, the surviving work begins, no overlap).

Aim to compress somewhere between a third and two-thirds of the file. Cutting too little means you'll be back at the context limit soon; cutting too much means more of the period survives only as summary, which is lossier. Find the seam first; let the percentage fall where it does.

---

## What to keep, what to drop

The filter that works: **will the resumed session need this a month from now?**

Keep:

- Decisions made, and *why* — the reasoning is the load-bearing part.
- Conventions and patterns established (how the work is done here).
- Working agreements with the operator or other collaborators.
- Open threads: what's unresolved, what the session was about to do next.
- Validated conclusions — things tested and found true.

Leave out:

- Tactical execution detail recoverable from elsewhere — what's in your commit history, file diffs, or already-written docs does not need re-narrating; the details may stay on disk. "Shipped the auth refactor" is enough; the four bugs fixed along the way live in git. Whether to leave a trace that something happened is the session's decision: one line that it was done, and where, can be worth keeping even when how it was done is not.
- Anything that survives past the cut anyway. The records after your cut point stay in the transcript verbatim — do not summarize what's still there.

A recap that keeps every detail only moves the bulk from one place to another. What the resumed session needs is the decisions and the thread of the work, not the transcript.

---

## If the draft is on

With the draft enabled (off by default; see the README, "The draft and the check"), a cold reader writes short lines about the period before you write. Read all of it, then close it and write the recap yourself, from memory, in your own words: copied lines make a report, not a recap. Its lines are traces, not the truth. Check two kinds against the record (`recap.ts <voice> --entry E-0123`) before they go in: lines about the session itself, and words or decisions given to the operator. A line you do not remember may go in only as what the record holds, with its date. Afterwards the check reads the body against the record, once: what it shows to be untrue is corrected or removed; what it calls missing is the session's call. Why the draft exists is described in [why-the-draft.md](./why-the-draft.md).

---

## Who is speaking: the recap is a user message

The recap is inserted into the transcript as a **`user`-role message**. That has a grammatical consequence that matters more than it first appears: whatever the body's first line says, it is read as the *operator* (the user, the human who runs the session) speaking.

So the body is written as a message from the operator to the session, opening the way the operator usually addresses it — for example *"Here's where you were"*. An opening like *"Here's what I did"* in first person breaks, because the user-role slot makes it read as the operator claiming the session's work as their own.

Two body styles both work, **inside** that opening:

- **First-person ("I decided X, I shipped Y")** — the session's own account, handed back by the operator's opening. Natural for hands-on build work.
- **Second-person ("you decided X, you shipped Y")** — the operator telling the session what it did, as a briefing. Natural for decision-heavy work.

Pick what fits the work. The one hard rule: the **opening** is the operator addressing the session, whatever the style underneath it.

---

## Anti-patterns to scan for

These tend to read wrong on resume. None is absolute — surrounding context can carry any of them — but treat them as default-suspect:

- **References to the recap process itself** — the cut, the restart, an earlier instance. Write the period as a plain account, like notes the session made earlier the same day.
- **Abstract self-description** instead of what happened. Cut it.
- **Ornate phrasing.** Say it plainly.
- **Jargon** — "intel," "asset," "deliverable," "deploy" where plainer words fit. Use the plain word.
- **Re-introducing yourself in a layered recap** — for recap-002 and beyond, the prior recap already established the baseline. Write only what changed since; don't restate your standing conventions.

---

## After the restart

A resumed session cannot tell from the inside whether the restart happened (see the self-detection note in [cache-mechanics.md](./cache-mechanics.md)). Check from outside: the token count, `stale_reading`, and, for certainty, a read of the backup.

If the resumed session cannot carry on the work from its recap and the kept turns, something in the recap did not carry. Restore from the backup ([walkthrough step 8](./walkthrough.md#8-verify) says what a restore loses), revise the recap, and try again.

---

## Length follows the period

There is no target length. A quiet stretch with two decisions might be a few paragraphs; a dense period with many interlocking decisions might be much longer. Write what the period actually contained, then cut anything that fails the month-from-now test. Length that comes from padding reads padded; length that comes from a genuinely dense period reads complete. Let the work set the size.
