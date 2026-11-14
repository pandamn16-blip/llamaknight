import type { Scene } from 'phaser';
import type { CharacterVisual } from './definitions';

import { animationSource, hasSpriteFrames, FOOT_ORIGIN, ACTOR_ANIMATIONS } from '../rendering/spriteAssets';
import type { ActorAnimation, ActorSpritePack, SpriteSheetSource, AnimationClip } from '../rendering/spriteAssets';

export type PlayerAnimation = ActorAnimation;
export type CharacterSpriteSheet = ActorSpritePack;

const combined: SpriteSheetSource = {
    key: 'llama-crunch', path: 'characters/llama-crunch/llama-crunch-9x3-256-import-test.png',
    width: 2304, height: 768, frameWidth: 256, frameHeight: 256
};

// Each state can use its own sheet, including a legacy combined texture as fallback.
export const CHARACTER_SPRITES: Partial<Record<CharacterVisual, CharacterSpriteSheet>> = {
    llama: {
        format: 'separate', key: 'llama-crunch',
        scale: 0.5, originX: FOOT_ORIGIN.x, originY: FOOT_ORIGIN.y, offsetX: 0, offsetY: 40,
        animations: {
            idle: { start: 0, end: 3, fps: 6, repeat: -1,
                sheet: { key: 'llama-crunch-idle', path: 'characters/llama-crunch/idle.png',
                    width: 1024, height: 256, frameWidth: 256, frameHeight: 256 },
                fallback: { sheet: combined, start: 0, end: 3, fps: 6, repeat: -1 } },
            run: { start: 0, end: 5, fps: 10, repeat: -1,
                sheet: { key: 'llama-crunch-run', path: 'characters/llama-crunch/run.png',
                    width: 1536, height: 256, frameWidth: 256, frameHeight: 256 },
                fallback: { sheet: combined, start: 4, end: 9, fps: 10, repeat: -1 } },
            jump: { sheet: combined, start: 10, end: 12, fps: 12, repeat: 0 },
            fall: { sheet: combined, start: 13, end: 14, fps: 10, repeat: 0 },
            attack: { start: 0, end: 4, fps: 30, repeat: 0, includesWeaponEffect: true,
                sheet: { key: 'llama-crunch-attack', path: 'characters/llama-crunch/attack.png',
                    width: 1280, height: 256, frameWidth: 256, frameHeight: 256 },
                fallback: { sheet: combined, start: 15, end: 18, fps: 24, repeat: 0 } },
            hurt: { sheet: combined, start: 19, end: 21, fps: 18, repeat: 0 },
            death: { sheet: combined, start: 22, end: 26, fps: 10, repeat: 0 }
        }
    },
    candy: {
        format: 'separate', key: 'candy',
        scale: 0.5, originX: FOOT_ORIGIN.x, originY: FOOT_ORIGIN.y, offsetX: 0, offsetY: 40,
        animations: {
            idle: { start: 0, end: 3, fps: 5, repeat: -1,
                sheet: { key: 'candy-idle', path: 'characters/candy/idle.png',
                    width: 1024, height: 256, frameWidth: 256, frameHeight: 256 } },
            run: { start: 0, end: 5, fps: 8, repeat: -1,
                sheet: { key: 'candy-run', path: 'characters/candy/run.png',
                    width: 1536, height: 256, frameWidth: 256, frameHeight: 256 } },
            jump: { start: 0, end: 3, fps: 12, repeat: 0,
                sheet: { key: 'candy-jump', path: 'characters/candy/jump.png',
                    width: 1536, height: 256, frameWidth: 256, frameHeight: 256 } },
            fall: { start: 4, end: 4, fps: 8, repeat: 0,
                sheet: { key: 'candy-jump', path: 'characters/candy/jump.png',
                    width: 1536, height: 256, frameWidth: 256, frameHeight: 256 } },
            attack: { start: 0, end: 5, fps: 20, repeat: 0,
                sheet: { key: 'candy-attack', path: 'characters/candy/attack.png',
                    width: 1536, height: 256, frameWidth: 256, frameHeight: 256 } },
            // hit.png is an unconverted 2172px-wide source, not a 256px strip.
            // Use a valid idle pose until that file is re-exported as 1536x256.
            hurt: { start: 0, end: 0, fps: 12, repeat: 0,
                sheet: { key: 'candy-idle', path: 'characters/candy/idle.png',
                    width: 1024, height: 256, frameWidth: 256, frameHeight: 256 } },
            death: { start: 0, end: 5, fps: 10, repeat: 0,
                sheet: { key: 'candy-death', path: 'characters/candy/death.png',
                    width: 1536, height: 256, frameWidth: 256, frameHeight: 256 } }
        }
    }
};

// Newly supplied charge art is a 6x2 grid of 362px cells, NOT 256px frames.
// Load its native grid without stretching; visual scaling compensates.
// It should be re-exported to 12x256 in the standard horizontal format later.
export const CANDY_CHARGE = {
    key: 'candy-charge', path: 'characters/candy/charge.png',
    width: 2172, height: 724, frameWidth: 362, frameHeight: 362,
    start: 0, end: 11, fps: 12, repeat: 0
} as const;

export function hasCandyCharge(scene: Scene): boolean {
    return scene.textures.exists(CANDY_CHARGE.key) &&
        scene.textures.get(CANDY_CHARGE.key).getSourceImage().width === CANDY_CHARGE.width &&
        scene.anims.exists('candy:charge');
}

