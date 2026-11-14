import * as Phaser from 'phaser';
import { WORLD } from '../config/world';
import { WorldDebug } from '../ui/WorldDebug';
import { WorldCamera } from '../world/WorldCamera';
import { WorldSystem } from '../world/WorldSystem';
import { BALANCE } from '../config/balance';
import { UPGRADES } from '../data/upgrades';
import { applyUpgrade } from '../systems/applyUpgrade';
import { selectUpgrades } from '../systems/selectUpgrades';
import { Hud } from '../ui/Hud';
import { createUpgradePanel } from '../ui/UpgradePanel';
import { createGameOverPanel } from '../ui/GameOverPanel';
import { Rosie } from '../world/Rosie';
import type { Upgrade } from '../data/upgrades';
import { createRunState } from '../state/RunState';
import type { RunPhase } from '../state/RunState';
import { Player } from '../entities/Player';
import { PlayerInput } from '../input/PlayerInput';
import { EnemySystem } from '../systems/EnemySystem';
import { ArcherSystem } from '../systems/ArcherSystem';
import { PlatformRewardSystem } from '../systems/PlatformRewardSystem';
import { CombatSystem } from '../systems/CombatSystem';
import { HazardSystem } from '../systems/HazardSystem';
import { isCharacterId, CHARACTERS } from '../characters/definitions';
import type { CharacterId } from '../characters/definitions';
import { XpSystem } from '../systems/XpSystem';
import { StructureSystem } from '../systems/StructureSystem';
import { HealthPickupSystem } from '../systems/HealthPickupSystem';
import { RewardNotice } from '../ui/RewardNotice';
import type { ChestReward } from '../world/sections';
import { STRUCTURES } from '../config/structures';

export class Game extends Phaser.Scene {
    private selectedCharacter: CharacterId = 'llamaCrunch';
    private rosie!: Rosie;
    private player!: Player;
    private playerInput!: PlayerInput;
    private worldCamera!: WorldCamera;
    private debug?: WorldDebug;
    private world!: WorldSystem;
    private enemySystem!: EnemySystem;
    private archerSystem!: ArcherSystem;
    private platformRewards!: PlatformRewardSystem;
    private combatSystem!: CombatSystem;
    private hazardSystem!: HazardSystem;
    private rewardNotice!: RewardNotice;
    private structures!: StructureSystem;
    private healthPickups!: HealthPickupSystem;
    private xpSystem!: XpSystem;
    private groundY = 0;
    private run = createRunState();
    private upgradePanel?: Phaser.GameObjects.Container;
    private offered: Upgrade[] = [];
    private hud!: Hud;
    private pauseReasons = new Set<string>();
    private phaseBeforePause: Exclude<RunPhase, 'paused'> = 'playing';

    constructor() { super('Game'); }

    init(data: { characterId?: unknown } = {}): void {
        this.selectedCharacter = isCharacterId(data.characterId) ? data.characterId : 'llamaCrunch';
    }

