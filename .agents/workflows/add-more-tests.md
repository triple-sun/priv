---
description: Add more tests
---

# Add More Tests Workflow

Use this workflow when adding tests to existing code that lacks coverage.

## Steps

1. **Identify the target**: Use `view_file` to read the source file(s) that need test coverage.
2. **Find existing tests**: Search for existing test files (`*.test.ts`, `*.test.tsx`, `*_test.go`, Rust `#[cfg(test)]` modules) in the same package/directory.
3. **Analyze gaps**: Identify untested branches, error paths, and edge cases in the target code:
   - Happy path already tested? Focus on error and edge cases.
   - Are boundary values covered? (empty input, max values, nil/undefined)
   - Are concurrent/async paths covered? (race conditions, timeouts)
4. **Write tests**: Add tests following existing conventions in the file:
   - **TypeScript**: Vitest, using `describe`/`it` blocks. Place in `__tests__/` or co-located `*.test.ts`.
   - **Go**: Table-driven tests in `*_test.go`. Use `t.Run` for subtests. Run with `-race` flag.
   - **Rust**: `#[cfg(test)] mod tests` in the same file, or integration tests in `tests/`.
5. **Verify**:
// turbo-all
   - Run the new tests and ensure they pass.
   - Run `make lint-app` or `make lint-server` to ensure no lint regressions.
   - Confirm test names are descriptive (describe the scenario, not the implementation).
