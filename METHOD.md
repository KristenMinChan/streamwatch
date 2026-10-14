# Method

How to detect that a recurring recorded event has been published to a video
platform, and prepare everything needed to republish it elsewhere — without
asking a volunteer to remember anything.

Everything here was learned by taking over one real workflow from the volunteer
who had been doing it by hand, and measuring it before changing it. Where there
is a number, it came from a count or a timestamp, not an estimate. Where
something is a judgement call, it says so.

This file is the method, not an implementation. It carries no values from the
organization it was built for — no names, no identifiers, no schema. Platforms
and field names *are* named, because an argument you cannot check is not worth
publishing: the instance this came from runs on Google Apps Script against
YouTube. Every organization-specific setting appears in §10 as a parameter you
are expected to tune, with the reasoning that should drive your choice.

---

## 1. The problem

A great many organizations run a recurring event — a weekly meeting, a class, a
public lecture, a council session — that is recorded, livestreamed, archived on
a video platform, and then has to appear in a second place: the
organization's own website, a newsletter, an app.

The second step is almost always done by hand, by a volunteer or a part-time
staff member, and it almost always decays.

The usual diagnosis is that the work is too hard or takes too long. In the case
this method came from, that diagnosis was wrong. The outgoing volunteer was
asked directly, and said the steps were easy. Each one individually was easy.

What stopped the work was **activation cost**. A single item required:

- opening four different web properties
- at least one login
- a dozen browser-tab switches
- copying values by hand from one system into another
- an uninterrupted block of time, because losing your place mid-sequence meant
  starting over

Roughly fifty discrete human actions per item. Not fifty hard actions — fifty
actions. Someone with a full-time job cannot reliably find an uninterrupted
block for fifty actions. They *can* find three actions, in a gap between other
things.

**This is the whole premise of the method. Design for the number of actions, not
for the number of minutes.**

---

## 2. The measurement

> Count human actions per item. Do not count total hours.

A workflow that drops from 20 minutes to 12 minutes has improved by 40% and will
still be abandoned. A workflow that drops from 15 actions to 3 actions may have
saved only five minutes, and will survive.

Why action count predicts survival better than elapsed time:

| | minutes | actions |
|---|---|---|
| Can be done in a gap | no — needs a contiguous block | yes |
| Fails if interrupted | yes — you lose your place | no — each action is atomic |
| Requires remembering the sequence | yes | no, if each action is prompted |
| Scales with how tired you are | strongly | weakly |

Minutes measure the cost of the work. Actions measure the cost of **starting**
the work. Abandonment is a starting problem, not a finishing problem.

How to count honestly:

1. Screen-record one real item, done the way it is actually done today.
2. Count every click, keystroke-block, login, tab switch, file save, and
   file move. Count a copy and its matching paste as two.
3. Record that number before changing anything. This is your baseline.
4. After each change, re-record and re-count. Do not estimate. Estimates of
   your own workflow are systematically too low, because the annoying parts are
   the parts you have stopped noticing.

Keep the count per item, alongside the date. A single number per item per week
is enough to see whether you are actually improving anything.

---

## 3. Design decision: extract from the consolidated node, not from upstream

**Decision.** Read the data from the one place where it has already been
assembled into a machine-readable form — the video platform's own metadata for
the published video. Do not chase the upstream sources it was assembled from.

**Why.** The information needed to republish an item (title, date, duration,
speaker, thumbnail, canonical URL, embed URL) originates scattered across
several upstream systems: a messaging thread where a title was agreed, a
presentation file where a graphic was designed, a scheduling tool, a person's
memory. Each upstream source is in a different format, some are not
machine-readable at all, several are owned by people who are not you, and none
of them is authoritative — the agreed title gets changed at the last minute.

By the time the video is published, all of it has already been funnelled through
a human into a single structured record with a stable schema and a documented
API. That record is the cheapest possible extraction point, and it is also the
*most correct* one: it reflects what was actually published, not what was
planned.

**The general rule.** Find the furthest-downstream point where the data is
already consolidated and machine-readable, and extract there. Every step you
move upstream multiplies the number of integrations, the number of formats, and
the number of people whose cooperation you need — and moves you further from
what actually happened.

**The cost you accept.** Anything a human never typed into that consolidated
record is not available to you. See §6.

---

