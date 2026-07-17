---
name: task
description: Run an engineering task with taskId + brief, branch from main, commit in logical steps, open a PR titled [taskId]: …
user-invocable: true
args:
  - name: taskId
    description: >-
      Short identifier for this work (ticket key, issue number, or label). Used in the PR title prefix [taskId].
    required: true
  - name: task
    description: >-
      What to implement or fix — scope, acceptance criteria, and any constraints the engineer should respect.
    required: true
---

Use this skill when the user supplies a **task id** and a **task description**. Pick up the work, follow the repository **Git Workflow** in `CLAUDE.md`, implement the change, and finish with a pull request.

## Inputs

- **taskId** — Stable reference for tracking (e.g. `CC-42`, `GH-123`). Must appear in the PR title.
- **task** — Clear description of the outcome: what to build or fix, files or areas to touch if known, and how to verify success (tests, manual checks).

If either input is missing or ambiguous, ask a concise clarifying question before writing code.

## Workflow (mandatory)

Follow **`CLAUDE.md` → Git Workflow — MANDATORY** for this repository. In order:

### Before writing any code

1. `git fetch origin`
2. Create a branch from `origin/main`: `git checkout -b <branch-name> origin/main`
3. Use branch prefixes: `feat/`, `fix/`, `refactor/`, or `docs/` (e.g. `feat/add-export`, `fix/login-redirect`). Optionally include the task id in the branch name if helpful (e.g. `feat/CC-42-school-filters`).

### While implementing

4. **Commit after each logical step** — not one giant commit. Each commit should be one coherent, reviewable change (e.g. schema → queries → UI → tests). Messages should explain *why*, not only *what*.
5. Stay within the task scope. Match existing patterns in the codebase; defer to `CLAUDE.md` for architecture, i18n, DB, and conventions.

### When the task is complete

6. Push the branch and **open a PR against `main`** with `gh pr create`. Do this without waiting for the user to ask.

### PR title and body

- **Title (required format):** `[taskId]: <Task title>`

  - `<Task title>` is a short, imperative summary of the work (like a good commit subject), not the full task paragraph.

  Example: taskId `TASK-42`, task “Add CSV export for school list” → **`[TASK-42]: Add CSV export for school list`**

- **Body:** Repeat or link the **taskId**, summarize what changed and why, list how to test, and note any follow-ups. Reference the original task description where useful.

### Follow-up on existing PRs

If continuing work that already has a PR: before pushing, check `gh pr view <number> --json state`. If the PR is merged, start a **new** branch from `origin/main` and open a **new** PR (do not pile unrelated work onto a merged branch’s history in a confusing way).

## Definition of done

- Task scope addressed; build/lint relevant checks pass as appropriate for the change.
- Commits are **incremental** and **meaningful**.
- Branch is **pushed** and a **PR to `main`** exists with title **`[taskId]: …`**.

Remember: the task id ties the PR to planning/tracking; the commits tell the story of the implementation.
