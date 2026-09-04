// `window.api` inside `page.evaluate` callbacks is the contextBridge surface
// the preload exposes; this is the same declaration the renderer compiles
// against.
import '../src/preload/index.d.ts'
