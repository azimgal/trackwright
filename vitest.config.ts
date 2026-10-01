import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: false,
    // Default (5s) got tight once ticket-state auto-commit (workflow/engine.ts,
    // commitTicketState) started spawning two more real git subprocesses on every stage
    // transition, on top of code-review now also fetching a real diff — several tests walk a
    // full multi-stage pipeline and occasionally exceeded 5s on a loaded machine. A real hang
    // still fails well before 15s.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
