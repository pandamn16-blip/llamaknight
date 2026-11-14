import { Scenes } from 'phaser';
import type { Scene, GameObjects, Time } from 'phaser';
import { WORLD } from '../config/world';
import { BALANCE } from '../config/balance';
import { ARCHER } from '../config/archers';
import {
    hasPyromancerIdle, hasPyromancerRun, hasPyromancerAttack, hasPyromancerBonk,
    hasPyromancerDeath, hasPyromancerFireball, PYROMANCER_IDLE, PYROMANCER_RUN,
    PYROMANCER_ATTACK, PYROMANCER_BONK, PYROMANCER_DEATH, PYROMANCER_FIREBALL
} from '../enemies/pyromancer';
import type { RunPhase } from '../state/RunState';
import { generateSection, sectionWindow } from '../world/sections';
import type { RunState } from '../state/RunState';
import type { Player } from '../entities/Player';
import type { WorldSystem } from '../world/WorldSystem';

export type Archer = {
    kind: 'archer';
    id: string;
    sprite: GameObjects.Container;
    hp: number;
    maxHealth: number;
    state: 'watch' | 'aim' | 'reload';
    timer: number;
    facing: -1 | 1;
    warning: GameObjects.Text;
    art?: GameObjects.Sprite;
    homeX: number;
    minX: number;
    maxX: number;
    patrolDirection: -1 | 1;
    animation?: 'idle' | 'run' | 'attack' | 'bonk' | 'death';
    attackKind?: 'attack' | 'bonk';
};
type ArcherRecord = { hp: number; dead: boolean; x?: number; patrolDirection?: -1 | 1 };
type Arrow = { sprite: GameObjects.Container | GameObjects.Sprite; vx: number; vy: number;
    distance: number; impactRemaining?: number };
type Dying = { sprite: GameObjects.Container; elapsed: number };

// Pyromancers patrol their own raised ledges without changing Bread's ground AI.
// Platform bounds and body collision are gameplay geometry, not artwork dimensions.
export class ArcherSystem {
    private active = new Map<string, Archer>();
    private records = new Map<string, ArcherRecord>();
    private arrows: Arrow[] = [];
    private dying: Dying[] = [];
    private hitFlashTimers = new Map<string, Time.TimerEvent>();
    private terrain?: Pick<WorldSystem, 'terrainImpact' | 'projectileImpact' | 'enemyHeadExposed'>;
    private immobilized: (id: string) => boolean = () => false;
    setImmobilized(check: (id: string) => boolean): void { this.immobilized = check; }


    setTerrain(terrain: Pick<WorldSystem, 'terrainImpact' | 'projectileImpact' | 'enemyHeadExposed'>): void {
        this.terrain = terrain;
    }

    constructor(private scene: Scene, private run: RunState,
        private groundY: number, private player: Pick<Player, 'x' | 'y'>,
        private onArrowHit: (sourceDirection: -1 | 1) => void, private onKilled: (x: number, y: number) => void) {
        scene.events.once(Scenes.Events.SHUTDOWN, this.destroy, this);
    }

    get archers(): readonly Archer[] { return [...this.active.values()]; }

    private topY(archer: Archer): number { return archer.sprite.y - ARCHER.standHeight; }

    isPlayerStandingOn(archer: Archer, playerX: number, playerY: number): boolean {
        return archer.hp > 0 && archer.sprite.active &&
            (!this.terrain || this.terrain.enemyHeadExposed(archer.sprite.x, archer.sprite.y)) &&
            Math.abs(playerX - archer.sprite.x) <= ARCHER.standHalfWidth &&
            Math.abs(playerY + BALANCE.player.groundOffset - this.topY(archer)) < 3;
    }

    playerStandingOnPyromancer(): boolean {
        return this.archers.some(archer =>
            this.isPlayerStandingOn(archer, this.player.x, this.player.y));
    }

    landingY(x: number, previousFoot: number, nextFoot: number): number | undefined {
        if (nextFoot < previousFoot) return undefined;
        let landing: number | undefined;
        for (const archer of this.active.values()) {
            if (archer.hp <= 0 || !archer.sprite.active ||
                (this.terrain && !this.terrain.enemyHeadExposed(archer.sprite.x, archer.sprite.y)) ||
                Math.abs(x - archer.sprite.x) > ARCHER.standHalfWidth) continue;
            const top = this.topY(archer);
            if (previousFoot <= top + 1 && nextFoot >= top &&
                (landing === undefined || top < landing)) landing = top;
        }
        return landing;
    }

