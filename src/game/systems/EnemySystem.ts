import * as Phaser from 'phaser';
import { difficultyRegion } from '../world/difficulty';
import { WORLD } from '../config/world';
import { BALANCE } from '../config/balance';
import type { Player } from '../entities/Player';
import { BREAD, hasBreadAnimations } from '../enemies/bread';
import type { WorldSystem } from '../world/WorldSystem';
import type { BreadAnimation } from '../enemies/bread';
import type { RunPhase } from '../state/RunState';
import type { RunState } from '../state/RunState';
import { breadPlacementId, generateSection, sectionSeed, sectionWindow } from '../world/sections';

export type BreadState = 'idle' | 'patrol' | 'chase' | 'windup' | 'active' | 'recover' | 'return';
type Brain = { state: BreadState; remaining: number; facing: -1 | 1; targetX: number; cycle: number; attackSpent: boolean };
export type Enemy = { sprite: Phaser.GameObjects.Container; speed: number; hp: number; maxHealth: number; damage: number; difficultyTier: number; placementX: number; placementId: string;
    brain: Brain; twig?: Phaser.GameObjects.Rectangle; art?: Phaser.GameObjects.Sprite; alert: Phaser.GameObjects.Text; animation?: BreadAnimation; deathElapsed?: number; velocityY: number };
type EnemyRecord = { hp: number; maxHealth: number; damage: number; difficultyTier: number; speed: number; defeated: boolean; x: number; y: number; velocityY: number; placementX: number; brain: Brain };

export class EnemySystem {
    private items: Enemy[] = [];
    // Run-long lightweight records; only nearby records have live sprites.
    private occupied = new Map<number, Set<string>>();
    private dying = new Set<Enemy>();
    private records = new Map<string, EnemyRecord>();
    private terrain?: Pick<WorldSystem, 'enemyHeadExposed' | 'standingY' | 'landingY'>;
    private wallResolver?: (from: number, to: number, y: number) => number;
    setWallResolver(resolver: (from: number, to: number, y: number) => number): void {
        this.wallResolver = resolver;
    }
    private immobilized: (id: string) => boolean = () => false;
    setImmobilized(check: (id: string) => boolean): void { this.immobilized = check; }


    setTerrain(terrain: Pick<WorldSystem, 'enemyHeadExposed' | 'standingY' | 'landingY'>): void { this.terrain = terrain; }

    constructor(private scene: Phaser.Scene, private run: RunState, private groundY: number, private player?: Pick<Player, 'x' | 'y'>) {
        scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
    }

    get enemies(): readonly Enemy[] { return this.items; }

    private topY(enemy: Enemy): number { return enemy.sprite.y - BREAD.standHeight; }

    isPlayerStandingOn(enemy: Enemy, playerX: number, playerY: number): boolean {
        return enemy.hp > 0 && enemy.sprite.active &&
            (!this.terrain || this.terrain.enemyHeadExposed(enemy.sprite.x, enemy.sprite.y)) &&
            Math.abs(playerX - enemy.sprite.x) <= BREAD.standHalfWidth &&
            Math.abs(playerY + BALANCE.player.groundOffset - this.topY(enemy)) < 3;
    }

    landingY(x: number, previousFoot: number, nextFoot: number): number | undefined {
        if (nextFoot < previousFoot) return undefined;
        let landing: number | undefined;
        for (const enemy of this.items) {
            if (enemy.hp <= 0 || !enemy.sprite.active ||
                (this.terrain && !this.terrain.enemyHeadExposed(enemy.sprite.x, enemy.sprite.y)) ||
                Math.abs(x - enemy.sprite.x) > BREAD.standHalfWidth) continue;
            const top = this.topY(enemy);
            if (previousFoot <= top + 1 && nextFoot >= top &&
                (landing === undefined || top < landing)) landing = top;
        }
        return landing;
    }