    create() {
        const { height } = this.scale;
        this.groundY = height * BALANCE.player.groundHeightRatio;
        this.run = createRunState(this.selectedCharacter);
        this.pauseReasons.clear();
        this.phaseBeforePause = 'playing';
        this.time.paused = false;
        this.tweens.resumeAll();
        this.tweens.timeScale = 1;
        this.offered = [];
        this.upgradePanel = undefined;
        this.debug = undefined;

        this.cameras.main.setBackgroundColor('#b9d9e8');
        this.player = new Player(this, this.run, this.groundY);
        this.run.startX = this.run.furthestX = this.player.x;
        this.worldCamera = new WorldCamera(this.cameras.main, height);
        this.world = new WorldSystem(this, this.run.seed, this.groundY);

        this.rosie = new Rosie(this, this.run);

        this.playerInput = new PlayerInput(this, () => this.run.phase === 'playing', CHARACTERS[this.run.characterId].canShield === true);

        this.enemySystem = new EnemySystem(this, this.run, this.groundY, this.player);
        this.enemySystem.setTerrain(this.world);
        this.enemySystem.setWallResolver((from, to, y) =>
            this.world.resolvePlayerMovement(from, to, y));
        this.enemySystem.prepare(); // Before the first gameplay render, including both approach buffers.
        this.xpSystem = new XpSystem(this, this.run, this.player,
            () => this.openLevelUp(), () => this.updateHud());
        this.healthPickups = new HealthPickupSystem(this, this.run, this.player, () => this.updateHud());
        this.platformRewards = new PlatformRewardSystem(this, this.run, this.player, this.groundY,
            value => this.xpSystem.award(value));
        this.platformRewards.prepare();
        this.rewardNotice = new RewardNotice(this);
        this.structures = new StructureSystem(this, this.run, this.groundY, (placement, x, y) => {
            this.xpSystem.dropGem(x, y, STRUCTURES.crate.xp);
            if (placement.healthDrop) this.healthPickups.drop(`${placement.id}:health`, x, y);
        }, this.player, reward => this.claimChestReward(reward));
        this.structures.prepare();
        this.archerSystem = new ArcherSystem(this, this.run, this.groundY, this.player,
            x => this.combatSystem.resolveArcherArrow(x),
            (x, y) => { this.run.kills++; this.xpSystem.dropGem(x, y); this.updateHud(); });
        this.archerSystem.setTerrain(this.world);
        this.archerSystem.prepare();
        this.combatSystem = new CombatSystem(this, this.run, this.player, this.enemySystem,
            (x, y) => this.xpSystem.dropGem(x, y), () => this.endGame(), () => this.updateHud(),
            () => this.rosie.speak('damage'), this.structures, this.archerSystem);
        this.combatSystem.setTerrain(this.world);
        this.hazardSystem = new HazardSystem(this, this.run, this.groundY,
            this.player, this.enemySystem, this.archerSystem,
            amount => this.combatSystem.applyEnvironmentalDamage(amount));
        this.enemySystem.setImmobilized(id => this.hazardSystem.isEnemyTrapped(id));
        this.archerSystem.setImmobilized(id => this.hazardSystem.isEnemyTrapped(id));
        this.hazardSystem.prepare();

        this.hud = new Hud(this);
        if (import.meta.env.DEV && WORLD.debugOverlay) {
            this.debug = new WorldDebug(this);
            this.debug.resetSample(this.player, this.cameras.main);
        }
        this.updateHud();
        this.bindPauseEvents();
    }

    private updateHud() {
        this.hud.update(this.run, this.xpSystem.xpNeeded());
    }

    private openLevelUp() { this.openUpgradeChoices(); }

    private openUpgradeChoices(chest = false) {
        this.setPhase('choosingUpgrade');
        const rosieLine = chest ? undefined : this.rosie.speak('levelUp');
        this.playerInput.clearTouch();
        this.offered = selectUpgrades(UPGRADES);
        this.upgradePanel = createUpgradePanel(this, this.run.level, this.offered,
            (index) => this.chooseUpgrade(index), rosieLine, chest ? 'CHEST REWARD' : undefined);
    }

    private claimChestReward(reward: ChestReward): void {
        if (this.run.phase !== 'playing') return;
        if (reward === 'upgrade') {
            this.rewardNotice.show('CHEST: FREE UPGRADE');
            this.openUpgradeChoices(true);
            return;
        }
        const healed = reward === 'heal' ? Math.min(STRUCTURES.chest.healing, this.run.maxHealth - this.run.health) : 0;
        if (healed > 0) {
            this.run.health += healed;
            this.rewardNotice.show(`CHEST: +${healed} HEALTH`);
            this.updateHud();
        } else {
            // Full-health healing chests still give a useful reward.
            this.rewardNotice.show(`CHEST: +${STRUCTURES.chest.xp} XP`);
            this.xpSystem.award(STRUCTURES.chest.xp);
        }
    }

    private chooseUpgrade(index: number) {
        if (this.run.phase !== 'choosingUpgrade' || !this.offered[index]) return;
        applyUpgrade(this.run, this.offered[index].id);
        this.upgradePanel?.destroy();
        this.upgradePanel = undefined;
        this.setPhase('playing');
        this.player.showLevelUp();
        this.run.weapon.lastAttack = this.run.runTime * 1000;
        this.updateHud();
        this.xpSystem.checkLevelUp();
    }