    standingY(x: number, foot: number): number | undefined {
        for (const archer of this.active.values()) {
            if (archer.hp <= 0 || !archer.sprite.active ||
                (this.terrain && !this.terrain.enemyHeadExposed(archer.sprite.x, archer.sprite.y)) ||
                Math.abs(x - archer.sprite.x) > ARCHER.standHalfWidth) continue;
            const top = this.topY(archer);
            if (Math.abs(foot - top) < 3) return top;
        }
        return undefined;
    }

    // Same swept body-blocking as Bread, limited to overlapping heights.
    resolvePlayerMovement(from: number, to: number, y: number): number {
        for (const archer of this.active.values()) {
            if (archer.hp <= 0 || !archer.sprite.active ||
                Math.abs(y - archer.sprite.y) >= BALANCE.player.contactHeight) continue;
            const x = archer.sprite.x;
            // Stop at the near surface, including when already partially
            // overlapping. Never prevent a player moving away from an enemy.
            if (to > from && from < x && to > x - ARCHER.contactWidth)
                to = Math.min(to, Math.max(from, x - ARCHER.contactWidth));
            else if (to < from && from > x && to < x + ARCHER.contactWidth)
                to = Math.max(to, Math.min(from, x + ARCHER.contactWidth));
        }
        return to;
    }

    private walk(archer: Archer, target: number, speed: number, dt: number): boolean {
        // Prevent patrolling out from under a player standing on the flames.
        if (this.isPlayerStandingOn(archer, this.player.x, this.player.y)) return false;
        const from = archer.sprite.x;
        const clampedTarget = Math.max(archer.minX, Math.min(archer.maxX, target));
        let to = from + Math.sign(clampedTarget - from) * Math.min(Math.abs(clampedTarget - from), speed * dt);
        if (this.player && Math.abs(this.player.y - archer.sprite.y) < BALANCE.player.contactHeight) {
            if (to > from && from < this.player.x &&
                to > this.player.x - ARCHER.contactWidth)
                to = Math.min(to, Math.max(from, this.player.x - ARCHER.contactWidth));
            else if (to < from && from > this.player.x &&
                to < this.player.x + ARCHER.contactWidth)
                to = Math.max(to, Math.min(from, this.player.x + ARCHER.contactWidth));
        }
        if (to !== from) archer.facing = to < from ? -1 : 1;
        archer.sprite.x = to;
        const record = this.records.get(archer.id);
        if (record) record.x = to;
        return Math.abs(to - clampedTarget) < 0.01;
    }

    private play(archer: Archer, name: 'idle' | 'run' | 'attack' | 'bonk' | 'death'): void {
        if (!archer.art || archer.animation === name) return;
        const sheet = name === 'run' ? PYROMANCER_RUN :
            name === 'attack' ? PYROMANCER_ATTACK : name === 'bonk' ? PYROMANCER_BONK :
            name === 'death' ? PYROMANCER_DEATH : PYROMANCER_IDLE;
        const available = name === 'run' ? hasPyromancerRun(this.scene) :
            name === 'attack' ? hasPyromancerAttack(this.scene) :
            name === 'bonk' ? hasPyromancerBonk(this.scene) :
            name === 'death' ? hasPyromancerDeath(this.scene) : hasPyromancerIdle(this.scene);
        if (!available) return;
        archer.animation = name;
        // These are visual-only transforms: collision and foot anchor stay fixed.
        // attack.png's character was authored smaller inside the frame than idle.png.
        archer.art.setScale(sheet.scale);
        archer.art.play(sheet.animationKey);
    }

    private animate(archer: Archer, moving: boolean): void {
        if (!archer.art) return;
        // Never replace a telegraphed attack with idle before its strike moment.
        if (archer.state === 'aim') this.play(archer, archer.attackKind ?? 'attack');
        else this.play(archer, moving ? 'run' : 'idle');
        archer.art.setFlipX(archer.facing === -1);
    }