    standingY(x: number, foot: number): number | undefined {
        for (const enemy of this.items) {
            if (enemy.hp <= 0 || !enemy.sprite.active ||
                (this.terrain && !this.terrain.enemyHeadExposed(enemy.sprite.x, enemy.sprite.y)) ||
                Math.abs(x - enemy.sprite.x) > BREAD.standHalfWidth) continue;
            const top = this.topY(enemy);
            if (Math.abs(foot - top) < 3) return top;
        }
        return undefined;
    }

    // Sweep the requested movement so fast steps cannot pass through a living body.
    // Contact dimensions are gameplay values, independent of sprite scale/animation.
    resolvePlayerMovement(from: number, to: number, y: number): number {
        for (const enemy of this.items) {
            if (enemy.hp <= 0 || !enemy.sprite.active ||
                Math.abs(y - enemy.sprite.y) >= BALANCE.player.contactHeight) continue;
            const x = enemy.sprite.x;
            if (to > from && from <= x) to = Math.min(to, Math.max(from, x - BALANCE.player.contactWidth));
            else if (to < from && from >= x) to = Math.max(to, Math.min(from, x + BALANCE.player.contactWidth));
        }
        return to;
    }

    damage(enemy: Enemy, amount: number): boolean {
        const record = this.records.get(enemy.placementId)!;
        if (record.defeated || !this.items.includes(enemy)) return false;
        enemy.hp -= amount;
        record.hp = enemy.hp;
        if (enemy.hp > 0) return false;
        record.defeated = true;
        this.items.splice(this.items.indexOf(enemy), 1);
        this.unindex(enemy.placementId, record.x);
        enemy.alert.setVisible(false); enemy.deathElapsed = 0;
        this.dying.add(enemy);
        enemy.art?.once('animationcomplete', () => { enemy.sprite.destroy(); this.dying.delete(enemy); });
        this.play(enemy, 'death');
        return true;
    }

    prepare(): void {
        const camera = this.scene.cameras.main;
        // Very large range upgrades must not lose valid targets to streaming.
        const buffer = Math.max(camera.width * WORLD.preparationViewports, this.run.weapon.range);
        const cleanup = Math.max(camera.width * WORLD.cleanupViewports, buffer);
        for (let i = this.items.length - 1; i >= 0; i--) {
            const enemy = this.items[i];
            if (enemy.sprite.x < camera.scrollX - cleanup || enemy.sprite.x > camera.scrollX + camera.width + cleanup) {
                const record = this.records.get(enemy.placementId)!;
                record.hp = enemy.hp;
                record.y = enemy.sprite.y;
                record.velocityY = enemy.velocityY;
                enemy.sprite.destroy();
                this.items.splice(i, 1);
            }
        }
        const active = new Set(this.items.map(enemy => enemy.placementId));
        const window = sectionWindow(camera.scrollX, camera.width, buffer / camera.width);
        for (let index = window.first; index <= window.last; index++) {
            for (const id of this.occupied.get(index) ?? []) {
                const record = this.records.get(id)!;
                if (!active.has(id) && !record.defeated && record.x >= camera.scrollX - buffer &&
                    record.x <= camera.scrollX + camera.width + buffer) {
                    this.spawnBread(record.placementX, id); active.add(id);
                }
            }
            for (const { id, x } of generateSection(index, this.run.seed).enemies) {
                const record = this.records.get(id);
                if (!record && !active.has(id) && x >= camera.scrollX - buffer && x <= camera.scrollX + camera.width + buffer) {
                    this.spawnBread(x, id); active.add(id);
                }
            }
        }
    }