## 4. Design decision: judge by structure, not by title keywords

**Decision.** To decide whether a newly published video is the thing you care
about, test the *structure* of its metadata. Do not pattern-match its title.

Concretely, on YouTube: `videos.list` with `part=snippet,liveStreamingDetails`
returns a `liveStreamingDetails` object only for items that were ever
livestreams, and that object contains `actualEndTime` only once the stream has
actually finished. Two fields, four unambiguous states:

| `liveStreamingDetails` | `actualEndTime` | means | action |
|---|---|---|---|
| absent | — | ordinary manual upload | ready now |
| present | absent | scheduled, or live right now | wait |
| present | present, within settle window | just finished, publisher may still be editing | wait (§8) |
| present | present, settle window elapsed | finished and settled | ready |

These are structural facts with exactly one meaning each. None of them depends
on anybody following a naming convention.

**Why.** Title formats drift. Over any period long enough to matter, the humans
writing titles will change the prefix, switch a colon from full-width to
half-width, translate a word, drop the series name, add a sponsor, misspell
something, or hand the job to a different person with different habits. Every
one of those changes silently breaks a keyword matcher — and *silently* is the
operative word, because a keyword matcher that stops matching looks exactly like
a week with no new content.

Structure does not drift. A livestream archive has live-streaming metadata
whether or not anyone remembered the naming convention.

**Where keywords are still fine.** Use them for *labelling*, never for
*gating*. In the reference implementation, title keywords decide which category
tag to suggest in the notification. If the keywords fail to match, the
notification still goes out, with the category left blank and a note saying "I
could not classify this one — please pick." A wrong label costs one human action
to fix. A missed detection costs weeks of silence.

**Corollary — do not use a time watermark for "have I seen this yet".** Keep an
explicit list of item IDs you have already handled. A scheduled livestream's
`published` timestamp is set when the stream is *created*, not when it *airs*,
and it never updates. An item created on one day and aired two days later will sit
permanently behind any watermark set from a later item, and you will never
notice, because the system will cheerfully report "nothing new."

There is a second trap in the same place. A YouTube channel's RSS feed
(`feeds/videos.xml?channel_id=…`) is ordered by `updated`, not `published`, so
the feed order is not chronological by airing either — and `updated` cannot be
used as a trigger, because a human editing a description weeks later bumps it.

A list of IDs costs a few hundred bytes and has none of these properties. Keep
the last N, where N is comfortably larger than the number of items your source
returns in one read — the feed above returns the 15 newest, so 60 is ample.

---

## 5. Design decision: prepare, never publish

**Decision.** The automation's output is a draft: a prepared package, delivered
to a human, who performs the publish. The automation is never given the ability
to publish on its own.

**Why.** Three reasons, in order of importance.

1. **Asymmetric cost of error.** A draft that is wrong costs one human a minute
   to fix before it is ever seen. A published item that is wrong is visible to
   the public, may be indexed, may be emailed out, and costs a correction, a
   retraction, and someone's trust. These are not comparable risks, and the
   automation cannot tell the difference between a normal item and an unusual
   one.

2. **Scope the credential, not just the secret.** If the automation must be
   given write access to the destination system, ask for the narrowest possible
   capability: create drafts only — no publish, no edit of existing items, no
   delete. Protecting a token is necessary but not sufficient; what matters is
   the worst thing a leaked or buggy caller can do. A token that can only create
   drafts has a small worst case. "We'll keep the token safe" has an unbounded
   one.

3. **It keeps a human in the loop who can notice.** The person doing the final
   publish sees the item. That is the only point in the pipeline where a human
   would catch "this is the wrong week's recording" or "the audio is broken."
   Removing that step removes the only error detection the system has.

**This is not timidity, and it is not a transitional phase.** Full auto-publish
would remove perhaps one action out of three. Removing the *judgment* step is
not where the remaining value is.

---

## 6. Design decision: some steps stay manual on purpose

**Decision.** Identify the facts that are genuinely not present anywhere in any
system, and stop trying to derive them. Ask a human, once, in the notification.

**Why.** A machine can transform information. It cannot create it. If the
speaker's name was never written down anywhere machine-readable, no amount of
engineering will produce it — it will produce a *guess*, and a guess that looks
like a fact is worse than a blank field, because nobody checks it.

The honest handling is a three-step ladder, in this order:

1. **Read it if it is there.** Parse the field if a human has filled it in.
2. **Fall back to a default, and say so loudly.** If the common case is one
   known value, use it — and mark it in the notification as a default that was
   assumed, not as a fact that was read. One human action to confirm, one to
   correct.
3. **Ask upstream to write it down — once.** The cheapest permanent fix for a
   missing field is usually a one-line agreement with the person who publishes
   the video: "please put `Speaker: Name` on any line of the description." That
   converts step 2 into step 1 forever, at a cost of one conversation. Do this
   *instead of* building an inference engine.

The same reasoning applies to assets that exist only in a human's design tool,
to context that lives in a conversation, and to any editorial judgment. Mark it
manual, make the ask explicit in the notification, and spend your engineering
somewhere it can actually work.

---

## 7. Design decision: fail loudly — and treat silence as a failure

**Decision.** Every unexpected condition produces a notification to a human.
**And so does the absence of expected content.**

**Why the second half matters more than the first.** The dangerous failure mode
of a scheduled automation is not an error. An error is visible. The dangerous
failure is that it quietly stops — a revoked credential, a changed API, an
expired quota, a disabled trigger, a renamed field — and reports nothing,
because reporting nothing is also what a quiet week looks like. Nobody
investigates an absence. The automation can be dead for a month before anyone
notices, and by then the backlog is back and so is the activation cost.

So: if the recurring event happens on a known cadence, the automation must
notify when the expected item **has not appeared** within a reasonable window.

**Implementation note that is easy to get wrong.** Key that staleness check on
"when did I last successfully handle an item *of the expected recurring kind*",
not on "when did I last do anything." A channel that publishes other content
will keep a general watermark fresh forever while the thing you actually care
about has been missing for six weeks.

Design the alerts as a small set with distinct meanings:

- **Ready** — item detected, package prepared, here it is.
- **Waiting** — item detected but not yet settled (see §8); logged, not mailed,
  because a notification you cannot act on yet trains you to ignore
  notifications.
- **Degraded** — item handled, but something was assumed or is missing
  (a default was used, the description looks too short, the high-resolution
  thumbnail is unavailable). Delivered with the package, as a note, not as a
  separate alarm.
- **Nothing found when something was expected** — the staleness alert above.
- **Hard error** — the run itself failed.

And provide a manual re-run path: a function a human can invoke with an item
identifier to regenerate and re-send a package. Items will occasionally fall
outside whatever rules you wrote. A manual override turns that from a crisis
into one action.

**Prefer design over notification.** If a condition can be eliminated by
changing the design, change the design — do not paper over it with an alert.
A delay caused by running the check too rarely should be fixed by running it
more often, not by sending a notification that the check has not run yet.

---

## 8. The settle window

A livestream archive is not finished when the stream ends. For some minutes or
hours afterwards, the publisher may still be fixing the title, writing the
description, swapping the thumbnail, or trimming the recording.

Wait a settle interval after **`actualEndTime`** before preparing the package.
Not after `published` — see §4; for a scheduled stream that value is
meaningless.

Choosing the interval is a trade-off between two failure modes:

- too short → you capture a half-finished description and deliver a package the
  human has to correct, which costs actions
- too long → the notification arrives after the human's available window has
  closed, which costs a week

Measure your own publisher's behaviour across several real items before picking a
number. Then make it a parameter, because the right value changes when the
person doing the publishing changes.

Accept that this version does not re-read an item once it has been handled. If
the description is edited after the settle window, the package will be stale.
Mitigate by including enough of the captured text in the notification that a
human can see at a glance whether it looks complete.

---

## 9. Runtime: boring is a feature

The automation needs to run on a schedule when nobody is watching, store a small
amount of state between runs, and send mail. That is all.

Evaluate candidate runtimes against the *handover*, not against your own
convenience:

- Does it require the next volunteer to create a new account? Every new account
  is a permanent tax on every future handover.
- Does it require version control, a local toolchain, or a terminal? If the
  person who inherits this cannot edit a config value through a browser, they
  will not edit it.
- Does the platform disable scheduled jobs after a period of repository
  inactivity? Several do. A pipeline that silently switches itself off is
  precisely the failure described in §7 — and it will be off for weeks before
  anyone notices.