    private endGame() {
        if (this.run.phase === 'gameOver') return;
        this.playerInput.clearAll();
        this.setPhase('gameOver');
        this.player.showDeath();
        const rosieLine = this.rosie.speak('death');
        createGameOverPanel(this, this.run, () => this.restartRun(), () => this.returnToMenu(), rosieLine);
    }

    private setPhase(phase: RunPhase): void {
        this.run.phase = phase;
        this.debug?.resetSample(this.player, this.cameras.main);
        if (phase !== 'playing') this.player.setShielding(false);
        this.player.setVisualPhase(phase);
        this.enemySystem.setPhase(phase);
        this.archerSystem?.setPhase(phase);
        this.combatSystem.setVisualPhase(phase);
        const frozen = phase !== 'playing';
        this.time.paused = frozen;
        // Keep Phaser's tween clock ticking with zero progression while frozen.
        // Pausing the manager itself can include the pause gap in its next delta.
        this.tweens.timeScale = frozen ? 0 : 1;
        if (frozen) { this.playerInput.clearTouch(); this.structures.update(); }
    }

    private restartRun(): void {
        if (this.run.phase === 'gameOver' && this.pauseReasons.size === 0) {
            this.scene.restart({ characterId: this.run.characterId });
        }
    }

    private returnToMenu(): void {
        if (this.run.phase === 'gameOver' && this.pauseReasons.size === 0) this.scene.start('MainMenu');
    }

    private setPauseReason(reason: string, active: boolean): void {
        if (active) this.playerInput.clearAll();
        if (active) this.pauseReasons.add(reason);
        else this.pauseReasons.delete(reason);
        if (this.pauseReasons.size > 0 && this.run.phase !== 'paused' && this.run.phase !== 'gameOver') {
            this.phaseBeforePause = this.run.phase;
            this.setPhase('paused');
        } else if (this.pauseReasons.size === 0 && this.run.phase === 'paused') {
            this.playerInput.clearAll();
            this.setPhase(this.phaseBeforePause);
        }
        // Game-over remains terminal, but its visual-only death animation can still pause.
        this.player.setVisualPhase(this.pauseReasons.size > 0 ? 'paused' : this.run.phase);
    }

