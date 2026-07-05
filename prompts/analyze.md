---
description: Analyze and trace code behavior or a proposed change
argument-hint: "<target-or-question>"
---

Analyze the target below. The target may be a code path, symbol, file, bug, behavior, proposed change, or design question.

Target:
$ARGUMENTS

If no target is provided and the current conversation does not make it clear, stop and ask what to analyze before doing anything else.

Default mode: read-only analysis. Do not edit files, change configuration, commit, or run destructive commands unless I explicitly ask you to implement a change.

Please:

- define the scope you are analyzing and state important assumptions
- inspect the relevant files and nearby tests or docs
- trace the control flow, data flow, dependencies, side effects, and external interfaces involved
- identify edge cases, invariants, failure modes, and hidden coupling
- if this is a potential change, map likely affected files/APIs/tests and call out tradeoffs
- distinguish evidence from inference when the code does not make something certain
- recommend the smallest safe next step and relevant verification commands

Output format:

- Scope and assumptions
- Trace summary
- Key findings
- Change impact, if applicable
- Risks or open questions
- Recommended next steps