    update(dt: number, onAttack: (enemy: Enemy) => boolean | void): void {
        if (this.run.phase !== 'playing') return;
        this.prepare();
        const camera = this.scene.cameras.main;
        for (const enemy of this.dying) {
            enemy.deathElapsed = (enemy.deathElapsed ?? 0) + dt;
            if (!enemy.art) enemy.sprite.setAlpha(Math.max(0, 1 - enemy.deathElapsed / BREAD.deathDuration));
            if (enemy.deathElapsed >= BREAD.deathDuration + (enemy.art ? 0.25 : 0)) { enemy.sprite.destroy(); this.dying.delete(enemy); }
        }
        for (const enemy of this.items) {
            const near = enemy.sprite.x >= camera.scrollX - BREAD.activationMargin &&
                enemy.sprite.x <= camera.scrollX + camera.width + BREAD.activationMargin;
            enemy.sprite.setVisible(enemy.sprite.x >= camera.scrollX - 80 && enemy.sprite.x <= camera.scrollX + camera.width + 80);
            if (!near) { enemy.art?.anims.pause(); continue; }
            enemy.art?.anims.resume();
            if (this.player && !this.immobilized(enemy.placementId)) this.advance(enemy, dt, onAttack);
            this.advanceVertical(enemy, dt);
            this.syncVisual(enemy);
            if (this.run.phase !== 'playing') return;
        }
    }

    setPhase(phase: RunPhase): void {
        for (const enemy of [...this.items, ...this.dying]) {
            if (phase === 'playing') enemy.art?.anims.resume();
            else enemy.art?.anims.pause();
        }
    }

    private advance(enemy: Enemy, dt: number, onAttack: (enemy: Enemy) => boolean | void): void {
        const brain = enemy.brain, player = this.player!;
        const dx = player.x - enemy.sprite.x, distance = Math.abs(dx);
        const closeHeight = Math.abs(player.y - enemy.sprite.y);
        const homeDistance = Math.abs(enemy.sprite.x - enemy.placementX);
        const playerOnTop = this.isPlayerStandingOn(enemy, player.x, player.y);
        if (['idle', 'patrol', 'return'].includes(brain.state) && distance <= BREAD.detectionRange &&
            closeHeight <= BREAD.detectionHeight && brain.state !== 'return') brain.state = 'chase';
        if (brain.state === 'chase' && (distance > BREAD.loseRange || homeDistance > BREAD.territoryLeash)) brain.state = 'return';
        switch (brain.state) {
            case 'idle':
                brain.remaining -= dt;
                if (brain.remaining <= 1e-9) {
                    brain.state = 'patrol'; brain.cycle++;
                    brain.targetX = Math.max(BALANCE.player.minX, enemy.placementX + (brain.cycle % 2 ? -1 : 1) * BREAD.patrolDistance);
                }
                break;
            case 'patrol':
                if (this.move(enemy, brain.targetX, BREAD.patrolSpeed, dt)) this.idle(enemy);
                break;
            case 'return':
                if (this.move(enemy, enemy.placementX, BREAD.returnSpeed, dt)) this.idle(enemy);
                break;
            case 'chase':
                brain.facing = dx < 0 ? -1 : 1;
                if (distance <= BREAD.meleeStop && (closeHeight <= BREAD.attackHeight || playerOnTop)) {
                    brain.state = 'windup'; brain.remaining = BREAD.windup;
                } else this.move(enemy, player.x, enemy.speed, dt);
                break;
            case 'windup':
                brain.remaining -= dt;
                if (brain.remaining <= 1e-9) { brain.state = 'active'; brain.remaining = BREAD.active; brain.attackSpent = false; }
                break;
            case 'active':
                brain.remaining -= dt;
                if (brain.remaining <= 1e-9) { brain.state = 'recover'; brain.remaining = BREAD.recovery; }
                break;
            case 'recover':
                brain.remaining -= dt;
                if (brain.remaining <= 1e-9) this.idle(enemy);
                break;
        }
        // Facing is committed during windup/strike. Only this active window can request a hit.
        if (brain.state === 'active' && !brain.attackSpent && onAttack(enemy) !== false) brain.attackSpent = true;
        const record = this.records.get(enemy.placementId)!;
        if (record.x !== enemy.sprite.x) {
            if (Math.floor(record.x / WORLD.sectionLength) !== Math.floor(enemy.sprite.x / WORLD.sectionLength)) {
                this.unindex(enemy.placementId, record.x); this.index(enemy.placementId, enemy.sprite.x);
            }
            record.x = enemy.sprite.x;
        }
    }