    private bindPauseEvents(): void {
        const blur = () => this.setPauseReason('focus', true);
        const focus = () => this.setPauseReason('focus', false);
        const hidden = () => this.setPauseReason('hidden', true);
        const visible = () => this.setPauseReason('hidden', false);
        const orientation = window.matchMedia('(orientation: portrait)');
        const orientationChanged = () => {
            this.playerInput.clearAll();
            this.setPauseReason('portrait', orientation.matches);
        };
        orientation.addEventListener('change', orientationChanged);
        this.game.events.on(Phaser.Core.Events.BLUR, blur);
        this.game.events.on(Phaser.Core.Events.FOCUS, focus);
        this.game.events.on(Phaser.Core.Events.HIDDEN, hidden);
        this.game.events.on(Phaser.Core.Events.VISIBLE, visible);
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.game.events.off(Phaser.Core.Events.BLUR, blur);
            this.game.events.off(Phaser.Core.Events.FOCUS, focus);
            this.game.events.off(Phaser.Core.Events.HIDDEN, hidden);
            this.game.events.off(Phaser.Core.Events.VISIBLE, visible);
            orientation.removeEventListener('change', orientationChanged);
            this.pauseReasons.clear();
            this.time.paused = false;
        });
        orientationChanged();
        this.setPauseReason('hidden', document.hidden);
        this.setPauseReason('focus', !document.hasFocus());
    }

    update(_time: number, delta: number) {
        if (this.run.phase === 'gameOver') {
            if (this.playerInput.restartPressed()) this.restartRun();
            else if (this.playerInput.menuPressed()) this.returnToMenu();
            return;
        }
        if (this.run.phase === 'choosingUpgrade') {
            const choice = this.playerInput.upgradeChoice();
            if (choice !== undefined) this.chooseUpgrade(choice);
            return;
        }
        if (this.run.phase !== 'playing') return;
        // Preserve wall-clock movement on slow frames without increasing physics step size.
        const frameDt = Math.min(Math.max(0, delta / 1000), WORLD.maxCatchUpSeconds);
        const steps = Math.max(1, Math.ceil(frameDt / BALANCE.simulation.maxDeltaSeconds));
        const dt = frameDt / steps;
        this.player.setShielding(this.playerInput.shieldHeld());
        const actions = this.playerInput.readActions();
        const interact = this.playerInput.interactPressed();
        let simulatedMs = 0;
        for (let step = 0; step < steps; step++) {
            if (this.run.phase !== 'playing') break;
            this.run.runTime += dt;
            simulatedMs += dt * 1000;
            // One-way standing surfaces from terrain and living enemy heads.
            // Choose the highest surface crossed while falling, and retain
            // whichever surface already supports the player's feet.
            this.enemySystem.prepare();
            this.archerSystem?.prepare();
            const surfaces = [this.world, this.enemySystem, this.archerSystem];
            const trappedAtStart = this.hazardSystem?.isPlayerTrapped ?? false;
            // Process J before physics. While Candy is holding a charge she
            // cannot walk or initiate a jump, but gravity still operates if
            // she began charging in midair.
            const chargeHeld = this.run.characterId === 'candy' && actions.attack && !trappedAtStart;
            this.combatSystem.updateCharge(chargeHeld, dt);
            const movementLocked = trappedAtStart || this.combatSystem.isCharging;
            this.player.update(movementLocked ? { ...actions, left: false, right: false, jump: false } : actions, dt,
                (from, to, y) => this.archerSystem.resolvePlayerMovement(from,
                    this.enemySystem.resolvePlayerMovement(from,
                        this.world.resolvePlayerMovement(from, to, y), y), y),
                {
                    landingY: (x, prev, next) => {
                        const hits = surfaces.map(surface => surface.landingY(x, prev, next))
                            .filter((value): value is number => value !== undefined);
                        return hits.length ? Math.min(...hits) : undefined;
                    },
                    standingY: (x, foot) => surfaces.map(surface => surface.standingY(x, foot))
                        .find(value => value !== undefined)
                });
            this.world.advance(dt, this.player.x,
                this.player.y + BALANCE.player.groundOffset);
            // A missed pit jump is a genuine fall, not an endless descent.
            // No fall hazard exists in the introductory section.
            if (this.player.y > this.scale.height + 90) {
                this.endGame();
                break;
            }
            this.run.furthestX = Math.max(this.run.furthestX, this.player.x);
            this.run.distance = Math.max(0, this.run.furthestX - this.run.startX) / WORLD.pixelsPerMetre;
            this.worldCamera.update(this.player.x, dt);
            this.world.update();
            this.enemySystem.prepare();
            this.archerSystem?.prepare();
            this.structures.prepare();
            this.hazardSystem?.update();
            this.hazardSystem?.updateEscape(this.playerInput.escapeHeld(), dt);
            // J / ATK has a single, shared control: tap to shoot, hold to
            // charge, release to launch the stronger shot. Llama retains
            // its existing held-button sword attack behaviour.
            const consumedAttack = this.hazardSystem?.handlePlayerAttack(actions.attack && this.run.characterId !== 'candy') ?? false;
            if (this.run.characterId !== 'candy' && actions.attack && !consumedAttack)
                this.combatSystem.attack();
            this.combatSystem.update(dt);
            this.enemySystem.update(dt, (enemy) => this.combatSystem.resolveEnemyAttack(enemy));
            this.archerSystem?.update(dt);
            // Fire contact on the Pyromancer's head; Bread heads are harmless
            // except for their existing telegraphed melee attacks.
            this.combatSystem.resolvePyromancerFireContact();
            if (this.run.phase !== 'playing') break;
            this.healthPickups.update();
            this.structures.update(step === 0 && interact);
            if (this.run.phase !== 'playing') break;
            this.xpSystem.update(dt);
            this.platformRewards?.update();
        }
        this.debug?.update(this.player, this.cameras.main, this.enemySystem.enemies, delta, simulatedMs, this.run.moveSpeed);
        this.updateHud();
    }

}