    prepare(): void {
        const camera = this.scene.cameras.main;
        const retain = camera.width * WORLD.cleanupViewports;
        for (const [id, archer] of this.active) {
            if (archer.sprite.x < camera.scrollX - retain || archer.sprite.x > camera.scrollX + camera.width + retain) {
                const record = this.records.get(id);
                if (record) { record.x = archer.sprite.x; record.patrolDirection = archer.patrolDirection; }
                this.hitFlashTimers.get(id)?.remove(false);
                this.hitFlashTimers.delete(id);
                archer.sprite.destroy(); this.active.delete(id);
            }
        }
        const win = sectionWindow(camera.scrollX, camera.width, WORLD.preparationViewports);
        for (let index = win.first; index <= win.last; index++) {
            // One archer every other section, never on the introductory section.
            if (index === 0 || index % 2 === 0) continue;
            const perch = generateSection(index, this.run.seed).platforms[3];
            const id = `${perch.id}:archer`;
            const record = this.records.get(id) ?? { hp: ARCHER.hp, dead: false };
            if (record.dead || this.active.has(id) ||
                perch.x < camera.scrollX - retain || perch.x > camera.scrollX + camera.width + retain) continue;
            this.records.set(id, record);
            const minX = perch.x - perch.width / 2 + ARCHER.ledgeInset;
            const maxX = perch.x + perch.width / 2 - ARCHER.ledgeInset;
            const spawnX = Math.max(minX, Math.min(maxX, record.x ?? perch.x));
            const sprite = this.scene.add.container(spawnX, this.groundY - perch.height - ARCHER.footOffset)
                .setDepth(6).setScrollFactor(1);
            // The approved pancake pyromancer is the Archer's temporary visual skin.
            // Collision, attack timing and projectile behaviour stay unchanged.
            let art: GameObjects.Sprite | undefined;
            if (hasPyromancerIdle(this.scene)) {
                art = this.scene.add.sprite(0, ARCHER.footOffset,
                    PYROMANCER_IDLE.key, PYROMANCER_IDLE.start)
                    .setOrigin(PYROMANCER_IDLE.originX, PYROMANCER_IDLE.originY)
                    .setScale(PYROMANCER_IDLE.scale);
                sprite.add(art);
                art.play(PYROMANCER_IDLE.animationKey);
            } else {
                sprite.add([
                    this.scene.add.ellipse(0, 0, 54, 58, 0xc98d50).setStrokeStyle(3, 0x5e3d27),
                    this.scene.add.rectangle(0, -24, 53, 13, 0x66855b),
                    this.scene.add.circle(-10, -5, 3, 0x33271f),
                    this.scene.add.circle(10, -5, 3, 0x33271f),
                    this.scene.add.rectangle(30, 0, 4, 42, 0x78512d)
                ]);
            }
            const warning = this.scene.add.text(0, -55, '!', {
                fontSize: '26px', color: '#ffe4a0', backgroundColor: '#a54f33'
            }).setOrigin(0.5).setVisible(false);
            sprite.add(warning);
            this.active.set(id, { kind: 'archer', id, sprite, hp: record.hp, maxHealth: ARCHER.hp,
                state: 'watch', timer: 0, facing: -1, warning, art,
                homeX: perch.x, minX, maxX, patrolDirection: record.patrolDirection ?? 1,
                animation: art ? 'idle' : undefined });
        }
    }

    damage(archer: Archer, amount: number): boolean {
        if (this.run.phase !== 'playing' || this.active.get(archer.id) !== archer) return false;
        const record = this.records.get(archer.id)!;
        record.hp = archer.hp = Math.max(0, archer.hp - amount);
        // Match Bread's non-lethal damage feedback. Restart on repeated hits
        // so an earlier timeout cannot end the flash prematurely.
        this.hitFlashTimers.get(archer.id)?.remove(false);
        this.hitFlashTimers.delete(archer.id);
        if (archer.hp > 0) {
            archer.sprite.setAlpha(0.5);
            const timer = this.scene.time.delayedCall(BALANCE.effects.enemyHitDuration, () => {
                if (this.hitFlashTimers.get(archer.id) !== timer) return;
                this.hitFlashTimers.delete(archer.id);
                if (archer.sprite.active) archer.sprite.setAlpha(1);
            });
            this.hitFlashTimers.set(archer.id, timer);
            return false;
        }
        archer.sprite.setAlpha(1);
        record.dead = true;
        this.active.delete(archer.id);
        const { x, y } = archer.sprite;
        archer.warning.setVisible(false);
        if (archer.art && hasPyromancerDeath(this.scene)) {
            this.play(archer, 'death');
            this.dying.push({ sprite: archer.sprite, elapsed: 0 });
        } else archer.sprite.destroy();
        this.onKilled(x, y);
        return true;
    }

