---
name: writing-great-evals
description: Write and review eval definitions — cases, fixtures, assertions, rubrics, and grader logic. Use when adding or changing an eval, or when deciding whether proposed eval coverage earns its place.
---

An eval protects one **contract**: a single stable behavior stated as *given [input], the subject [one observable outcome]*. Every element — input, fixture, assertion, rubric, grader — exists to protect that contract. One eval, one outcome, one reason to fail.

Evals reward subtraction. The unit-test instinct — bundle assertions, enumerate fields, pin formatting, build a validator — produces evals that fail when incidental details change and pass when the behavior regresses. A great eval is the smallest thing that catches its regression.

## 1. Name the contract

Write the contract sentence, then the unique regression this eval alone would catch and why existing coverage misses it. Put both in the case description. Each eval earns its place.

**Done when:** a reader can tell from the description alone why this eval exists. If the contract or the regression is unclear, stop — the eval isn't ready.

## 2. Choose the grading seam

Ask: **are you proving data accuracy against stable fixture data, or testing a behavior?**

**Data accuracy** — the fixture is seeded ground truth and the contract is reproducing it: a computed figure, an ID, a JSON shape, a status code. Assert the exact expected value; coupling to the fixture is correct here *because the fixture is the ground truth*.

```yaml
description: "Rolls up planned benefit across a program's initiatives."
tests:
  - vars:
      msg: "What is the total planned benefit for the Alpha program?"
    assert:
      - type: llm-rubric
        value: "States the total planned benefit of 738,500."
```

**Behavior** — the fixture only provokes the response; the contract is a **property** of it: one or two sentences stating what a correct response does. Properties survive fixture, wording, ordering, and formatting changes; today's manifestation doesn't.

```yaml
description: "Recommendations remain identifiable."
tests:
  - vars:
      msg: "What should I work on today?"
    assert:
      - type: llm-rubric
        value: "Each recommendation includes its repository, originating tool, topic, and next step."
```

**Both in one case** — split into separate assertions, or separate evals, so each fails independently and the failure names its mechanism.

**Done when:** each assertion maps straight to the contract — ask of every value asserted, *is the literal the contract, or a proxy for it?* Exact where it's the contract, property where it's a proxy.

## 3. Bound the case

Use the smallest input and fixture that provoke the contract, phrased the way a real user asks. Several natural phrasings of the same question are one contract; a second behavior is a second eval.

**Done when:** removing any remaining requirement would weaken the contract, and — for property contracts — a correct answer still passes after incidental fixture or wording changes.

## 4. Keep the grader lean

Reach for the harness's stock assertions (llm-rubric, exact/contains, JSON schema) before custom grader code. Grader complexity spends from the same budget as the contract's value: a grader that needs its own tests costs more than most contracts are worth, and is usually step 2 telling you the seam is wrong — a prose outcome wants a semantic rubric; a structured outcome wants structured output to assert on.

**Done when:** the grader is a stock assertion, or the custom code is smaller than the behavior it protects.

## 5. Grade the eval

Run the two-sided check:

- Could a **correct** implementation fail this eval? (over-prescription)
- Could an **incorrect** implementation pass it? (proxy assertions, surface cues)

Then score:

| Score | Grade | Meaning |
|---:|---|---|
| 0 | Invalid | Measures something other than the claimed contract, or can't distinguish correct from incorrect behavior. |
| 1 | Brittle | Right behavior, but over-prescribes wording, formatting, or fixture values, or bundles several outcomes. |
| 2 | Weak | Real contract, but duplicative, noisy, or low regression value for its cost. |
| 3 | Good | One valuable contract, right seam, tolerates valid variation, fails for a diagnosable reason. |
| 4 | Exemplary | Good, and minimal — every input, fixture detail, assertion, and rubric clause is necessary. |

**Admission: 3.** Below that, simplify, split, or reject. A 4 is uncommon — it means there is nothing left to remove.

**Done when:** the eval scores 3 or higher and every deficiency that kept it lower has been resolved.
