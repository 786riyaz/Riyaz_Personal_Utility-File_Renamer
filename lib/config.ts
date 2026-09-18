// Shared tunables for the Ollama-assisted renaming pipeline.
//
// Small local models (7B-class) get unreliable at emitting a perfectly
// sized JSON array once a batch grows much past ~10-15 items, especially
// once every item needs a reasoned title/year/episode decision. That is
// what caused errors like "Ollama returned 30 names for 34 items." The fix
// is twofold:
//   1. Chunk requests client-side so each call to Ollama is small.
//   2. Never hard-fail on a partial batch — match returned names by index,
//      and let the caller fall back to the deterministic name for anything
//      Ollama skipped.
export const OLLAMA_BATCH_SIZE = 10;

// Client-side per-request timeout budget. Kept generous because local
// models on modest hardware can be slow, especially on the first call
// after the model has to load into memory.
export const OLLAMA_REQUEST_TIMEOUT_MS = 300_000;

// If Ollama skips more than this many items in a batch, don't bother with
// the automatic single retry pass — just keep the deterministic names.
export const OLLAMA_MAX_SELF_HEAL_ITEMS = OLLAMA_BATCH_SIZE * 3;