    private shoot(archer: Archer): void {
        const launchX = archer.sprite.x + archer.facing * ARCHER.fireballSpawnX;
        const launchY = archer.sprite.y + ARCHER.fireballSpawnY;
        const dx = this.player.x - launchX;
        const dy = this.player.y - launchY;
        const length = Math.hypot(dx, dy) || 1;
        const vx = dx / length * ARCHER.projectileSpeed;
        const vy = dy / length * ARCHER.projectileSpeed;
        let sprite: GameObjects.Sprite | GameObjects.Container;
        if (hasPyromancerFireball(this.scene)) {
            const fireball = this.scene.add.sprite(launchX, launchY,
                PYROMANCER_FIREBALL.key, PYROMANCER_FIREBALL.start)
                .setOrigin(0.5, 0.5).setScale(ARCHER.fireballScale)
                .setFlipX(archer.facing === -1).setDepth(7).setScrollFactor(1);
            // Plays only early flight frames once, then Phaser holds the last flight frame
            // until the actual swept collision or range cleanup. No looping/vanishing.
            fireball.play(PYROMANCER_FIREBALL.animationKey);
            sprite = fireball;
        } else {
            const placeholder = this.scene.add.container(launchX, launchY).setDepth(7).setScrollFactor(1);
            placeholder.add([
                this.scene.add.circle(0, 0, 17, 0xff8c22).setStrokeStyle(3, 0xe04616),
                this.scene.add.circle(5, 0, 10, 0xffe88d)
            ]);
            sprite = placeholder;
        }
        this.arrows.push({ sprite, vx, vy, distance: 0 });
    }

