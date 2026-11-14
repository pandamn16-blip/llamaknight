import { Input, Scenes } from 'phaser';
import type { Scene, Types, GameObjects } from 'phaser';
import { isMobileLayout, onLayoutResize } from '../ui/layout';

export type PlayerActions = { left: boolean; right: boolean; jump: boolean; attack: boolean };

type TouchAction = keyof PlayerActions | 'shield' | 'charge';

export class PlayerInput {
    private cursors: Types.Input.Keyboard.CursorKeys;
    private keys: Record<'A' | 'D' | 'W' | 'J' | 'C' | 'R' | 'M' | 'E' | 'K' | 'ONE' | 'TWO' | 'THREE', Input.Keyboard.Key>;
    private touches: Record<TouchAction, Set<number>> = {
        left: new Set(), right: new Set(), jump: new Set(), attack: new Set(), shield: new Set(), charge: new Set()
    };
    private joystick?: { base: GameObjects.Arc; thumb: GameObjects.Arc; pointerId?: number };
    private cleanups: (() => void)[] = [];

    constructor(private scene: Scene, private isPlaying: () => boolean, private shieldEnabled = false) {
        const { width, height } = scene.scale;
        this.cursors = scene.input.keyboard!.createCursorKeys();
        this.keys = scene.input.keyboard!.addKeys('A,D,W,J,C,R,M,E,K,ONE,TWO,THREE') as typeof this.keys;
        scene.input.keyboard!.addCapture(['SPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT']);

        const mobile = isMobileLayout();
        if (!mobile) {
            this.makeTouchButton(66, height - 68, '◀', 'left');
            this.makeTouchButton(154, height - 68, '▶', 'right');
        }
        const jump = this.makeTouchButton(width - (mobile ? 264 : 174), height - (mobile ? 112 : 68), 'JUMP', 'jump', mobile);
        const attack = this.makeTouchButton(width - (mobile ? 102 : 70), height - (mobile ? 112 : 68), 'ATK', 'attack', mobile);
        const charge = !shieldEnabled ? this.makeTouchButton(width - (mobile ? 184 : 260), height - (mobile ? 280 : 68), 'CHG', 'charge', mobile) : undefined;
        const shield = mobile && shieldEnabled ? this.makeTouchButton(width - 184, height - 282, 'SHIELD', 'shield', true) : undefined;
        if (mobile) {
            this.makeJoystick(height);
            const move = (pointer: Input.Pointer) => this.moveJoystick(pointer);
            scene.input.on('pointermove', move);
            this.cleanups.push(() => scene.input.off('pointermove', move));
        }
        this.cleanups.push(onLayoutResize(scene, () => {
            this.clearAll();
            const { width, height } = scene.scale;
            const y = height - (mobile ? 112 : 68);
            jump.button.setPosition(width - (mobile ? 264 : 174), y); jump.label.setPosition(jump.button.x, y);
            attack.button.setPosition(width - (mobile ? 102 : 70), y); attack.label.setPosition(attack.button.x, y);
            if (charge) { charge.button.setPosition(width - (mobile ? 184 : 260), height - (mobile ? 280 : 68)); charge.label.setPosition(charge.button.x, charge.button.y); }
            if (shield) { shield.button.setPosition(width - 184, height - 282); shield.label.setPosition(shield.button.x, shield.button.y); }
            if (this.joystick) {
                this.joystick.base.y = height - 126;
                this.joystick.thumb.setPosition(this.joystick.base.x, this.joystick.base.y);
            }
        }));

        const release = (pointer: Input.Pointer) => this.releasePointer(pointer);
        const leaveCanvas = () => this.releasePointer(scene.input.mousePointer);
        const rotate = () => this.clearAll();
        scene.input.on('pointerup', release);
        scene.input.on('pointerupoutside', release);
        scene.input.on('gameout', leaveCanvas);
        window.addEventListener('orientationchange', rotate);
        const orientation = window.screen?.orientation;
        orientation?.addEventListener('change', rotate);
        this.cleanups.push(() => {
            scene.input.off('pointerup', release);
            scene.input.off('pointerupoutside', release);
            scene.input.off('gameout', leaveCanvas);
            window.removeEventListener('orientationchange', rotate);
            orientation?.removeEventListener('change', rotate);
        });
        scene.events.once(Scenes.Events.SHUTDOWN, this.destroy, this);
    }

    readActions(): PlayerActions {
        if (!this.isPlaying()) return { left: false, right: false, jump: false, attack: false };
        const left = this.cursors.left.isDown || this.keys.A.isDown || this.touches.left.size > 0;
        const right = this.cursors.right.isDown || this.keys.D.isDown || this.touches.right.size > 0;
        const jump = this.cursors.up.isDown || this.cursors.space.isDown || this.keys.W.isDown || this.touches.jump.size > 0;
        const attack = this.keys.J.isDown || this.touches.attack.size > 0;
        return { left, right, jump, attack };
    }

