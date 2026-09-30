// The core-link frames, without the rest of `@actana/sdk/core`.
//
// Browser code (the Panel's client bundle) and modules shared with it need the
// frame types and constants and nothing else. The published `@actana/sdk` 0.5.0
// exports no leaf subpath for them — only the `./core` barrel, which also
// re-exports the Core client, the WebSocket transport and the file transfer
// client, and through them undici, ws and Node builtins. Imported by a browser
// module, that barrel makes Vite externalize 120 Node modules and the chunk
// throws on load (`util.debuglog is not a function`).
//
// So this re-exports the one leaf file by its path inside the installed
// package. `link-frames` imports nothing at all, which is what makes it safe;
// `src/__tests__/sdk-link-frames.test.ts` asserts that, so a package update that
// changes it fails loudly. Browser-reachable code must import frames from here
// and never from `@actana/sdk/core`; `packages/panel/src/__tests__/
// client-bundle.test.ts` builds the Panel and fails if any Node module is
// externalized into the client.
//
// Temporary: actana/client#13 asks for a real leaf subpath (or a side-effect-free
// barrel). When it ships this file becomes `export * from "@actana/sdk/core/link-frames"`.
export * from "../node_modules/@actana/sdk/dist/core/link-frames.js";