- Does it provide scheduling, persistent key-value storage, outbound HTTP, and
  mail delivery in the box? Each one you have to add is another account,
  another credential, and another thing that can expire.

**What this one chose, and why.** Google Apps Script. Not because it is
elegant — it is not — but because it scores better on all four questions above
than a technically superior CI-based alternative:

| Need | Apps Script | GitHub Actions |
|---|---|---|
| New account for the next volunteer | none, if the organization already uses Google | yes |
| Editing a value | a web editor | git, a clone, a commit |
| Scheduling | time-driven triggers | cron in a workflow file — **auto-disabled after 60 days of repository inactivity** |
| State between runs | `PropertiesService` | commit a file back, or add a service |
| Mail | `MailApp` | add a provider and an API key |

That 60-day row is the decisive one. A scheduled job that switches itself off
after a quiet period is precisely the failure §7 is about, and the quiet period
is *exactly* when nobody is looking. Choose for the person who inherits it, not
for the person building it.

**Cost.** On YouTube specifically:

- **Discovery** uses the channel RSS feed (`feeds/videos.xml?channel_id=…`) —
  free, no quota, no key, returns the 15 newest.
- **Detail** uses `videos.list` — **1 quota unit for a call covering up to 50
  IDs**, so batch them. The daily free allowance is 10,000 units.
- **Never `search.list`.** It costs 100 units per call, and answers a question
  the free feed already answered. One careless loop over it exhausts the day.

Run the whole thing inside the free tier deliberately, because a pipeline with a
recurring bill is a pipeline somebody eventually cancels — and nobody tells the
person who built it.

---

## 10. Parameters to tune

Keep every one of these in a single config block at the top of the file, so that
the person who inherits this can change behaviour without reading code.

| Parameter | What it trades off |
|---|---|
| source channel / feed identifier | — |
| notification recipient | — |
| settle interval after actual end | §8: stale description vs. missed window |
| staleness threshold | §7: how long an absence is tolerated before alerting |
| minimum description length before warning | false warnings vs. missed incompleteness |
| number of handled IDs to retain | memory vs. risk of re-notifying; keep it comfortably above the feed's page size |
| default value for the commonly-missing field | §6: must be surfaced as an assumption, never as a fact |
| title prefix / category patterns | §4: labelling only, never gating |
| trigger frequency | timeliness vs. quota; see §7's "prefer design over notification" |

---

## 11. Honest accounting of what this is worth

**The time saved is small.** On the workflow this came from, the manual
sequence took around twelve minutes per item. The automated version still
requires a human to open the notification, paste the prepared fields into the
destination, upload a thumbnail, and publish. The clock-time saving is a few
minutes per week. If you are justifying this project on hours saved, the numbers
will not support it, and you should not pretend otherwise.

**The value is that you no longer have to remember.**

That is not a softer version of the same benefit. It is a different benefit, and
it is the one that determines whether the work gets done:

- The item arrives in your inbox. You are not required to check whether there is
  anything to do, on a schedule, forever. The checking was the part that
  consumed attention all week and produced nothing.
- Everything needed is in one message, already formatted. There is no sequence
  to hold in your head, so an interruption costs nothing.
- If the item does not arrive when it should have, you are told. You are not
  required to notice an absence.
- Three actions fit in a gap. Fifty do not. The task moves from "needs a
  protected block of time" to "can be done while waiting for something else",
  and that is the difference between a thing that happens and a thing that
  doesn't.

The honest one-line summary: **this does not save much time; it removes the
requirement to remember, and that is why the work keeps happening.**

Claim that, and nothing more. Inflating the time saving invites someone to
measure it, find it small, and conclude the whole approach was not worth it —
when the thing that was actually worth it was never the minutes.

---

## 12. What this method does not solve

Stated plainly, so nobody inherits a false impression:

- It does not write to the destination system. That requires a write API the
  destination may not expose, and asking for one is a conversation with its
  owner, not an engineering task. Until then the final publish is manual, and
  the package is designed to make that paste as cheap as possible.
- It cannot supply information no human ever recorded (§6).
- It does not re-read items after handling them (§8).
- It does not verify that the published result is correct. Nothing in this
  pipeline checks the destination.
- It depends on the structural metadata of a third-party platform. If that
  platform changes its schema, §7's alerting is what tells you — which is the
  argument for §7, not a reason to trust the pipeline more than it deserves.
