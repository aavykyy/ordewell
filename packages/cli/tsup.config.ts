import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  clean: true,
  // `ws` is a real runtime dependency and @ordewell/core ships its own dist, so
  // both stay external. string-width@7 is ESM-only, and this bundle is CJS:
  // tsup would leave an eager require('string-width') at the top of main.js,
  // which throws ERR_REQUIRE_ESM before argv is read on Node 20.0–20.18 and
  // 22.0–22.11 (require(esm) is on by default only from 20.19/22.12). Bundling
  // it keeps every command runnable on the Node >=20.3 the package declares.
  // Its MIT notice ships in THIRD-PARTY-NOTICES.md (see the build script).
  external: ['ws', '@ordewell/core'],
  noExternal: ['string-width'],
});
