import type { Scene, GameObjects } from 'phaser';
import { CHARACTER_SHIELDS, hasShieldSheet } from '../characters/shield';
import type { CharacterVisual } from '../characters/definitions';
import { CHARACTER_SPRITES, hasCharacterSheet, hasCandyLevelUp, hasCandyCharge, resolveCharacterAnimation } from '../characters/spriteAnimations';
import type { PlayerAnimation, CharacterSpriteSheet } from '../characters/spriteAnimations';
import type { RunState, RunPhase } from '../state/RunState';

// Rendering is selected from data; movement below is shared by both characters.
function createPlaceholderVisual(scene: Scene, x: number, y: number, visual: CharacterVisual): GameObjects.Container {
    const sprite = scene.add.container(x, y).setDepth(6);
    if (visual === 'candy') {
        sprite.add([
            scene.add.ellipse(0, 5, 58, 62, 0xef73b6),
            scene.add.circle(0, -28, 23, 0xffdfca),
            scene.add.ellipse(0, -44, 53, 23, 0x6d3b91),
            scene.add.circle(-26, -32, 13, 0xa55bc4),
            scene.add.circle(26, -32, 13, 0xa55bc4),
            scene.add.circle(-8, -28, 3, 0x30213a),
            scene.add.circle(8, -28, 3, 0x30213a),
            scene.add.rectangle(-14, 35, 15, 12, 0x6d3b91),
            scene.add.rectangle(14, 35, 15, 12, 0x6d3b91),
            scene.add.rectangle(29, 0, 7, 32, 0xffffff),
            scene.add.circle(29, -20, 13, 0x84e9ef)
        ]);
        return sprite;
    }
    sprite.add([
        scene.add.ellipse(-14, -49, 13, 31, 0xe8c98f),
        scene.add.ellipse(13, -49, 13, 31, 0xe8c98f),
        scene.add.ellipse(0, 0, 65, 75, 0xe8c98f),
        scene.add.circle(0, -23, 24, 0xf1d9ae),
        scene.add.ellipse(0, -20, 20, 16, 0x9d704f),
        scene.add.circle(-24, 12, 19, 0x76513c),
        scene.add.circle(-24, 12, 6, 0xc1c1c1)
    ]);
    return sprite;
}

function buildVisual(scene: Scene, x: number, y: number, visual: CharacterVisual) {
    const sheet = CHARACTER_SPRITES[visual];
    if (!sheet || !hasCharacterSheet(scene, sheet)) {
        return { container: createPlaceholderVisual(scene, x, y, visual) };
    }
    const idle = resolveCharacterAnimation(scene, sheet, 'idle')!;
    const container = scene.add.container(x, y).setDepth(6);
    const animated = scene.add.sprite(sheet.offsetX, sheet.offsetY, idle.source.key, idle.clip.start)
        .setOrigin(sheet.originX, sheet.originY).setScale(sheet.scale);
    container.add(animated);
    return { container, animated, sheet };
}

// Selection previews use the same visual/anchor with a static idle frame.
export function createPlayerVisual(scene: Scene, x: number, y: number, visual: CharacterVisual): GameObjects.Container {
    return buildVisual(scene, x, y, visual).container;
}

export class PlayerVisual {
    readonly container: GameObjects.Container;
    private shield?: GameObjects.Sprite;
    private defending = false;
    private animated?: GameObjects.Sprite;
    private sheet?: CharacterSpriteSheet;
    private state?: PlayerAnimation;
    private action?: 'attack' | 'hurt' | 'death' | 'levelup' | 'charge';
    private wasAirborne = false;
    private landingSeconds = 0;
    private readonly landingDuration = 0.14;
    private idleElapsed = 0;
    private blinkRemaining = 0;
    private nextBlinkAfter = 4.2;
    private blinkCount = 0;
    private placeholderParts: { object: GameObjects.Shape; x: number; scaleX: number }[] = [];

