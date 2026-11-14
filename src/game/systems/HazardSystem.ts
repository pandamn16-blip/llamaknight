import * as Phaser from 'phaser';
import { WORLD } from '../config/world';
import { BALANCE } from '../config/balance';
import { generateSection, sectionWindow } from '../world/sections';
import type { HazardPlacement } from '../world/hazards';
import type { RunState } from '../state/RunState';
import type { Player } from '../entities/Player';
import type { Enemy, EnemySystem } from './EnemySystem';
import type { Archer, ArcherSystem } from './ArcherSystem';

type Hazard = {
    placement: HazardPlacement;
    pieces: Phaser.GameObjects.Rectangle[];
    trapHits: number;
};
const cooldown = BALANCE.player.damageCooldown / 1000;

// Uses game simulation time, not Phaser timers: pause, streaming, replay and
// rapidly repeated hits all follow the same deterministic rules.
export class HazardSystem {
    private active = new Map<string, Hazard>();
    private broken = new Set<string>();
    private enemyTrappedUntil = new Map<string, number>();
    private lastEnemyHit = new Map<string, number>();
    private playerTrap?: string;
    private escapeProgress = 0;
    private readonly escapeSeconds = 2;
    private escapePointer?: number;
    private escapeUi?: {
        button: Phaser.GameObjects.Arc;
        label: Phaser.GameObjects.Text;
        timer: Phaser.GameObjects.Text;
        track: Phaser.GameObjects.Rectangle;
        fill: Phaser.GameObjects.Rectangle;
    };

    constructor(private scene: Phaser.Scene, private run: RunState,
        private groundY: number, private player: Player,
        private enemies: EnemySystem, private archers: ArcherSystem,
        private hurtPlayer: (amount: number) => boolean) {
        scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
        scene.input?.on('pointerup', this.releaseEscapePointer, this);
        scene.input?.on('pointerupoutside', this.releaseEscapePointer, this);
        scene.input?.on('gameout', this.clearEscapeHold, this);
    }

    get isPlayerTrapped(): boolean { return this.playerTrap !== undefined; }
    isEnemyTrapped(id: string): boolean {
        return (this.enemyTrappedUntil.get(id) ?? -Infinity) > this.run.runTime;
    }

    private make(placement: HazardPlacement): Hazard {
        const x = placement.x, y = this.groundY;
        const pieces: Phaser.GameObjects.Rectangle[] = [];
        const rect = (dx: number, dy: number, width: number, height: number, color: number) => {
            pieces.push(this.scene.add.rectangle(x + dx, y + dy, width, height, color).setDepth(5));
        };
        if (placement.kind === 'snap-trap') {
            rect(0, -3, 46, 6, 0x64534b);
            rect(-17, -11, 9, 16, 0xb8bcc6);
            rect(17, -11, 9, 16, 0xb8bcc6);
            rect(0, -4, 13, 6, 0xe2a24b);
        } else {
            rect(0, -2, 64, 5, 0x554a48);
            for (const offset of [-24, -8, 8, 24]) {
                rect(offset, -11, 10, 18, placement.kind === 'timed-spikes' ? 0xc8a65d : 0xc3cad0);
            }
        }
        return { placement, pieces, trapHits: 0 };
    }

    prepare(): void {
        const camera = this.scene.cameras.main;
        const window = sectionWindow(camera.scrollX, camera.width, WORLD.preparationViewports);
        const keep = sectionWindow(camera.scrollX, camera.width, WORLD.cleanupViewports);
        for (const [id, hazard] of this.active) {
            const section = Math.floor(hazard.placement.x / WORLD.sectionLength);
            if (section >= keep.first && section <= keep.last) continue;
            if (this.playerTrap === id) continue;
            hazard.pieces.forEach(piece => piece.destroy());
            this.active.delete(id);
        }
        for (let i = window.first; i <= window.last; i++) {
            for (const placement of generateSection(i, this.run.seed).hazards) {
                if (this.broken.has(placement.id) || this.active.has(placement.id)) continue;
                this.active.set(placement.id, this.make(placement));
            }
        }
    }