    chargeHeld(): boolean {
        return this.isPlaying() && !this.shieldEnabled &&
            (this.keys.C.isDown || this.touches.charge.size > 0);
    }

    shieldHeld(): boolean {
        return this.isPlaying() && this.shieldEnabled && (this.keys.K.isDown || this.touches.shield.size > 0);
    }

    interactPressed(): boolean {
        return this.isPlaying() && Input.Keyboard.JustDown(this.keys.E);
    }

    restartPressed(): boolean {
        return Input.Keyboard.JustDown(this.keys.R);
    }

    menuPressed(): boolean {
        return Input.Keyboard.JustDown(this.keys.M);
    }

    upgradeChoice(): number | undefined {
        if (Input.Keyboard.JustDown(this.keys.ONE)) return 0;
        else if (Input.Keyboard.JustDown(this.keys.TWO)) return 1;
        else if (Input.Keyboard.JustDown(this.keys.THREE)) return 2;
        return undefined;
    }

    clearTouch(): void {
        for (const pointers of Object.values(this.touches)) pointers.clear();
        if (this.joystick) {
            this.joystick.pointerId = undefined;
            this.joystick.thumb.setPosition(this.joystick.base.x, this.joystick.base.y);
        }
    }

    clearAll(): void {
        this.clearTouch();
        this.scene.input.keyboard!.resetKeys();
    }

    private releasePointer(pointer: Input.Pointer): void {
        for (const pointers of Object.values(this.touches)) pointers.delete(pointer.id);
        if (this.joystick?.pointerId === pointer.id) {
            this.joystick.pointerId = undefined;
            this.joystick.thumb.setPosition(this.joystick.base.x, this.joystick.base.y);
        }
    }

    destroy(): void {
        this.scene.events.off(Scenes.Events.SHUTDOWN, this.destroy, this);
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        this.clearAll();
        // Phaser's scene KeyboardPlugin destroys its keys/listeners on shutdown.
    }

    private makeTouchButton(x: number, y: number, label: string,
        action: TouchAction, mobile = false) {
        const button = this.scene.add.circle(x, y, mobile ? 70 : 35, 0x25263f, 0.74).setDepth(30).setScrollFactor(0).setInteractive();
        if (action === 'shield') button.setStrokeStyle(3, 0xffdf7c);
        const text = this.scene.add.text(x, y, label, { fontSize: mobile ? '28px' : label.length > 2 ? '13px' : '25px', color: '#ffffff' })
            .setOrigin(0.5).setDepth(31).setScrollFactor(0);
        const press = (pointer: Input.Pointer) => {
            if (this.isPlaying()) this.touches[action].add(pointer.id);
        };
        const release = (pointer: Input.Pointer) => this.touches[action].delete(pointer.id);
        button.on('pointerdown', press);
        button.on('pointerup', release);
        button.on('pointerout', release);
        this.cleanups.push(() => {
            button.off('pointerdown', press);
            button.off('pointerup', release);
            button.off('pointerout', release);
        });
        return { button, label: text };
    }

    private makeJoystick(height: number): void {
        const base = this.scene.add.circle(128, height - 126, 96, 0x25263f, 0.65)
            .setStrokeStyle(3, 0xd6e4ec).setDepth(30).setScrollFactor(0).setInteractive();
        const thumb = this.scene.add.circle(base.x, base.y, 40, 0xe5f1f4, 0.85).setDepth(31).setScrollFactor(0);
        this.joystick = { base, thumb };
        const press = (pointer: Input.Pointer) => {
            if (!this.isPlaying() || this.joystick!.pointerId !== undefined) return;
            this.joystick!.pointerId = pointer.id;
            this.moveJoystick(pointer);
        };
        base.on('pointerdown', press);
        this.cleanups.push(() => base.off('pointerdown', press));
    }

    private moveJoystick(pointer: Input.Pointer): void {
        const stick = this.joystick;
        if (!stick || stick.pointerId !== pointer.id || !this.isPlaying()) return;
        const dx = pointer.x - stick.base.x;
        stick.thumb.x = stick.base.x + Math.max(-56, Math.min(56, dx));
        this.touches.left.delete(pointer.id);
        this.touches.right.delete(pointer.id);
        // Binary direction preserves the existing speed: no new acceleration or analogue multiplier.
        if (dx < -18) this.touches.left.add(pointer.id);
        if (dx > 18) this.touches.right.add(pointer.id);
    }

}
