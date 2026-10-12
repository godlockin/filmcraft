// Vitest setup (M2.8+).
//
// `react-dom/client.createRoot` checks this global before treating
// renders as "inside React's act()". Setting it silences the noisy
// "The current testing environment is not configured to support
// act(...)" warnings the component tests otherwise produce.

// `IS_REACT_ACT_ENVIRONMENT` is declared by `@types/react` for
// React 18.3+; the global assignment is the documented escape hatch
// when you're not using testing-library/react.
// deno-lint-ignore no-explicit-any
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