    update(dt: number): void {
        if (this.run.phase !== 'playing') return;
        this.prepare();
        for (let i = this.dying.length - 1; i >= 0; i--) {
            const death = this.dying[i];
            death.elapsed += dt;
            if (death.elapsed >= ARCHER.deathDuration) {
                death.sprite.destroy();
                this.dying.splice(i, 1);
            }
        }
        const camera = this.scene.cameras.main;
        for (const archer of this.active.values()) {
            const dx = this.player.x - archer.sprite.x;
            const visible = archer.sprite.x >= camera.scrollX - ARCHER.activationMargin &&
                archer.sprite.x <= camera.scrollX + camera.width + ARCHER.activationMargin;
            archer.sprite.setVisible(visible);
            if (!visible) { archer.art?.anims.pause(); continue; }
            archer.art?.anims.resume();
            if (this.immobilized(archer.id)) {
                archer.warning.setVisible(false);
                archer.state = 'watch';
                this.play(archer, 'idle');
                continue;
            }
            const beforeX = archer.sprite.x;
            const onSameLevel = Math.abs(this.player.y - archer.sprite.y) < ARCHER.detectionHeight;
            const inRange = Math.abs(dx) < ARCHER.detectionRange &&
                onSameLevel;
            if (archer.state === 'watch') {
                if (inRange) {
                    // Fire from anywhere within detection range. Otherwise a
                    // platform-bound Pyromancer can get stuck chasing its
                    // preferred distance at the ledge edge and never shoot.
                    archer.state = 'aim';
                    archer.attackKind = Math.abs(dx) < ARCHER.contactRange &&
                        Math.abs(this.player.y - archer.sprite.y) < ARCHER.contactHeight ? 'bonk' : 'attack';
                    archer.timer = archer.attackKind === 'bonk' ?
                        ARCHER.contactWindup : ARCHER.aimDuration;
                    archer.facing = dx < 0 ? -1 : 1;
                    archer.warning.setVisible(true);
                } else {
                    const edge = archer.patrolDirection === 1 ? archer.maxX : archer.minX;
                    if (this.walk(archer, edge, ARCHER.patrolSpeed, dt)) {
                        archer.patrolDirection = archer.patrolDirection === 1 ? -1 : 1;
                        const record = this.records.get(archer.id);
                        if (record) record.patrolDirection = archer.patrolDirection;
                    }
                }
            } else if (archer.state === 'aim') {
                if (!inRange) { archer.state = 'watch'; archer.warning.setVisible(false); }
                else if ((archer.timer -= dt) <= 0) {
                    const close = Math.abs(this.player.x - archer.sprite.x) <= ARCHER.contactRange &&
                        Math.abs(this.player.y - archer.sprite.y) <= ARCHER.contactHeight;
                    if (archer.attackKind === 'bonk') {
                        // An escaped bonk misses; solid terrain also prevents a
                        // strike from travelling through an overhead ledge.
                        const shieldedByTerrain = this.terrain?.terrainImpact(
                            archer.sprite.x, archer.sprite.y - 20, this.player.x, this.player.y);
                        if (close && !shieldedByTerrain)
                            this.onArrowHit(archer.sprite.x >= this.player.x ? 1 : -1);
                    } else this.shoot(archer);
                    archer.state = 'reload';
                    archer.timer = ARCHER.reloadDuration;
                    archer.warning.setVisible(false);
                }
            } else {
                if ((archer.timer -= dt) <= 0) archer.state = 'watch';
                else if (inRange && Math.abs(dx) > ARCHER.preferredRange + ARCHER.contactWidth) {
                    this.walk(archer, this.player.x - Math.sign(dx) * ARCHER.preferredRange,
                        ARCHER.chaseSpeed, dt);
                }
            }
            // Preserve the non-looping attack follow-through until it reaches frame 6.
            if (archer.state !== 'reload' || !archer.art?.anims.isPlaying)
                this.animate(archer, Math.abs(archer.sprite.x - beforeX) > 0.01);
            else archer.art?.setFlipX(archer.facing === -1);
        }
        for (let i = this.arrows.length - 1; i >= 0; i--) {
            const arrow = this.arrows[i], { sprite } = arrow;
            if (arrow.impactRemaining !== undefined) {
                // A real impact already dealt its damage exactly once. Let impact frame 5
                // flash briefly on the hit location; never move or damage again.
                arrow.impactRemaining -= dt;
                if (arrow.impactRemaining <= 0) {
                    sprite.destroy();
                    this.arrows.splice(i, 1);
                }
                continue;
            }
            const fromX = sprite.x, fromY = sprite.y;
            const distance = Math.hypot(arrow.vx, arrow.vy) * dt;
            const toX = fromX + arrow.vx * dt, toY = fromY + arrow.vy * dt;
            // Swept point-to-segment distance avoids fast projectiles tunnelling.
            const vx = toX - fromX, vy = toY - fromY;
            const t = Math.max(0, Math.min(1, ((this.player.x - fromX) * vx +
                (this.player.y - fromY) * vy) / (vx * vx + vy * vy || 1)));
            const playerHit = Math.hypot(fromX + vx * t - this.player.x,
                fromY + vy * t - this.player.y) < ARCHER.arrowHitRadius;
            const terrainHit = this.terrain?.projectileImpact(fromX, fromY, toX, toY);
            // First collision in the swept segment wins. A ledge absorbs a
            // fireball before it can damage someone standing behind it.
            const hitsTerrain = !!terrainHit && (!playerHit || terrainHit.t <= t);
            const hitPlayer = playerHit && !hitsTerrain;
            arrow.distance += distance;
            if (hitPlayer || hitsTerrain) {
                const contactT = hitsTerrain ? terrainHit!.t : t;
                sprite.x = fromX + vx * contactT;
                sprite.y = fromY + vy * contactT;
                if ('setFrame' in sprite && hasPyromancerFireball(this.scene)) {
                    sprite.anims.stop();
                    sprite.setFrame(PYROMANCER_FIREBALL.impactFrame);
                    arrow.impactRemaining = 0.13;
                } else {
                    sprite.destroy();
                    this.arrows.splice(i, 1);
                }
                if (hitPlayer) this.onArrowHit(arrow.vx >= 0 ? -1 : 1);
            } else {
                sprite.x = toX; sprite.y = toY;
                if (arrow.distance >= ARCHER.projectileRange ||
                    sprite.x < camera.scrollX - 100 || sprite.x > camera.scrollX + camera.width + 100) {
                    sprite.destroy();
                    this.arrows.splice(i, 1);
                }
            }
            if (this.run.phase !== 'playing') break;
        }
    }

    setPhase(phase: RunPhase): void {
        for (const archer of this.active.values()) {
            if (phase === 'playing') archer.art?.anims.resume();
            else archer.art?.anims.pause();
        }
        for (const death of this.dying) {
            const art = death.sprite.list.find(obj => 'anims' in obj) as GameObjects.Sprite | undefined;
            if (phase === 'playing') art?.anims.resume();
            else art?.anims.pause();
        }
        for (const arrow of this.arrows) {
            if ('anims' in arrow.sprite) {
                if (phase === 'playing') arrow.sprite.anims.resume();
                else arrow.sprite.anims.pause();
            }
        }
    }

    destroy(): void {
        this.scene.events.off(Scenes.Events.SHUTDOWN, this.destroy, this);
        for (const timer of this.hitFlashTimers.values()) timer.remove(false);
        this.hitFlashTimers.clear();
        for (const archer of this.active.values()) archer.sprite.destroy();
        for (const arrow of this.arrows) arrow.sprite.destroy();
        for (const death of this.dying) death.sprite.destroy();
        this.active.clear(); this.records.clear(); this.arrows = []; this.dying = [];
    }
}