    constructor(private scene: Scene, x: number, y: number, visual: CharacterVisual) {
        const result = buildVisual(scene, x, y, visual);
        this.container = result.container;
        this.animated = result.animated;
        this.sheet = result.sheet;
        if (!this.animated) this.placeholderParts = this.container.list.map(child => {
            const object = child as GameObjects.Shape;
            return { object, x: object.x, scaleX: object.scaleX };
        });
        const shield = CHARACTER_SHIELDS[visual];
        if (shield && hasShieldSheet(scene, visual)) {
            this.shield = scene.add.sprite(shield.offsetX, shield.offsetY, shield.key, 0)
                .setOrigin(shield.originX, shield.originY).setScale(shield.scale).setVisible(false);
            this.container.add(this.shield);
        }
        this.play('idle');
    }

    setDefending(held: boolean): void {
        if (held && (this.action === 'death' || (this.action === 'hurt' && this.animated?.anims.isPlaying))) return;
        if (this.defending === held) return;
        this.defending = held;
        this.shield?.setVisible(held);
        this.animated?.setVisible(!held || !this.shield);
        for (const part of this.placeholderParts) part.object.setVisible(!held || !this.shield);
        if (held) {
            this.action = undefined;
            if (this.shield) { this.shield.play(this.shield.texture.key, true); this.animated?.anims.pause(); }
        } else {
            this.shield?.anims.pause(); this.animated?.anims.resume(); this.state = undefined;
        }
    }

    setFacing(direction: -1 | 1): void {
        this.shield?.setFlipX(direction === -1);
        if (this.animated) {
            // Phaser mirrors the frame in place. Its origin, offsets and foot pivot stay fixed.
            this.animated.setFlipX(direction === -1);
        } else {
            // Candy and missing-sheet fallbacks are shapes, which have no Flip component.
            // Mirror only those visual children around their original local coordinates.
            for (const part of this.placeholderParts) {
                part.object.x = part.x * direction;
                part.object.scaleX = part.scaleX * direction;
            }
        }
    }

    update(run: RunState, moving: boolean, dt = 0): void {
        if (!this.animated || this.action === 'death' || (this.defending && this.shield)) return;
        // Physics drives vertical movement. Candy's jump strip only supplies poses:
        // frames 1-4 ascend (hold 4), 5 is descending, 6 is a brief landing pose.
        const candy = this.sheet?.key === 'candy';
        const airborne = !run.onGround;
        const justLanded = candy && this.wasAirborne && !airborne;
        this.wasAirborne = airborne;
        if (justLanded) this.landingSeconds = this.landingDuration;
        if (this.action === 'charge' || (this.action && this.animated.anims.isPlaying)) return;
        this.action = undefined;
        // Keep the current visual size until its replacement frame is installed.
        // Resetting scale here caused a one-frame shrink of the *attack art*
        // when the casting animation finished while Candy was falling.
        // If the attack finished after the physics landing event, show the
        // queued landing pose instead of keeping the last casting frame.
        if (candy && !airborne && this.landingSeconds > 0 &&
            (justLanded || this.state !== undefined)) {
            this.animated.anims.stop();
            this.animated.setTexture('candy-jump', 5);
            this.setVisualScale('fall');
            this.state = undefined;
            return;
        }
        if (candy && this.landingSeconds > 0 && !airborne) {
            this.landingSeconds = Math.max(0, this.landingSeconds - dt);
            if (this.landingSeconds > 0) return;
        }
        if (airborne) this.landingSeconds = 0;
        const state = airborne ? (run.velocityY < 0 ? 'jump' : 'fall') : moving ? 'run' : 'idle';
        if (candy && state !== 'idle') this.resetIdleBlink();
        this.play(state);
        if (candy && state === 'idle') this.advanceIdleBlink(dt);
    }

