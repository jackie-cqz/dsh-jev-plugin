# Changelog

## 0.1.0 — 2026-10-02

Initial public release.

- Add `jev_decide` for yes/no, label selection and ordered scoring, plus `jev_evaluate` for multiple questions.
- Provide optional guardrails, offline denial rules, review, routing and context pruning; hooks are disabled by default.
- Include Web decision cards, a Jev usage skill, configurable retries and caching, and status/telemetry reporting.
- Support DSH `0.2.0-rc.2`, with installation regressions for `0.1.7-rc.2` and `0.1.6-alpha.2`.
- Fix Windows ESM paths in live acceptance scripts and support npm 10/11/12 packaging reports.
- Ship a prebuilt installation archive and checksums through GitHub Releases.

### Validation

Typechecking, 782 plugin tests, two packaging-parser tests, strict package-content checks, and three DSH runtime installation checks pass. Live TypeSafe smoke checks cover all three decision primitives, multi-question evaluation, object/array input, and invalid/missing credentials; 13 scenario assertions and four characterization probes also pass. Chromium verifies four successful Jev calls and nine result bars, including replay after reload. A scripted LLM adapter drives the browser scenario; Jev requests use the live API. Git-source acceptance is recorded in the GitHub release notes.

### Limits

Only the listed DSH versions have been individually verified. Jev probabilities are not calibrated guarantees; optional gates require workflow-specific threshold validation. DSH credentials/Settings integration and intent instruction injection are not included.
