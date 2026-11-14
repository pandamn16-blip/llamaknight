import type { Scene } from 'phaser';
import { hasSpriteFrames } from '../rendering/spriteAssets';

export const SWORD_SLASH_EFFECT = {
    key: 'weapon:sword-slash', path: 'weapons/sword-slash/effect.png',
    width: 1280, height: 256, frameWidth: 256, frameHeight: 256,
    animationKey: 'weapon:sword-slash:play', start: 0, end: 4, fps: 18, repeat: 0
} as const;

export const CANDY_PROJECTILE_EFFECT = {
    key: 'weapon:candy-projectile', path: 'characters/candy/projectile.png',
    width: 1536, height: 256, frameWidth: 256, frameHeight: 256,
    animationKey: 'weapon:candy-projectile:impact', start: 4, end: 5, fps: 16, repeat: 0
} as const;

export const CANDY_PROJECTILE_IDLE = {
    key: 'weapon:candy-orb', path: 'characters/candy/projectileidle.png',
    width: 2048, height: 256, frameWidth: 256, frameHeight: 256
} as const;

export function hasCandyChargeOrb(scene: Scene): boolean {
    return scene.textures.exists(CANDY_PROJECTILE_IDLE.key) &&
        scene.textures.get(CANDY_PROJECTILE_IDLE.key).getSourceImage().width === CANDY_PROJECTILE_IDLE.width &&
        scene.anims.exists('candy:orb-start') && scene.anims.exists('candy:orb-spin');
}

export function hasCandyProjectileEffect(scene: Scene): boolean {
    return hasSpriteFrames(scene, CANDY_PROJECTILE_EFFECT, CANDY_PROJECTILE_EFFECT) &&
        scene.anims.exists(CANDY_PROJECTILE_EFFECT.animationKey);
}

export function loadWeaponEffects(scene: Scene): void {
    const effect = SWORD_SLASH_EFFECT;
    scene.load.spritesheet(effect.key, effect.path, {
        frameWidth: effect.frameWidth, frameHeight: effect.frameHeight,
        startFrame: effect.start, endFrame: effect.end
    });
    const candy = CANDY_PROJECTILE_EFFECT;
    // The impact clip uses frames 5-6, but flight explicitly displays
    // frames 1-4. Phaser must load the entire six-frame texture.
    scene.load.spritesheet(candy.key, candy.path, {
        frameWidth: candy.frameWidth, frameHeight: candy.frameHeight,
        startFrame: 0, endFrame: 5
    });
    scene.load.spritesheet(CANDY_PROJECTILE_IDLE.key, CANDY_PROJECTILE_IDLE.path, {
        frameWidth: 256, frameHeight: 256, startFrame: 0, endFrame: 7
    });
}

export function hasSwordSlashEffect(scene: Scene): boolean {
    return hasSpriteFrames(scene, SWORD_SLASH_EFFECT, SWORD_SLASH_EFFECT) &&
        scene.anims.exists(SWORD_SLASH_EFFECT.animationKey);
}

export function registerWeaponEffects(scene: Scene): void {
    if (scene.textures.exists(CANDY_PROJECTILE_IDLE.key) &&
        scene.textures.get(CANDY_PROJECTILE_IDLE.key).getSourceImage().width === 2048) {
        if (!scene.anims.exists('candy:orb-start')) scene.anims.create({
            key: 'candy:orb-start',
            frames: scene.anims.generateFrameNumbers(CANDY_PROJECTILE_IDLE.key, { start: 0, end: 1 }),
            frameRate: 8, repeat: 0
        });
        if (!scene.anims.exists('candy:orb-spin')) scene.anims.create({
            key: 'candy:orb-spin',
            frames: scene.anims.generateFrameNumbers(CANDY_PROJECTILE_IDLE.key, { start: 2, end: 7 }),
            frameRate: 13, repeat: -1
        });
    }
    for (const effect of [SWORD_SLASH_EFFECT, CANDY_PROJECTILE_EFFECT]) {
        if (!hasSpriteFrames(scene, effect, effect) || scene.anims.exists(effect.animationKey)) continue;
        scene.anims.create({ key: effect.animationKey,
            frames: scene.anims.generateFrameNumbers(effect.key, { start: effect.start, end: effect.end }),
            frameRate: effect.fps, repeat: effect.repeat
        });
    }
}
