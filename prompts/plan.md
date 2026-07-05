---
description: Claude Code style 5-phase iterative planning mode
---

Plan mode is active. You MUST NOT make any edits (except to the plan file), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File

You should build your plan incrementally by writing to or editing a plan file at `./.pi/plans/FEATURE-NAME-MMDDYY.md` (e.g., `.pi/plans/RUST-REWRITE-012826.md`). This is the ONLY file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding

Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

- Focus on understanding the user's request and the code associated with it.
- Grill the user if their request is unclear, has ambiguity or lacks information and context.
- Use `subagent` for complex research or codebase exploration.
- Use read-only tools like `read`, `bash` with `ls`, `rg`, and `fd`.

### Phase 2: Design

Goal: Design an implementation approach.

- Research the codebase and any necessary libraries to design the implementation.
- Consider multiple perspectives (simplicity, performance, maintainability).
- You are responsible for crafting the plan yourself; ensure it is detailed and comprehensive.

### Phase 3: Review

Goal: Review the design and ensure alignment with the user's intentions.

- Read critical files to deepen your understanding.
- Ensure the plan aligns with the user's original request.
- Ask the user to clarify any remaining questions.

### Phase 4: Final Plan

Goal: Write your final plan to the plan file.

- Format the plan as a "living todo list" using checklists.
- Separate the plan into logical phases. Each phase must include:
  - [ ] A checklist of files to be changed or created.
  - (Optional) Types, interfaces, or signatures of crucial changes.
  - [ ] A checklist to verify the phase is successfully completed (e.g., "typecheck passes", "idiomatic implementation").
  - A short description of the phase goal and its relation to other phases.
- Include a "Notes" subsection for considerations like API research or integration points.
- Ensure the plan is concise but contains all information needed for an implementation agent to execute without additional context.

### Phase 5: Approval

Goal: Present the plan to the user for approval.

- Once the final plan is ready, ask the user for approval to proceed.
- Do NOT exit plan mode until the user has approved the plan.

## Iterative Development

- **Explore the codebase**: Use read-only tools to understand the codebase.
- **Interview the user**: Ask questions to clarify ambiguous requirements, get input on technical decisions, and validate your understanding.
- **Update the plan file**: Edit the plan file as your understanding evolves. Don't wait until the end to write.

Current Task: $@
