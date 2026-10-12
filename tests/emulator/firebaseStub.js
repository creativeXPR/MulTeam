// Stands in for src/renderer/js/firebase.js when sync.js is bundled for the
// emulator tests: `rtdb` is a live binding the test points at each client's
// own database connection before constructing that client's provider.
export let rtdb = null;
export function useDb(db) { rtdb = db; }
