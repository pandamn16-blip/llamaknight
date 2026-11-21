# Llama Knight environment artwork

World geometry and collision are independent from artwork. See
`src/game/world/terrain.ts` for ledge dimensions, and
`src/game/world/environmentAssets.ts` for texture keys and file paths.

**Breadlands terrain:** 64 × 64 px seamless PNG/WebP tiles for
`ground-top`, `ground-fill`, `platform-left`, `platform-middle`,
and `platform-right`. These correspond to 64 world-unit blocks.
Transparent edges are fine; keep the top of the tile aligned.

**Backgrounds:** `sky.png`, `distant-hills.png` (any suitable large
landscape size, such as 1920 × 1080); parallax is defined in the manifest.
Decorations can be added independently later and should not collide unless
explicitly assigned geometry.

To use an artwork file: add it at the path in the manifest, change its
`enabled` value to `true`, and let the preloader register it. A missing
or disabled texture renders as a placeholder. The first milestone keeps the
main ground continuous and enemies/structures at ground level.