    private advanceVertical(enemy: Enemy, dt: number): void {
        // Bread feet are 32px below their body origin. Check the actual terrain
        // rather than pinning every Bread to its original spawn elevation.
        const footOffset = BALANCE.enemy.groundOffset;
        const oldFoot = enemy.sprite.y + footOffset;
        const standing = this.terrain?.standingY(enemy.sprite.x, oldFoot);
        if (standing !== undefined && enemy.velocityY >= 0) {
            enemy.sprite.y = standing - footOffset;
            enemy.velocityY = 0;
        } else if (this.terrain) {
            enemy.velocityY += BALANCE.player.gravity * dt;
            const nextFoot = oldFoot + enemy.velocityY * dt;
            const land = this.terrain.landingY(enemy.sprite.x, oldFoot, nextFoot);
            if (land !== undefined) {
                enemy.sprite.y = land - footOffset;
                enemy.velocityY = 0;
            } else {
                enemy.sprite.y = nextFoot - footOffset;
            }
        }
        const record = this.records.get(enemy.placementId);
        if (record) {
            record.y = enemy.sprite.y;
            record.velocityY = enemy.velocityY;
        }
        // Falling into a pit removes the Bread permanently for this run,
        // without awarding player kills or XP.
        if (enemy.sprite.y > this.scene.scale.height + 120) {
            if (record) {
                record.defeated = true;
                this.unindex(enemy.placementId, record.x);
            }
            const index = this.items.indexOf(enemy);
            if (index >= 0) this.items.splice(index, 1);
            enemy.sprite.destroy();
        }
    }

    private move(enemy: Enemy, target: number, speed: number, dt: number): boolean {
        // Keep a player riding on top from being dropped by a patrolling body.
        if (this.player && this.isPlayerStandingOn(enemy, this.player.x, this.player.y)) return false;
        const dx = target - enemy.sprite.x;
        if (dx !== 0) enemy.brain.facing = dx < 0 ? -1 : 1;
        const from = enemy.sprite.x;
        let to = from + Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
        if (this.player && Math.abs(this.player.y - enemy.sprite.y) < BALANCE.player.contactHeight) {
            if (to > from && from <= this.player.x)
                to = Math.min(to, Math.max(from, this.player.x - BALANCE.player.contactWidth));
            else if (to < from && from >= this.player.x)
                to = Math.max(to, Math.min(from, this.player.x + BALANCE.player.contactWidth));
        }
        to = this.wallResolver?.(from, to, enemy.sprite.y) ?? to;
        enemy.sprite.x = to;
        return Math.abs(target - enemy.sprite.x) < 0.01;
    }

    private idle(enemy: Enemy): void {
        const roll = sectionSeed(this.run.seed ^ enemy.placementX, enemy.brain.cycle) / 0x100000000;
        enemy.brain.state = 'idle'; enemy.brain.remaining = BREAD.idleMin + roll * (BREAD.idleMax - BREAD.idleMin);
    }

    private play(enemy: Enemy, state: BreadAnimation): void {
        if (enemy.art && enemy.animation !== state) { enemy.art.play(`bread:${state}`); enemy.animation = state; }
    }

    private syncVisual(enemy: Enemy): void {
        const brain = enemy.brain;
        enemy.alert.setVisible(brain.state === 'windup');
        enemy.art?.setFlipX(brain.facing === -1);
        if (enemy.twig) { enemy.twig.x = brain.facing * 32; enemy.twig.setAngle(brain.facing * (brain.state === 'active' ? 70 : 25)); }
        const striking = brain.state === 'active' || (brain.state === 'windup' && brain.remaining <= BREAD.animationLead + 1e-9);
        if (striking) this.play(enemy, 'attack');
        else if (brain.state === 'recover' && enemy.animation === 'attack' && enemy.art?.anims.isPlaying) return;
        else this.play(enemy, ['patrol', 'chase', 'return'].includes(brain.state) ? 'run' : 'idle');
    }

