---
description: Unit tests
---

# Generate Unit Tests Workflow

Use this workflow when generating unit tests for a file or module from scratch.

## Steps

1. **Read the source**: Use `view_file` to fully understand the module's public API, types, and behavior.
2. **Identify test scope**: List every exported function/method/type. Each gets at least one test.
3. **Plan test cases** per function:
   - **Happy path**: Standard valid input → expected output.
   - **Edge cases**: Empty input, zero values, boundary values, nil/undefined.
   - **Error paths**: Invalid input, network failures, permission errors (whatever applies).
4. **Write the test file**:
   - **TypeScript**: Create `<module>.test.ts` co-located or in `__tests__/`. Use Vitest. Use `describe` per function, `it` per case.
   - **Go**: Create `<package>_test.go`. Use table-driven tests with `t.Run`. Include `-race`-safe patterns.
   - **Rust**: Add `#[cfg(test)] mod tests` at the bottom of the source file. Use `#[test]` functions.
5. **Mock external dependencies** (I/O, network, DB) — never hit real services in unit tests.
6. **Verify**:
// turbo-all
   - Run the test file in isolation to confirm all pass.
   - Run `make lint-app` or `make lint-server` to catch lint issues.
   - Ensure test names are descriptive: `"rejects join with invalid token"` not `"test_join_2"`.
