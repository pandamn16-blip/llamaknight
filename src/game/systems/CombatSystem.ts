import * as Phaser from 'phaser';
import { SHIELD } from '../characters/shield';
import { BREAD } from '../enemies/bread';
import { BALANCE } from '../config/balance';
import type { RunState, RunPhase } from '../state/RunState';
import type { Player } from '../entities/Player';
import type { EnemySystem, Enemy } from './EnemySystem';
import type { ArcherSystem, Archer } from './ArcherSystem';
import type { WorldSystem } from '../world/WorldSystem';
import type { StructureSystem, Crate } from './StructureSystem';
import { WEAPONS } from '../weapons/definitions';
import { SWORD_SLASH_EFFECT, hasSwordSlashEffect, CANDY_PROJECTILE_EFFECT, hasCandyProjectileEffect, CANDY_PROJECTILE_IDLE, hasCandyChargeOrb } from '../weapons/slashEffect';

type Projectile = { sprite: Phaser.GameObjects.Container; speed: number; remaining: number;
    damage: number; halfWidth: number; halfHeight: number; direction: -1 | 1;
    visual?: Phaser.GameObjects.Sprite; flightSeconds: number; charged?: boolean };

export class CombatSystem {
    private projectiles: Projectile[] = [];
    private chargeElapsed = 0;
    private chargeVisualStarted = false;
    private chargeHeldLast = false;
    private pendingTapUntil = -1;
    get isCharging(): boolean { return this.run.weapon.id === 'candyShot' && this.chargeHeldLast; }
    private chargeOrb?: Phaser.GameObjects.Sprite;
    private readonly chargeSeconds = 0.65;
    // Suppress charge artwork on a normal J tap; attack.png is the tap pose.
    private readonly chargeVisualDelay = 0.14;
    private timers = new Set<Phaser.Time.TimerEvent>();
    private tweens = new Set<Phaser.Tweens.Tween>();
    private slashes = new Set<Phaser.GameObjects.Container | Phaser.GameObjects.Sprite>();
    private fireTicks = new Set<Phaser.GameObjects.Text>();
    private damageTicks = new Set<Phaser.GameObjects.Text>();
    private terrain?: Pick<WorldSystem, 'terrainImpact' | 'damageAtImpact' | 'strikeTerrain'>;

    setTerrain(terrain: Pick<WorldSystem, 'terrainImpact' | 'damageAtImpact' | 'strikeTerrain'>): void { this.terrain = terrain; }

    constructor(
        private scene: Phaser.Scene, private run: RunState, private player: Player,
        private enemySystem: EnemySystem, private onKill: (x: number, y: number) => void,
        private onDeath: () => void, private onChanged: () => void, private onDamage: () => void = () => {}, private structures?: StructureSystem, private archers?: ArcherSystem
    ) {
        scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    }

    resolveEnemyAttack(enemy: Enemy): boolean {
        if (this.run.phase !== 'playing' || enemy.hp <= 0 || enemy.brain.state !== 'active' || enemy.brain.remaining <= 0) return false;
        const standingOnHead = this.enemySystem.isPlayerStandingOn(enemy, this.player.x, this.player.y);
        // Solid ledges block melee even if the centre-distance test says hit.
        if (this.terrain?.terrainImpact(enemy.sprite.x, enemy.sprite.y - 12,
            this.player.x, this.player.y)) return false;
        const dx = (this.player.x - enemy.sprite.x) * enemy.brain.facing;
        if (!standingOnHead && (dx < 0 || dx > BREAD.attackRange ||
            Math.abs(enemy.sprite.y - this.player.y) > BREAD.attackHeight)) return false;
        const sourceDirection = Math.sign(enemy.sprite.x - this.player.x) || -enemy.brain.facing;
        // An overhead Bread attack reaches a rider; horizontal shielding does
        // not block a strike coming from directly underneath.
        if (!standingOnHead && this.player.isShielding && sourceDirection === this.player.facing)
            this.blockImpact();
        else this.takeDamage(enemy.damage);
        return true;
    }

    resolvePyromancerFireContact(): void {
        if (this.run.phase !== 'playing' || !this.archers?.playerStandingOnPyromancer()) return;
        // All successful hits share the same floating-number effect.
        // Fire contact uses the ordinary player damage cooldown.
        this.takeDamage(1, true);
    }

    applyEnvironmentalDamage(amount = 1): boolean {
        return this.takeDamage(amount);
    }

    resolveArcherArrow(sourceDirection: -1 | 1): void {
        if (this.run.phase !== 'playing') return;
        if (this.player.isShielding && this.player.facing === sourceDirection) this.blockImpact();
        else this.takeDamage(1);
    }

