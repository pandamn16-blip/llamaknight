# Llama Knight assets

Paths below are relative to `public/assets/` (served as `assets/` in the game).
Use lowercase kebab-case folder/file names, descriptive asset names and real
artwork only. Character animation sheets should use transparent PNG or lossless
WebP with alpha; keep frame dimensions and animation mappings in code configuration.
Adding a folder does not load an asset or enable a gameplay feature.

Character and enemy animations must follow `docs/visual-asset-standard.md` in the
repository: untrimmed transparent 256 × 256 frames, facing right, grounded foot
anchor (128, 224), and no artwork crossing cell boundaries. Separate `idle.png`,
`run.png`, `jump.png`, `fall.png`, `attack.png`, `hurt.png` and `death.png` sheets
are preferred. Retain existing combined sheets until explicitly migrated.

| Folder | Intended assets |
| --- | --- |
| `characters/llama-crunch/`, `characters/candy/` | Character sprites and animation sheets |
| `enemies/bread/`, `enemies/lobster/`, `enemies/alien/` | Enemy artwork |
| `pets/pikachu/`, `pets/groot/`, `pets/globe/` | Equipped pet icons and ability artwork |
| `weapons/sword-slash/`, `weapons/candy-shot/`, `weapons/pickle-bomb/` | Weapon artwork |
| `npc/rosie/` | Rosie's artwork |
| `environments/backgrounds/`, `environments/ground/`, `environments/obstacles/` | Scenery artwork |
| `effects/` | Shared visual effects |
| `ui/portraits/`, `ui/icons/`, `ui/menus/`, `ui/dialogue/` | Interface artwork |

## Adding individual animations

Place animation sheets directly inside each of these folders; do not create an
extra animation subfolder:

- `characters/llama-crunch/`
- `characters/candy/`
- `enemies/bread/`
- `enemies/lobster/`
- `enemies/alien/`

Use exactly these filenames: `idle.png`, `run.png`, `jump.png`, `fall.png`,
`attack.png`, `hurt.png`, `death.png`. Add only finished artwork; missing states
should have no file, rather than an empty PNG.

Each file is a transparent spritesheet with untrimmed **256 × 256 pixel frames**.
Prefer one horizontal row: for N frames, export an image N × 256 pixels wide and
256 pixels high, with no spacing or outer margins. Frames run left to right.
Face right; keep the grounded foot anchor at pixel **(128, 224)** in every cell,
with all artwork contained inside its frame. Keep frame counts and FPS with the
asset handoff so they can be entered into the animation configuration.

## Active Llama Crunch artwork

The active idle sprite is `characters/llama-crunch/llamaknight_idle_4x256.png`.
The seven-frame walking animation uses the uploaded
`characters/llama-crunch/Chibi LlamaKnight Walking Cycle Spritesheet.png`
**directly**, as a 4×2 grid of native 443×443 frames (one empty cell).
The old seven-frame strip is still generated for compatibility but is not used in-game.
Both uploaded dash textures (`characters/llama-crunch/dashllama.png` and
`characters/candy/dashcandy.png`) are played directly for the L-key dash.
Llama's jump uses `characters/llama-crunch/llamanewjump.png` directly
as an 8×1 strip of native 271×724 frames with four unused right-edge pixels (no asset resizing).
The eight-frame attack uses the uploaded
`characters/llama-crunch/Eight-Frame Llama Knight Attack Sprite Sheet.png`
**directly**, as a 4×2 grid of native 443×443 frames.

The combined `characters/llama-crunch/llama-crunch-9x3-256-import-test.png`
is still necessary for jump, fall, hurt and death and is retained as fallback.
`characters/llama-crunch/shieldnew.png` is active when defending. It has eight native 271×725 frames: raise [0,1,2], hit [3], hold [4], release [5,6,7]. The old shield.png remains in history.
Other abandoned Llama image trials have been removed from this folder.
See `docs/character-sprites.md` for the complete active-source table.

## Future equipped pets

Pikachu, Groot and Globe are equipped pets, not physical followers. Once acquired,
they appear as icons in the top-left HUD and activate their abilities automatically.
They do not move around the level and need no follower AI.

- Pikachu: offensive lightning abilities.
- Groot: defensive shielding, roots and healing.
- Globe: utility, XP attraction and gravity-related abilities.

Each pet will eventually have five upgrade levels. Pet acquisition and upgrades
will eventually be offered through the existing three-choice upgrade system.
Equipped pet runtime state belongs to the current run; unlocks belong to persistent
player progress. These are future design requirements, not implemented systems.

Folders intentionally contain no fake images or placeholder files. Git does not
track empty directories; recreate them from this folder list if needed in a fresh
checkout.