    private timedActive(hazard: Hazard): boolean {
        if (hazard.placement.kind !== 'timed-spikes') return true;
        const phase = (this.run.runTime + (hazard.placement.x % 17) / 17) % 3.4;
        return phase < 1.0;
    }

    private updateVisual(hazard: Hazard): void {
        if (hazard.placement.kind === 'timed-spikes') {
            const phase = (this.run.runTime + (hazard.placement.x % 17) / 17) % 3.4;
            const opacity = phase < 1 ? 1 : phase < 1.4 ? 0.6 : 0.16;
            hazard.pieces.forEach((part, index) => { if (index > 0) part.setAlpha(opacity); });
        } else if (hazard.placement.kind === 'snap-trap' && hazard.trapHits) {
            hazard.pieces.forEach(part => part.setAlpha(Math.max(0.35, 1 - hazard.trapHits * 0.2)));
        }
    }

    private breakTrap(hazard: Hazard): void {
        this.broken.add(hazard.placement.id);
        if (this.playerTrap === hazard.placement.id) {
            this.playerTrap = undefined;
            this.clearEscapePrompt();
        }
        hazard.pieces.forEach(piece => piece.destroy());
        this.active.delete(hazard.placement.id);
    }

    private showEscapePrompt(x: number): void {
        this.clearEscapePrompt();
        // The prompt is anchored to the caught trap in world coordinates and
        // is itself a large touch target on mobile. No permanent extra HUD button.
        const y = this.groundY - 112;
        const button = this.scene.add.circle(x, y, 67, 0x25263f, 0.86)
            .setDepth(35).setStrokeStyle(3, 0xffd878).setInteractive();
        const label = this.scene.add.text(x, y - 36, 'HOLD X', {
            fontSize: '19px', color: '#ffffff', fontStyle: 'bold'
        }).setOrigin(0.5).setDepth(36);
        const timer = this.scene.add.text(x, y - 8, 'HOLD / TOUCH', {
            fontSize: '14px', color: '#ffe1a2'
        }).setOrigin(0.5).setDepth(36);
        const track = this.scene.add.rectangle(x, y + 26, 104, 10, 0x0c101c)
            .setDepth(36).setOrigin(0.5);
        const fill = this.scene.add.rectangle(x - 52, y + 26, 104, 8, 0x80ecc0)
            .setDepth(37).setOrigin(0, 0.5).setScale(0, 1);
        button.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
            if (this.run.phase === 'playing' && this.isPlayerTrapped)
                this.escapePointer = pointer.id;
        });
        button.on('pointerup', this.releaseEscapePointer, this);
        button.on('pointerout', this.releaseEscapePointer, this);
        this.escapeUi = { button, label, timer, track, fill };
    }

    private releaseEscapePointer(pointer: Phaser.Input.Pointer): void {
        if (this.escapePointer === pointer.id) this.escapePointer = undefined;
    }

    private clearEscapeHold(): void { this.escapePointer = undefined; }

    // Do not carry a partly held escape through pause, focus loss or upgrades.
    resetEscapeHold(): void {
        this.escapePointer = undefined;
        this.escapeProgress = 0;
        this.escapeUi?.timer.setText('HOLD / TOUCH');
        this.escapeUi?.fill.setScale(0, 1);
    }

    private clearEscapePrompt(): void {
        this.escapePointer = undefined;
        this.escapeProgress = 0;
        if (this.escapeUi) Object.values(this.escapeUi).forEach(object => object.destroy());
        this.escapeUi = undefined;
    }

    // Holding X on keyboard or the in-world button on mobile for two
    // uninterrupted seconds breaks a bear trap. Letting go resets progress.
    updateEscape(keyHeld: boolean, dt: number): void {
        if (!this.playerTrap || this.run.phase !== 'playing') return;
        const hazard = this.active.get(this.playerTrap);
        if (!hazard) {
            this.playerTrap = undefined;
            this.clearEscapePrompt();
            return;
        }
        const held = keyHeld || this.escapePointer !== undefined;
        this.escapeProgress = held
            ? Math.min(this.escapeSeconds, this.escapeProgress + Math.max(0, dt))
            : 0;
        this.escapeUi?.timer.setText(held
            ? `${Math.ceil(Math.max(0, this.escapeSeconds - this.escapeProgress) * 10) / 10}s`
            : 'HOLD / TOUCH');
        this.escapeUi?.fill.setScale(this.escapeProgress / this.escapeSeconds, 1);
        if (this.escapeProgress >= this.escapeSeconds) this.breakTrap(hazard);
    }

    // Attacking is disabled while caught: escape is exclusively X or the
    // hold button, so J remains available for combat after getting free.
    handlePlayerAttack(_pressed: boolean): boolean {
        return this.isPlayerTrapped;
    }

    private hitEnemy(enemy: Enemy | Archer): void {
        const id = 'placementId' in enemy ? enemy.placementId : enemy.id;
        if (this.isEnemyTrapped(id) || this.run.runTime -
            (this.lastEnemyHit.get(id) ?? -Infinity) < cooldown) return;
        this.lastEnemyHit.set(id, this.run.runTime);
        if ('placementId' in enemy) this.enemies.damage(enemy, 1);
        else this.archers.damage(enemy, 1);
    }

    update(): void {
        if (this.run.phase !== 'playing') return;
        this.prepare();
        for (const [id, end] of this.enemyTrappedUntil) {
            if (end <= this.run.runTime) this.enemyTrappedUntil.delete(id);
        }
        const foot = this.player.y + BALANCE.player.groundOffset;
        for (const hazard of this.active.values()) {
            this.updateVisual(hazard);
            const x = hazard.placement.x;
            const onGround = Math.abs(foot - this.groundY) <= 7;
            const playerNear = onGround && Math.abs(this.player.x - x) <=
                (hazard.placement.kind === 'snap-trap' ? 21 : 30);
            if (hazard.placement.kind === 'snap-trap') {
                if (playerNear && !this.playerTrap) {
                    this.playerTrap = hazard.placement.id;
                    this.showEscapePrompt(x);
                    this.run.velocityY = 0;
                    this.run.onGround = true;
                    this.hurtPlayer(1);
                }
            } else if (this.timedActive(hazard) && playerNear) {
                this.hurtPlayer(1);
            }
            // The player owns this trap until they escape; an enemy cannot
            // destroy it from underneath a captured player.
            if (hazard.placement.kind === 'snap-trap' &&
                this.playerTrap === hazard.placement.id) continue;
            // Enemies are affected by the same traps/spikes. A captured enemy
            // is held briefly then automatically struggles free; no infinite AI lock.
            if (!this.timedActive(hazard)) continue;
            for (const enemy of [...this.enemies.enemies, ...this.archers.archers]) {
                const enemyX = enemy.sprite.x, enemyY = enemy.sprite.y;
                if (Math.abs(enemyX - x) > 27 ||
                    Math.abs(enemyY - (this.groundY - BALANCE.enemy.groundOffset)) > 38) continue;
                const enemyId = 'placementId' in enemy ? enemy.placementId : enemy.id;
                if (hazard.placement.kind === 'snap-trap') {
                    if (!this.isEnemyTrapped(enemyId)) {
                        this.hitEnemy(enemy);
                        this.enemyTrappedUntil.set(enemyId, this.run.runTime + 2.5);
                        this.breakTrap(hazard);
                        break;
                    }
                } else this.hitEnemy(enemy);
            }
        }
    }

    destroy(): void {
        this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
        this.scene.input?.off('pointerup', this.releaseEscapePointer, this);
        this.scene.input?.off('pointerupoutside', this.releaseEscapePointer, this);
        this.scene.input?.off('gameout', this.clearEscapeHold, this);
        this.clearEscapePrompt();
        for (const hazard of this.active.values()) hazard.pieces.forEach(piece => piece.destroy());
        this.active.clear();
        this.broken.clear();
        this.enemyTrappedUntil.clear();
        this.lastEnemyHit.clear();
        this.playerTrap = undefined;
    }
}