    // Candy uses the existing J / ATK button: tap and release for a normal
    // shot, or hold for 0.65s and release for a 3x-damage charged shot.
    updateCharge(held: boolean, dt: number): boolean {
        if (this.run.phase !== 'playing' || this.run.weapon.id !== 'candyShot') return false;
        if (held && this.player.isShielding) held = false;
        const wasHeld = this.chargeHeldLast;
        this.chargeHeldLast = held;
        if (held) {
            // Do not discard presses during cooldown: that previously made
            // ordinary quick J taps do nothing on release.
            if (!wasHeld) {
                this.pendingTapUntil = -1;
                this.chargeElapsed = 0;
                this.chargeVisualStarted = false;
            }
            this.chargeElapsed += dt;
            if (!this.chargeVisualStarted && this.chargeElapsed >= this.chargeVisualDelay) {
                this.chargeVisualStarted = true;
                this.player.showCharge();
                if (hasCandyChargeOrb(this.scene)) {
                    const orb = this.scene.add.sprite(this.player.x + this.player.facing * 48,
                        this.player.y - 12, CANDY_PROJECTILE_IDLE.key, 0)
                        .setDepth(8).setScale(0.36).setFlipX(this.player.facing === -1);
                    this.chargeOrb = orb;
                    orb.play('candy:orb-start');
                    orb.once('animationcomplete', () => {
                        if (this.chargeOrb === orb && orb.active) orb.play('candy:orb-spin');
                    });
                }
            }
            if (this.chargeOrb) {
                this.chargeOrb.setPosition(this.player.x + this.player.facing * 48, this.player.y - 12);
                this.chargeOrb.setFlipX(this.player.facing === -1);
            }
            return true;
        }
        if (!wasHeld) {
            // A short tap may have been released just before cooldown expired.
            // Retry briefly rather than silently losing the input.
            if (this.pendingTapUntil >= this.run.runTime * 1000 &&
                this.run.runTime * 1000 - this.run.weapon.lastAttack >= this.run.weapon.cooldown) {
                this.pendingTapUntil = -1;
                this.attack(false);
            } else if (this.pendingTapUntil < this.run.runTime * 1000) {
                this.pendingTapUntil = -1;
            }
            return false;
        }
        const charged = this.chargeElapsed >= this.chargeSeconds;
        this.chargeElapsed = 0;
        this.chargeVisualStarted = false;
        this.player.endCharge();
        this.chargeOrb?.destroy();
        this.chargeOrb = undefined;
        // Early release fires a normal shot; a fully charged release fires
        // the strong shot. Both use the existing cooldown and swept collision.
        // A normal tap released during the final part of cooldown is
        // buffered for 180ms; a full charge still fires when ready.
        if (!charged && this.run.runTime * 1000 - this.run.weapon.lastAttack < this.run.weapon.cooldown) {
            this.pendingTapUntil = this.run.runTime * 1000 + 180;
        } else {
            this.attack(charged);
        }
        return true;
    }

