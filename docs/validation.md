# Validation and provenance

## Acceptance chronology

The M3.1 report at private source `902a76c` records technical completion and independent review while human acceptance was pending at the time. A later M3.2 progress record (`8bfdc64`, `docs/m3/m3-2-progress.md`) states that subsequent human approval superseded that wording. The original acceptance message and its date are not preserved in the inspected documents. These statements describe different points in time. No historical document has been rewritten, and acceptance does not authorize publication.

## Historical evidence (not rerun as part of selection)

| Check | Reported result | Boundary |
| --- | --- | --- |
| TypeScript baseline | 403 passed | Fifteen files; simulated transport |
| Targeted revalidation | 112 passed | Affected paths after a fix; overlaps baseline |
| Native Windows Rust | 114 passed | Fixture seam substitutes generation; real local authorization/session/SQLite/executor |
| Native Windows fixture UI | 25 checks | WebViews and IPC real; provider generation simulated |
| Real Gemini evaluation | 21 aggregate calls | Small sample; failures retained; final seven valid responses do not imply universal correctness |

Private raw manifests, operational paths, screenshots and remote-evaluation controllers are intentionally omitted. The numbers are source-report summaries, not independently reproduced evidence for this edited documentation selection. There is no claimed benchmark accuracy or additive total.

## Reproduce without provider calls

Linux or Windows: `npm ci`, `npm test`, `npm run build`. Node script tests only exercise the observer with synthetic objects; importing its module does not start native acceptance.

Windows native only: after frontend build, `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib` and `cargo build --manifest-path src-tauri/Cargo.toml --locked --bin jarvis`. Do not equate Linux frontend success with Windows IPC, lifecycle, WebView2 or native UI validation. Native UI testing requires an isolated profile and separate manual protocol; it is not provided by the minimal CI.

No CI execution badge is claimed. A proposed workflow is held in the private review package until dependency triage is resolved. It separates Ubuntu frontend from Windows Rust compilation/unit tests and contains no model key or application launch.

## Dependency gate

The portfolio selection updates Vitest to 4.1.12. A clean `npm ci` with lifecycle scripts enabled, 406 tests, four Node tests and build passed on Linux; the npm audit returned zero findings at the time checked. The lock was generated using `--legacy-peer-deps` after npm's peer resolver failed, then reproduced with normal `npm ci`. Review any new audit and dependency notices before distribution. Do not expose test services or run untrusted tests.

## This preparation

See the private review package for actual command results, composition hashes, dependency reassessment and preservation checks. Native Windows Rust unit tests and a debug binary build have now been rerun offline in an isolated copy. Live model evaluation and native UI interaction have not been rerun.

Preparation checks on the selected source: 406 TypeScript tests in 15 files, four Node observer tests, TypeScript checking and Vite production build passed on Linux with Node 22.23.2. The updated lock was also validated using a clean `npm ci` with lifecycle scripts enabled. These results do not establish native Windows execution.

Native Windows revalidation: 114 Rust library tests passed and the debug binary compiled using `--offline --locked`, with incremental compilation disabled because the WSL filesystem rejected its lock. The binary was not launched; UI, WebView2 lifecycle and real provider calls were not revalidated. The tested source and dependency manifests were compared with the candidate.

## Isolated native UI attempt

A debug build from the public source was run with a separate application identifier, database location and WebView profile. Central and floating WebViews opened. With no credential, a synthetic conversation request showed the expected unavailable response and recorded zero provider calls. Both windows were captured with simulated display data.

Creating a synthetic task via IPC failed while using an isolated database path on the WSL-backed filesystem. The recorded error was generic; the exact cause has not been established. Task persistence, executor, receipt, restart and full UI acceptance were not demonstrated in this run. The application was closed through IPC and no scoped process remained. The captures do not demonstrate a provider response or completed task. Previous Windows unit-test and historical fixture results remain separate evidence.

## Subsequent native Windows UI check

A separate isolated Windows-filesystem run created a synthetic task through the Central task form. The UI displayed “Tarefa criada” and a backend snapshot contained the new task. A separate backend-only run confirmed a different synthetic task survived application restart. These observations do not demonstrate an executor receipt or a model-interpreted action. No provider credentials or calls were used. The initial WSL-backed database failure remains historical; an independent SQLite probe returned SQLITE_BUSY on that share and succeeded on Windows, while the original backend error did not retain its SQLite code.