// Optional celebration animation; not required for the character to load.
export const CANDY_LEVELUP = {
    key: 'candy-levelup', path: 'characters/candy/levelup.png',
    width: 1536, height: 256, frameWidth: 256, frameHeight: 256,
    start: 0, end: 5, fps: 12, repeat: 0
} as const;

export function hasCandyLevelUp(scene: Scene): boolean {
    return hasSpriteFrames(scene, CANDY_LEVELUP, CANDY_LEVELUP) &&
        scene.anims.exists('candy:levelup');
}

export function resolveCharacterAnimation(scene: Scene, pack: CharacterSpriteSheet, state: PlayerAnimation) {
    const clip = pack.animations[state];
    if (!clip) return undefined;
    const source = animationSource(pack, state);
    if (hasSpriteFrames(scene, source, clip)) return { source, clip };
    const fallback = pack.format === 'separate' ? pack.animations[state].fallback : undefined;
    if (fallback && hasSpriteFrames(scene, fallback.sheet, fallback)) return { source: fallback.sheet, clip: fallback };
    return undefined;
}

export function hasCharacterSheet(scene: Scene, pack: CharacterSpriteSheet): boolean {
    return ACTOR_ANIMATIONS.every(state => !!resolveCharacterAnimation(scene, pack, state));
}

export function loadCharacterSheets(scene: Scene): void {
    // Deduplicate the legacy combined texture while loading each separate state texture once.
    const sources = new Map<string, { source: ReturnType<typeof animationSource>; end: number }>();
    for (const pack of Object.values(CHARACTER_SPRITES)) {
        for (const state of Object.keys(pack.animations) as PlayerAnimation[]) {
            const source = animationSource(pack, state);
            const clips: { source: SpriteSheetSource; clip: AnimationClip }[] = [{ source, clip: pack.animations[state] }];
            const fallback = pack.format === 'separate' ? pack.animations[state].fallback : undefined;
            if (fallback) clips.push({ source: fallback.sheet, clip: fallback });
            for (const entry of clips) {
                const end = Math.max(entry.clip.end, sources.get(entry.source.key)?.end ?? 0);
                sources.set(entry.source.key, { source: entry.source, end });
            }
        }
    }
    // Candy's landing pose is frame 6 of jump.png (index 5). It is manually
    // displayed after physics detects a landing, not part of a looping clip.
    const candyJump = sources.get('candy-jump');
    if (candyJump) candyJump.end = 5;
    sources.set(CANDY_LEVELUP.key, { source: CANDY_LEVELUP, end: CANDY_LEVELUP.end });
    scene.load.spritesheet(CANDY_CHARGE.key, CANDY_CHARGE.path, {
        frameWidth: CANDY_CHARGE.frameWidth, frameHeight: CANDY_CHARGE.frameHeight,
        startFrame: CANDY_CHARGE.start, endFrame: CANDY_CHARGE.end
    });
    for (const { source, end } of sources.values()) {
        scene.load.spritesheet(source.key, source.path, {
            frameWidth: source.frameWidth, frameHeight: source.frameHeight, startFrame: 0, endFrame: end
        });
    }
}

export function registerCharacterAnimations(scene: Scene): void {
    if (scene.textures.exists(CANDY_CHARGE.key) &&
        scene.textures.get(CANDY_CHARGE.key).getSourceImage().width === CANDY_CHARGE.width &&
        !scene.anims.exists('candy:charge')) {
        scene.anims.create({ key: 'candy:charge',
            frames: scene.anims.generateFrameNumbers(CANDY_CHARGE.key,
                { start: CANDY_CHARGE.start, end: CANDY_CHARGE.end }),
            frameRate: CANDY_CHARGE.fps, repeat: CANDY_CHARGE.repeat
        });
    }
    if (hasSpriteFrames(scene, CANDY_LEVELUP, CANDY_LEVELUP) && !scene.anims.exists('candy:levelup')) {
        scene.anims.create({ key: 'candy:levelup',
            frames: scene.anims.generateFrameNumbers(CANDY_LEVELUP.key,
                { start: CANDY_LEVELUP.start, end: CANDY_LEVELUP.end }),
            frameRate: CANDY_LEVELUP.fps, repeat: CANDY_LEVELUP.repeat
        });
    }
    for (const pack of Object.values(CHARACTER_SPRITES)) {
        if (!hasCharacterSheet(scene, pack)) continue; // Incomplete packs retain the placeholder.
        for (const state of Object.keys(pack.animations) as PlayerAnimation[]) {
            const resolved = resolveCharacterAnimation(scene, pack, state)!;
            const animation = resolved.clip;
            const source = resolved.source;
            const key = `${pack.key}:${state}`;
            if (scene.anims.exists(key)) continue;
            scene.anims.create({ key,
                // Frame 3 (index 2) is Candy's blink. Exclude it from the
                // ordinary idle cycle; PlayerVisual inserts it occasionally.
                frames: pack.key === 'candy' && state === 'idle'
                    ? scene.anims.generateFrameNumbers(source.key, { frames: [0, 1, 3, 1] })
                    : scene.anims.generateFrameNumbers(source.key, { start: animation.start, end: animation.end }),
                frameRate: animation.fps, repeat: animation.repeat
            });
        }
    }
}