    attack(charged = false) {
        if (this.run.phase !== 'playing' || this.player.isShielding) return;
        if ((this.run.runTime * 1000) - this.run.weapon.lastAttack < this.run.weapon.cooldown) return;
        this.run.weapon.lastAttack = (this.run.runTime * 1000);
        const direction = this.player.facing;
        const definition = WEAPONS[this.run.weapon.id];
        const externalEffect = definition.kind === 'melee' && hasSwordSlashEffect(this.scene);
        // Normal taps use attack.png; charged releases keep the charge pose
        // until the handoff instead of restarting the normal attack animation.
        const artworkIncludesSlash = charged ? false : this.player.showAttack();
        if (definition.kind === 'projectile') {
            // A charged spell begins exactly where the spinning orb was held,
            // so releasing J produces a continuous visual handoff.
            const sprite = this.scene.add.container(this.player.x + (charged ? 48 : 30) * direction,
                this.player.y - (charged ? 12 : 0)).setDepth(7).setScrollFactor(1);
            if (hasCandyProjectileEffect(this.scene)) {
                // The visual animates independently; the existing projectile container
                // retains its collision position, speed, hitbox, and lifetime.
                const effect = CANDY_PROJECTILE_EFFECT;
                const image = this.scene.add.sprite(0, 0, effect.key, charged ? 2 : 0)
                    .setOrigin(0.5).setScale(charged ? 0.36 : 0.3).setFlipX(direction === -1);
                sprite.add(image);
                // Frames 1-2 start the spell; frame 3 holds mid-flight, and
                // frame 4 holds after sustained travel. Frames 5-6 are impact only.
                // Keep animation independent from hit detection and world movement.
                // Projectile phases are assigned in update() from flight time.
            } else {
                sprite.add([
                    this.scene.add.rectangle(0, 0, 20, 9, 0xffffff).setAngle(-20),
                    this.scene.add.circle(0, 0, 8, 0xef73b6).setStrokeStyle(2, 0x84e9ef)
                ]);
            }
            this.projectiles.push({ sprite, speed: definition.projectileSpeed,
                remaining: this.run.weapon.range, damage: this.run.weapon.damage * (charged ? 3 : 1),
                halfWidth: definition.hitHalfWidth, halfHeight: definition.hitHalfHeight, direction,
                visual: hasCandyProjectileEffect(this.scene) ?
                    sprite.list[0] as Phaser.GameObjects.Sprite : undefined, flightSeconds: 0, charged });
            return;
        }
        const range = this.run.weapon.range;
        const halfAngle = definition.arcHalfAngle * Math.PI / 180;
        if (externalEffect) {
            this.playSlashEffect(range, direction);
        } else if (!artworkIncludesSlash) {
            const arcStart = (direction === 1 ? 0 : Math.PI) - halfAngle;
            const arcEnd = (direction === 1 ? 0 : Math.PI) + halfAngle;
            const slash = this.scene.add.container(this.player.x, this.player.y).setDepth(7).setScrollFactor(1);
            // A bright crescent follows the same forward sector used by hit detection.
            const arc = this.scene.add.graphics();
            const innerRadius = Math.max(0, range - 20);
            arc.fillStyle(0xffe49c, 0.7);
            arc.beginPath();
            arc.moveTo(Math.cos(arcStart) * range, Math.sin(arcStart) * range);
            arc.arc(0, 0, range, arcStart, arcEnd, false);
            arc.lineTo(Math.cos(arcEnd) * innerRadius, Math.sin(arcEnd) * innerRadius);
            arc.arc(0, 0, innerRadius, arcEnd, arcStart, true);
            arc.closePath();
            arc.fillPath();
            // Blade and crossguard keep the effect recognisably sword-shaped.
            slash.add([
                arc,
                this.scene.add.rectangle(direction * range * 0.45, 0, range * 0.8, 7, 0xf4faff),
                this.scene.add.rectangle(direction * 12, 0, 6, 25, 0xe8b850),
                this.scene.add.rectangle(direction * 2, 0, 15, 7, 0x76513c)
            ]);
            this.slashes.add(slash);
            const tween = this.scene.tweens.add({ targets: slash, alpha: 0, duration: BALANCE.effects.slashDuration,
                onComplete: () => { slash.destroy(); this.slashes.delete(slash); this.tweens.delete(tween); } });
            this.tweens.add(tween);
        }
        const targets = this.targets;
        for (let i = targets.length - 1; i >= 0; i--) {
            const enemy = targets[i];
            const dx = (enemy.sprite.x - this.player.x) * direction;
            const dy = enemy.sprite.y - this.player.y;
            // Resolve each enemy once at swing time; the fading arc deals no extra hits.
            if (dx >= 0 && Math.hypot(dx, dy) < range && Math.abs(Math.atan2(dy, dx)) <= halfAngle) {
                this.hitTarget(enemy, this.run.weapon.damage);
            }
        }
        if (definition.kind === 'melee') {
            const hit = this.terrain?.strikeTerrain(this.player.x, this.player.y,
                direction, range, this.run.weapon.damage);
            if (hit) this.showDamageNumber(hit.amount, hit.x, hit.y, 'crate');
        }
    }

    private playCandyImpact(shot: Projectile): void {
        if (!shot.visual || !hasCandyProjectileEffect(this.scene)) return;
        const effect = CANDY_PROJECTILE_EFFECT;
        // Impact is visual only: collision, damage and projectile removal are
        // handled once by the existing swept-hit logic.
        const impact = this.scene.add.sprite(shot.sprite.x, shot.sprite.y, effect.key, 4)
            .setDepth(7).setScrollFactor(1).setOrigin(0.5)
            .setScale(shot.charged ? 0.36 : 0.3).setFlipX(shot.direction === -1);
        this.slashes.add(impact);
        impact.once('animationcomplete', () => {
            this.slashes.delete(impact);
            impact.destroy();
        });
        impact.play(effect.animationKey);
    }

