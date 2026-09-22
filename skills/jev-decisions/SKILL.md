---
name: jev-decisions
description: Use when a small typed judgement is needed and a fast, consistent answer beats free-form reasoning — classifying or routing an item, scoring urgency or sentiment or complexity, deciding whether an action is risky enough to gate, or checking a batch of inputs against the same criteria. Jev (System One) returns a probability, a label, or a score in a few hundred milliseconds, which makes it the right call for breadth — many judgements that must agree with each other — and the wrong call for depth. Do not use it for counting, arithmetic, date or timezone comparison, multi-hop reasoning, or adversarial security decisions.
---

# Jev decisions

Reach for Jev when the question is small, typed, and asked many times. Reach for your own reasoning when the question is deep, arithmetic, or adversarial.

## Which tool

- One question → `jev_decide`, with `kind` choosing the answer type: `noul` (yes/no probability, no `options`), `choice` (one of 2–255 labels), `score` (a position on 2–10 ordered levels, lowest first).
- Several questions about the same `state`, or per-label rubrics for a `choice` → `jev_evaluate`. It sends one request and returns one answer per question id, so ten questions cost one round trip rather than ten.

Prefer `jev_evaluate` whenever more than one judgement shares the same `state`.

## Reading the answer

- **Probabilities are not calibrated.** Easy questions saturate near 1.0 and hard ones drift low, so a raw threshold is a bad cut and a **ranking is a good one**. Sort by probability; think twice before gating on a fixed number.
- `score` is a **zero-based position**, not a percentage. Read the label through `legend` (`{"0": "low", "1": "high"}`) instead of assuming the scale.
- `confidence` is what tells you whether the judgement is usable. A label with 0.45 confidence is not an answer — treat it as "ask a human" or "leave it to the model".
- The envelope also carries `model` and `usage`; quote them when the cost or the version matters.

## When not to use it

Counting, arithmetic, date and timezone comparison, indirect or double-negated reasoning, and long context with little relevant material are all documented weaknesses — the same failure you would not accept from a junior colleague. It is also the wrong tool for **adversarial** input: text inside `state` can try to steer the answer, so never let Jev alone decide a security question whose input a third party controls.

## The gate already runs

When the profile enables `guard`, `rules`, or the other hooks, they intercept tool calls on their own; you do not call them. A refusal comes back with the reason in the tool result — read it and reformulate rather than retrying the same call. The offline rule layer refuses known-destructive commands with no network at all, and its refusals cannot be approved away.

## Data leaves the machine

`state` — and, for the gate, the tool arguments — is sent to the TypeSafe API and recorded in the session log. Keep credentials and personal data out of it, and check `/jev-status` when a call seems not to have happened: it reports the switches, thresholds, counters, and the reasons a call was skipped or dropped.