    showAction(action: 'attack' | 'hurt' | 'death'): boolean {
        if (!this.animated || this.action === 'death') return false;
        if (action === 'attack' && this.action === 'hurt' && this.animated.anims.isPlaying) return false;
        this.setDefending(false);
        if (this.sheet?.key === 'candy') this.resetIdleBlink();
        this.action = action;
        // Scale is switched by play(), together with the new texture/frame.
        // Never shrink a still-visible casting pose during airborne transitions.
        return this.play(action, true);
    }

    showCharge(): void {
        if (!this.animated || this.sheet?.key !== 'candy' ||
            !hasCandyCharge(this.scene) || this.action === 'death') return;
        this.resetIdleBlink();
        this.action = 'charge';
        this.state = undefined;
        this.animated.play('candy:charge', true);
        // Charge artwork is slightly larger than Candy's attack artwork at
        // the same scale. Use a calibrated 0.60 charge scale (vs 0.64 attack)
        // without changing the physics container or collision bounds.
        this.animated.setScale(this.sheet.scale * 1.20);
    }

    endCharge(): void {
        if (this.action !== 'charge') return;
        this.action = undefined;
        this.state = undefined;
        // Switching back to the right movement/attack pose happens on update()
        // or showAction(), without altering the player's world position.
    }

    showLevelUp(): void {
        if (!this.animated || this.sheet?.key !== 'candy' ||
            !hasCandyLevelUp(this.scene) || this.action === 'death') return;
        this.setDefending(false);
        this.action = 'levelup';
        this.state = undefined;
        this.animated.play('candy:levelup', true);
        this.setVisualScale('idle');
    }

    get attackIncludesWeaponEffect(): boolean {
        return !!this.animated && !!this.sheet &&
            resolveCharacterAnimation(this.scene, this.sheet, 'attack')?.clip.includesWeaponEffect === true;
    }

    setPhase(phase: RunPhase): void {
        const frozen = phase === 'paused' || phase === 'choosingUpgrade';
        if (frozen) { this.animated?.anims.pause(); this.shield?.anims.pause(); }
        else {
            if (!this.defending || !this.shield) this.animated?.anims.resume();
            if (this.defending) this.shield?.anims.resume();
        }
    }

    // The ordinary idle loop deliberately skips the blink pose (index 2).
    // Display it for a short beat every few seconds, and only while idle.
    private advanceIdleBlink(dt: number): void {
        if (!this.animated || dt <= 0) return;
        if (this.blinkRemaining > 0) {
            this.blinkRemaining = Math.max(0, this.blinkRemaining - dt);
            if (this.blinkRemaining === 0) {
                this.animated.anims.resume();
                this.animated.setFrame(0);
            }
            return;
        }
        this.idleElapsed += dt;
        if (this.idleElapsed < this.nextBlinkAfter) return;
        this.animated.anims.pause();
        this.animated.setFrame(2);
        this.blinkRemaining = 0.12;
        this.idleElapsed = 0;
        this.blinkCount++;
        this.nextBlinkAfter = this.blinkCount % 2 ? 5.2 : 3.8;
    }

    private resetIdleBlink(): void {
        this.idleElapsed = 0;
        if (this.blinkRemaining > 0) this.animated?.anims.resume();
        this.blinkRemaining = 0;
    }

    private setVisualScale(state: PlayerAnimation): void {
        if (!this.animated || this.sheet?.key !== 'candy') return;
        // Keep the full-size casting artwork through the entire attack.
        // Only change scale after a different animation has been installed.
        this.animated.setScale(this.sheet.scale * (state === 'attack' ? 1.28 : 1));
    }

    private play(state: PlayerAnimation, restart = false): boolean {
        if (!this.animated || !this.sheet) return false;
        const key = `${this.sheet.key}:${state}`;
        if (!this.scene.anims.exists(key)) return false;
        if (restart || this.state !== state) {
            this.animated.play(key, !restart);
            this.setVisualScale(state);
            this.state = state;
        }
        return true;
    }
}
