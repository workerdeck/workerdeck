// Stands in for Monaco's four worker-backed language services (see
// `vite.config.ts`). They are namespace-imported and re-exported by Monaco's
// entry and never called by it — registration is their import side effect — so
// an empty module removes them cleanly.
export {}