    private playSlashEffect(range: number, direction: -1 | 1): void {
        const effect = SWORD_SLASH_EFFECT;
        // Centre the effect canvas over [0, range] in the attack direction.
        // Uniform scaling preserves the artwork; only its visual footprint changes.
        const slash = this.scene.add.sprite(this.player.x + direction * range / 2,
            this.player.y, effect.key, effect.start).setDepth(7).setScrollFactor(1)
            .setOrigin(0.5, 0.5).setScale(range / effect.frameWidth).setFlipX(direction === -1);
        this.slashes.add(slash);
        slash.once('animationcomplete', () => {
            this.slashes.delete(slash);
            slash.destroy();
        });
        slash.play(effect.animationKey);
    }

    setVisualPhase(phase: RunPhase): void {
        // Pause/upgrade/focus loss releases all input; cancel rather than
        // accidentally launching a charged shot when normal play resumes.
        if (phase !== 'playing') {
            this.chargeOrb?.destroy(); this.chargeOrb = undefined;
            this.chargeHeldLast = false; this.chargeElapsed = 0;
            this.chargeVisualStarted = false;
            this.pendingTapUntil = -1;
            this.player.endCharge();
        }
        for (const slash of this.slashes) {
            if (phase === 'gameOver') {
                slash.destroy();
                this.slashes.delete(slash);
            } else if ('anims' in slash) {
                if (phase === 'playing') slash.anims.resume();
                else slash.anims.pause();
            }
        }
    }