    private index(id: string, x: number): void {
        const section = Math.floor(x / WORLD.sectionLength), ids = this.occupied.get(section) ?? new Set<string>();
        ids.add(id); this.occupied.set(section, ids);
    }
    private unindex(id: string, x: number): void {
        const section = Math.floor(x / WORLD.sectionLength), ids = this.occupied.get(section);
        ids?.delete(id); if (!ids?.size) this.occupied.delete(section);
    }

    private spawnBread(worldX: number = WORLD.enemyStartX, id = breadPlacementId(this.run.seed, worldX)) {
        const existing = this.items.find(enemy => enemy.placementId === id);
        if (existing) return existing;
        let record = this.records.get(id);
        if (record?.defeated) return;
        if (!record) {
            const difficultyTier = difficultyRegion(worldX);
            const maxHealth = BREAD.initialHealth + Math.min(BREAD.maxHealthBonus, difficultyTier * BREAD.healthPerRegion);
            const speedRoll = sectionSeed(this.run.seed, worldX) / 0x100000000;
            record = {
                speed: BREAD.chaseSpeed, hp: maxHealth, maxHealth, damage: BREAD.damage, difficultyTier,
                defeated: false, x: worldX, y: this.groundY - BALANCE.enemy.groundOffset,
                velocityY: 0, placementX: worldX,
                brain: { state: 'idle', remaining: BREAD.idleMin + speedRoll * (BREAD.idleMax - BREAD.idleMin),
                    facing: -1, targetX: worldX, cycle: 0, attackSpent: false }
            };
            this.records.set(id, record); this.index(id, record.x);
        }
        const sprite = this.scene.add.container(record.x, record.y).setDepth(6);
        let art: Phaser.GameObjects.Sprite | undefined;
        let twig: Phaser.GameObjects.Rectangle | undefined;
        if (hasBreadAnimations(this.scene)) {
            art = this.scene.add.sprite(BREAD.offsetX, BREAD.offsetY, 'bread:idle', 0)
                .setOrigin(BREAD.originX, BREAD.originY).setScale(BREAD.scale);
            sprite.add(art);
        } else sprite.add([
            this.scene.add.rectangle(0, 0, 57, 65, 0x9c612f).setStrokeStyle(3, 0x563718),
            this.scene.add.rectangle(0, 0, 46, 54, 0xeac38b),
            this.scene.add.circle(-11, -7, 3, 0x2d211b),
            this.scene.add.circle(11, -7, 3, 0x2d211b),
            this.scene.add.ellipse(0, 12, 13, 5, 0x4c2e22)
        ]);
        if (!art) { twig = this.scene.add.rectangle(-32, 0, 5, 34, 0x72512f); sprite.add(twig); }
        sprite.setScrollFactor(1, 1, true);
        const camera = this.scene.cameras.main;
        sprite.setVisible(worldX >= camera.scrollX - 80 && worldX <= camera.scrollX + camera.width + 80);
        // Retain the existing speed metadata for later behaviour; no runner drift is applied.
        const alert = this.scene.add.text(0, -62, '!', { fontSize: '28px', color: '#ffe19a', backgroundColor: '#70452f' })
            .setOrigin(0.5).setVisible(false);
        sprite.add(alert);
        const enemy: Enemy = { sprite, art, twig, alert, brain: record.brain, speed: record.speed, hp: record.hp, maxHealth: record.maxHealth, damage: record.damage, difficultyTier: record.difficultyTier,
            placementX: record.placementX, placementId: id, velocityY: record.velocityY };
        this.syncVisual(enemy);
        this.items.push(enemy);
        return enemy;
    }

    destroy(): void {
        this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
        for (const enemy of this.items) if (enemy.sprite.active) enemy.sprite.destroy();
        for (const enemy of this.dying) enemy.sprite.destroy();
        this.items = []; this.dying.clear(); this.occupied.clear();
        this.records.clear();
    }
}
