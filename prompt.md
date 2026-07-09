# Prompt Library (ymca)

Use this file as a quick reference for repeatable prompts.

## 1) Resume from checklist

```text
Please resume from the existing checklist/todo state. Do not restart completed work. Continue from the next ready item, update progress as you go, and report blockers clearly.
```

## 2) Implement next phase item

```text
Please implement the next ready checklist item for Phase <N>. Keep changes surgical, reuse existing patterns, and verify with the project's existing tests/typechecks.
```

## 3) Add reusable test cases

```text
Please create reusable test cases for <module/feature> that can be rerun in future phases. Include happy path, edge cases, and failure cases. Then run tests and summarize results.
```

## 4) Re-run regression tests

```text
Please rerun the reusable test suite for Phase 1 and Phase 2-sensitive functions, then report pass/fail and any regressions.
```

## 5) Run test cases now

```text
Please run the current project's existing test cases now (unit/integration as configured), share the exact command(s) used, summarize pass/fail counts, and list failing tests with root-cause hints.
```

## 6) Debug failure quickly

```text
<Command/Test> is failing with this error:
<paste error>

Please find the root cause, implement the fix, and verify with targeted tests plus relevant regression tests.
```

## 7) Safe refactor request

```text
Please refactor <file/module> for clarity without changing behavior. Reuse helpers, keep type safety, and run tests to prove no regressions.
```

## 8) API contract check

```text
Please validate current implementation against the Blueprint API contract for <section/endpoints>. List gaps and implement missing parts with tests.
```

## 9) Code review mode

```text
Please review the current changes for bugs, security risks, and logic issues only (high signal). Propose concrete fixes and apply them.
```

## 10) Documentation sync

```text
Please update related docs to match the implementation changes in this session. Keep it concise and accurate.
```

## 11) End-of-session reset

```text
After finishing implementation and tests, please reset/clean runtime state (no leftover servers/processes), then provide final checklist status and exact rerun commands.
```

## 12) New feature prompt template

```text
Feature: <name>
Goal: <business/user outcome>
Scope: <in scope>
Out of scope: <not included>
Constraints: <performance/security/compatibility>
Acceptance criteria:
1. <criterion 1>
2. <criterion 2>
3. <criterion 3>

Please implement end-to-end with tests and update the checklist status.
```

## 13) Hotfix prompt template

```text
Hotfix target: <bug title>
Impact: <who/what is broken>
Expected behavior: <correct behavior>
Observed behavior: <actual behavior>
Evidence: <logs/screenshots/errors>

Please patch with minimal risk, add regression tests, and verify before closing.
```