    // Called before enemy movement, in the same update slot as the melee attack.
    update(dt: number): void {
        if (this.run.phase !== 'playing') return;
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const shot = this.projectiles[i];
            shot.flightSeconds += dt;
            if (shot.visual) {
                const t = shot.flightSeconds;
                const frame = shot.charged ? (t < 0.28 ? 2 : 3) :
                    t < 0.045 ? 0 : t < 0.10 ? 1 : t < 0.28 ? 2 : 3;
                shot.visual.setFrame(frame);
            }
            const fromX = shot.sprite.x;
            const step = Math.min(shot.remaining, shot.speed * dt);
            const toX = fromX + step * shot.direction;
            let target: Enemy | Archer | Crate | undefined;
            // Sweep the segment so a fast shot cannot skip a thin enemy between frames.
            // Hit the nearest enemy along the path, regardless of spawn array order.
            for (const enemy of this.targets) {
                if (Math.abs(enemy.sprite.y - shot.sprite.y) < shot.halfHeight &&
                    enemy.sprite.x + shot.halfWidth >= Math.min(fromX, toX) &&
                    enemy.sprite.x - shot.halfWidth <= Math.max(fromX, toX) &&
                    (!target || (enemy.sprite.x - target.sprite.x) * shot.direction < 0)) target = enemy;
            }
            // Terrain can stop candy shots too. Whichever object is contacted
            // first along this step takes the hit; no shooting through walls.
            const terrainHit = this.terrain?.terrainImpact(fromX, shot.sprite.y,
                toX, shot.sprite.y);
            const enemyFirst = target && (!terrainHit ||
                (target.sprite.x - fromX) * shot.direction <=
                    (terrainHit.x - fromX) * shot.direction);
            if (enemyFirst && target) this.hitTarget(target, shot.damage);
            else if (terrainHit) {
                const dealt = this.terrain?.damageAtImpact(terrainHit.x, terrainHit.y,
                    shot.damage) ?? 0;
                if (dealt > 0) this.showDamageNumber(dealt,
                    terrainHit.x, terrainHit.y, 'crate');
            }
            shot.sprite.x = terrainHit && !enemyFirst ? terrainHit.x : toX;
            shot.remaining -= step;
            if (enemyFirst || terrainHit || shot.remaining <= 0 ||
                shot.sprite.x > this.scene.cameras.main.scrollX + this.scene.cameras.main.width + 50 ||
                shot.sprite.x < this.scene.cameras.main.scrollX - 50) {
                if (enemyFirst || terrainHit) this.playCandyImpact(shot);
                shot.sprite.destroy();
                this.projectiles.splice(i, 1);
            }
        }
    }

    private get targets(): readonly (Enemy | Archer | Crate)[] {
        return [...this.enemySystem.enemies, ...(this.archers?.archers ?? []), ...(this.structures?.crates ?? [])];
    }

    private hitTarget(target: Enemy | Archer | Crate, damage: number): void {
        const previousHp = target.hp;
        const { x, y } = target.sprite;
        if ('placement' in target) this.structures?.damageCrate(target, damage);
        else if ('kind' in target && target.kind === 'archer') {
            this.archers?.damage(target, damage);
        } else this.hitEnemy(target as Enemy, damage);
        // Display actual health removed, including overkill and finishing blows.
        // Invulnerable/ignored targets produce no floating damage number.
        const actual = Math.max(0, previousHp - Math.max(0, target.hp));
        if (actual > 0) this.showDamageNumber(actual, x, y,
            'placement' in target ? 'crate' : 'enemy');
    }

    private hitEnemy(enemy: Enemy, damage: number): void {
        const { x, y } = enemy.sprite;
        if (this.enemySystem.damage(enemy, damage)) {
            this.run.kills++;
            this.onKill(x, y);
            this.onChanged();
        } else {
            enemy.sprite.setAlpha(0.5);
            const timer = this.scene.time.delayedCall(BALANCE.effects.enemyHitDuration, () => {
                this.timers.delete(timer);
                if (enemy.sprite.active) enemy.sprite.setAlpha(1);
            });
            this.timers.add(timer);
        }
    }

    private showDamageNumber(amount: number, x: number, y: number,
        target: 'player' | 'enemy' | 'crate', fire = false): void {
        if (amount <= 0) return;
        const tick = this.scene.add.text(x, y - (target === 'player' ? 52 : 44),
            `-${amount}`, {
                fontSize: '25px',
                color: target === 'player' ? '#ff3030' : target === 'enemy' ? '#ffe28a' : '#ffffff',
                fontStyle: 'bold',
                stroke: target === 'player' ? '#530808' : '#42301a',
                strokeThickness: 4
            }).setOrigin(0.5).setDepth(12).setScrollFactor(1);
        this.damageTicks.add(tick);
        if (fire) this.fireTicks.add(tick);
        const tween = this.scene.tweens.add({
            targets: tick, y: tick.y - 30, alpha: 0, duration: 650,
            onComplete: () => {
                tick.destroy();
                this.damageTicks.delete(tick);
                this.fireTicks.delete(tick);
                this.tweens.delete(tween);
            }
        });
        this.tweens.add(tween);
    }

    private blockImpact(): void {
        const effect = this.scene.add.container(this.player.x + this.player.facing * 38, this.player.y).setDepth(9).setScrollFactor(1);
        effect.add([
            this.scene.add.rectangle(0, 0, 5, 30, 0xfff6bd),
            this.scene.add.rectangle(0, 0, 30, 5, 0xfff6bd).setAngle(25),
            this.scene.add.rectangle(0, 0, 30, 5, 0xfff6bd).setAngle(-25)
        ]);
        this.slashes.add(effect);
        const tween = this.scene.tweens.add({ targets: effect, alpha: 0, duration: SHIELD.impactMs,
            onComplete: () => { effect.destroy(); this.slashes.delete(effect); this.tweens.delete(tween); } });
        this.tweens.add(tween);
    }

    private takeDamage(amount = 1, fire = false): boolean {
        if (this.run.phase !== 'playing') return false;
        if ((this.run.runTime * 1000) - this.run.lastDamage < BALANCE.player.damageCooldown) return false;
        this.run.lastDamage = (this.run.runTime * 1000);
        const actual = Math.min(amount, Math.max(0, this.run.health));
        this.run.health -= amount;
        this.showDamageNumber(actual, this.player.x, this.player.y, 'player', fire);
        this.player.showHurt();
        this.onDamage();
        this.scene.cameras.main.shake(BALANCE.effects.shakeDuration, BALANCE.effects.shakeIntensity);
        const tween = this.scene.tweens.add({ targets: this.player.sprite, alpha: 0.35, duration: BALANCE.effects.damageFlashDuration, yoyo: true, repeat: BALANCE.effects.damageFlashRepeats,
            onComplete: () => { this.player.sprite.setAlpha(1); this.tweens.delete(tween); } });
        this.tweens.add(tween);
        if (this.run.health <= 0) this.onDeath();
        this.onChanged();
        return true;
    }

    destroy(): void {
        this.chargeOrb?.destroy();
        this.chargeOrb = undefined;
        this.chargeHeldLast = false;
        this.chargeElapsed = 0;
        this.chargeVisualStarted = false;
        this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
        for (const timer of this.timers) timer.remove(false);
        for (const tween of this.tweens) tween.remove();
        for (const slash of this.slashes) if (slash.active) slash.destroy();
        for (const tick of this.damageTicks) if (tick.active) tick.destroy();
        this.damageTicks.clear();
        this.fireTicks.clear();
        for (const shot of this.projectiles) if (shot.sprite.active) shot.sprite.destroy();
        this.projectiles = [];
        this.timers.clear();
        this.tweens.clear();
        this.slashes.clear();
    }
}
