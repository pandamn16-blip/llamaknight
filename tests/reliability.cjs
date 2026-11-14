// Focused Node checks for game transitions and systems, with a Phaser-shaped scene.
// Run: node tests/reliability.cjs. Real touch/layout checks still require a browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const EventEmitter = require('eventemitter3');
const orientation = Object.assign(new EventEmitter(), {
    matches: false,
    addEventListener(event, fn) { this.on(event, fn); },
    removeEventListener(event, fn) { this.off(event, fn); }
});
const screenOrientation = Object.assign(new EventEmitter(), {
    addEventListener(event, fn) { this.on(event, fn); },
    removeEventListener(event, fn) { this.off(event, fn); }
});
let mobileLayout = false;
const windowStub = Object.assign(new EventEmitter(), {
    matchMedia: query => query === '(orientation: portrait)' ? orientation : { matches: mobileLayout }, screen: { orientation: screenOrientation },
    addEventListener(event, fn) { this.on(event, fn); },
    removeEventListener(event, fn) { this.off(event, fn); }
});
const parentElement = {};
const documentStub = { hidden: false, hasFocus: () => true, getElementById: () => parentElement };
const observers = [];
class ResizeObserverStub {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
}
const phaser = {
    Scene: class {},
    AUTO: 0, Scale: { FIT: 3, CENTER_BOTH: 1 },
    Game: class {
        constructor(config) {
            this.config = config; this.events = new EventEmitter(); this.isBooted = true;
            this.refreshes = 0; this.scale = { width: config.width, height: config.height, refresh: () => this.refreshes++, getParentBounds() {}, setGameSize: (width, height) => { this.scale.width = width; this.scale.height = height; } };
        }
    },
    Input: { Keyboard: { JustDown(key) { const value = key._justDown; key._justDown = false; return value; } } },
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
    Core: { Events: { BLUR: 'blur', FOCUS: 'focus', HIDDEN: 'hidden', VISIBLE: 'visible', DESTROY: 'destroy' } },
    Math: { Between: (min, max) => Math.floor((min + max) / 2), Clamp: (value, min, max) => Math.max(min, Math.min(max, value)) },
    Utils: { Array: { GetRandom: values => values[0], Shuffle: values => values } }
};
const cache = new Map();
function load(name, baseUrl = '/') {
    const cacheKey = `${baseUrl}:${name}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const exports = {};
    const source = fs.readFileSync(path.join(__dirname, '../src/game', `${name}.ts`), 'utf8');
    // Vite replaces this expression at build time; emulate it in the CommonJS VM.
    const code = ts.transpileModule(source.replaceAll('import.meta.env.BASE_URL', JSON.stringify(baseUrl)).replaceAll('import.meta.env.DEV', 'true'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    vm.runInNewContext(code, {
        exports, document: documentStub, window: windowStub, ResizeObserver: ResizeObserverStub,
        require(dep) {
            if (dep === 'phaser') return phaser;
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), dep));
            if (target === 'ui/UpgradePanel') return { createUpgradePanel: () => ({ destroy() {} }) };
            if (target === 'ui/GameOverPanel') return { createGameOverPanel() {} };
            return load(target, baseUrl);
        }
    });
    cache.set(cacheKey, exports);
    return exports;
}
const { createRunState } = load('state/RunState');
const { WORLD } = load('config/world');
const { WorldCamera } = load('world/WorldCamera');
const { WorldSystem } = load('world/WorldSystem');
const { breadPlacementId, generateSection, sectionSeed } = load('world/sections');
const { Game } = load('scenes/Game');
const { EnemySystem } = load('systems/EnemySystem');
const { CombatSystem } = load('systems/CombatSystem');
const { StructureSystem } = load('systems/StructureSystem');
const { HealthPickupSystem } = load('systems/HealthPickupSystem');
const { STRUCTURES } = load('config/structures');
const { RewardNotice } = load('ui/RewardNotice');
const { XpSystem } = load('systems/XpSystem');
const { Rosie } = load('world/Rosie');

function fixture(characterId = 'llamaCrunch') {
    const game = new Game();
    const objects = [], timers = [], tweens = [];
    function shape(kind, x, y, ...args) {
        const item = Object.assign(new EventEmitter(), {
            kind, x, y, scaleX: 1, scaleY: 1, args, active: true, alpha: 1, children: [], text: args[0], textChanges: 0,
            fillStyle() { return this; }, beginPath() { return this; }, moveTo() { return this; },
            arc() { return this; }, lineTo() { return this; }, closePath() { return this; }, fillPath() { return this; },
            setScrollFactor(x, y = x, updateChildren = false) {
                this.scrollFactorX = x; this.scrollFactorY = y;
                // Phaser 4 Container uses SetAll, which only sets existing own properties.
                if (updateChildren) this.children.forEach(child => {
                    if (Object.hasOwn(child, 'scrollFactorX')) child.scrollFactorX = x;
                    if (Object.hasOwn(child, 'scrollFactorY')) child.scrollFactorY = y;
                });
                return this;
            },
            setVisible(value) { this.visible = value; return this; },
            setDepth() { return this; }, setStrokeStyle() { return this; },
            setPosition(x, y) { this.x = x; this.y = y; return this; },
            setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; },
            setFontSize(size) { this.fontSize = size; return this; },
            removeAll(destroy) { if (destroy) this.children.forEach(child => child.destroy()); this.children = []; this.list = this.children; return this; },
            setAngle() { return this; }, setOrigin() { return this; }, setInteractive() { return this; },
            add(children) { this.children.push(...[].concat(children)); this.list = this.children; return this; },
            setAlpha(value) { this.alpha = value; return this; },
            setText(value) { this.text = value; this.textChanges++; return this; },
            destroy() { if (!this.active) return; this.active = false; this.emit('destroy'); this.removeAllListeners(); this.children.forEach(child => child.destroy()); }
        });
        objects.push(item);
        return item;
    }
    game.scale = Object.assign(new EventEmitter(), { width: 1024, height: 768 });
    game.events = new EventEmitter();
    game.game = { events: new EventEmitter() };
    game.transitions = [];
    game.scene = { restart(data) { game.transitions.push(['restart', data]); }, start(key, data) { game.transitions.push(['start', key, data]); } };
    game.add = Object.fromEntries(['container', 'rectangle', 'circle', 'ellipse', 'text', 'image', 'graphics'].map(kind => [kind, (...args) => shape(kind, ...args)]));
    game.time = {
        now: 0, paused: false,
        delayedCall(delay, callback) { return this.addEvent({ delay, callback }); },
        addEvent(config) {
            const timer = { ...config, elapsed: 0, removed: false, remove() { this.removed = true; } };
            timers.push(timer);
            return timer;
        }
    };
    game.tweens = {
        paused: false, timeScale: 1, pauseAll() { this.paused = true; }, resumeAll() { this.paused = false; },
        add(config) {
            const tween = { config, elapsed: 0, removed: false, remove() { this.removed = true; } };
            tweens.push(tween);
            return tween;
        }
    };
    game.cameras = { main: { width: 1024, height: 768, scrollX: 0, scrollY: 0,
        setBounds(x, y, width, height) { this.bounds = { x, y, width, height }; return this; },
        setScroll(x, y) { this.scrollX = x; this.scrollY = y; return this; },
        setBackgroundColor() {}, shakeEffect: { isRunning: false }, shake() { this.shakeEffect.isRunning = true; } } };
    game.groundY = 768 * 0.78;
    game.run = createRunState(characterId);
    game.player = { facing: 1, x: 300, y: game.groundY - 40, sprite: shape('player', 300, game.groundY - 40), update() {}, setShielding(held) { game.run.shielding = held; }, showAttack() {}, showHurt() {}, showDeath() {}, showLevelUp() {}, showCharge() {}, endCharge() {}, setVisualPhase() {} };
    game.run.startX = game.run.furthestX = game.player.x;
    game.playerInput = {
        clearTouch() {}, clearAll() {}, readActions: () => ({ left: false, right: false, jump: false, attack: false }),
        shieldHeld: () => false, chargeHeld: () => false, interactPressed: () => false, restartPressed: () => false, menuPressed: () => false, upgradeChoice: () => undefined
    };
    game.hud = { update() {} };
    game.worldCamera = new WorldCamera(game.cameras.main, game.scale.height);
    game.world = new WorldSystem(game, game.run.seed, game.groundY);
    game.enemySystem = new EnemySystem(game, game.run, game.groundY);
    game.xpSystem = new XpSystem(game, game.run, game.player, () => game.openLevelUp(), () => game.updateHud());
    game.healthPickups = new HealthPickupSystem(game, game.run, game.player, () => game.updateHud());
    game.rewardNotice = new RewardNotice(game);
    game.structures = new StructureSystem(game, game.run, game.groundY, (placement, x, y) => {
        game.xpSystem.dropGem(x, y, STRUCTURES.crate.xp);
        if (placement.healthDrop) game.healthPickups.drop(`${placement.id}:health`, x, y);
    }, game.player, reward => game.claimChestReward(reward));
    game.combatSystem = new CombatSystem(game, game.run, game.player, game.enemySystem,
        (x, y) => game.xpSystem.dropGem(x, y), () => game.endGame(), () => game.updateHud(), () => game.rosie.speak('damage'), game.structures);
    const rosie = new Rosie(game, game.run);
    game.rosie = rosie;
    function advance(ms) {
        game.time.now += ms;
        if (!game.time.paused) for (const timer of [...timers]) {
            if (timer.removed) continue;
            timer.elapsed += ms;
            if (timer.elapsed >= timer.delay) {
                if (timer.loop) timer.elapsed -= timer.delay;
                else timer.removed = true;
                timer.callback();
            }
        }
        if (!game.tweens.paused && game.tweens.timeScale > 0) for (const tween of tweens) {
            if (tween.removed) continue;
            tween.elapsed += ms;
            if (tween.elapsed >= tween.config.duration * (tween.config.yoyo ? 2 : 1) * ((tween.config.repeat || 0) + 1)) {
                tween.removed = true;
                tween.config.onComplete();
            }
        }
    }
    return { game, objects, timers, tweens, rosie, advance };
}

// Pause keeps simulation, cooldowns, timers, feedback and dialogue frozen.
{
    const { game: g, rosie, advance } = fixture();
    g.enemySystem.spawnBread();
    const enemy = g.enemySystem.enemies[0];
    enemy.hp = 3; enemy.sprite.x = g.player.x + 50; enemy.sprite.y = g.player.y;
    g.combatSystem.attack();
    assert.equal(enemy.hp, 1);
    advance(40);
    g.run.xp = 3;
    g.xpSystem.checkLevelUp();
    assert.equal(g.run.phase, 'choosingUpgrade');
    const dialogueChanges = rosie.speech.textChanges;
    assert.equal(g.time.paused, true);
    assert.equal(g.tweens.timeScale, 0);
    const snapshot = JSON.stringify(g.run), x = enemy.sprite.x;
    advance(10000);
    g.update(10000, 16);
    g.enemySystem.update(1, () => assert.fail('contact while frozen'));
    g.combatSystem.attack();
    g.xpSystem.update(1);
    assert.equal(JSON.stringify(g.run), snapshot);
    assert.equal(enemy.sprite.x, x);
    assert.equal(enemy.sprite.alpha, 0.5);
    assert.equal(rosie.speech.textChanges, dialogueChanges);
    g.chooseUpgrade(0);
    assert.equal(g.run.phase, 'playing');
    advance(59); assert.equal(enemy.sprite.alpha, 0.5);
    advance(1); assert.equal(enemy.sprite.alpha, 1);
    g.run.runTime = 0.499;
    g.combatSystem.attack(); assert.equal(enemy.hp, 1);
    g.run.runTime = 0.500;
    g.combatSystem.attack(); assert.equal(g.run.kills, 1);
    advance(WORLD.rosieDialogueInterval - 60); assert.equal(rosie.speech.textChanges, dialogueChanges + 1);
}

// Fatal contact stops the enemy loop and prevents XP/level-up processing that frame.
{
    const { game: g } = fixture();
    g.run.health = 1; g.enemySystem.player = g.player;
    g.enemySystem.spawnBread(); g.enemySystem.spawnBread(WORLD.enemyStartX + WORLD.enemySpacing);
    for (const enemy of g.enemySystem.enemies) {
        enemy.sprite.x = g.player.x; enemy.sprite.y = g.player.y;
        enemy.brain.state = 'active'; enemy.brain.remaining = 0.1;
    }
    const untouched = g.enemySystem.enemies[0];
    g.xpSystem.dropGem(g.player.x, g.player.y);
    g.run.xp = 2;
    g.update(16, 16);
    assert.equal(g.run.phase, 'gameOver');
    assert.equal(g.run.health, 0);
    assert.equal(g.run.xp, 2);
    assert.equal(g.run.level, 1);
    assert.equal(g.xpSystem.gems.length, 1);
    assert.equal(untouched.sprite.x, g.player.x);
    const snapshot = JSON.stringify(g.run);
    g.combatSystem.resolveEnemyAttack(untouched); g.combatSystem.attack(); g.xpSystem.checkLevelUp();
    g.update(32, 16);
    assert.equal(JSON.stringify(g.run), snapshot);
}

// Nested interruption restores the upgrade screen and removes game-level listeners.
{
    const { game: g } = fixture();
    g.bindPauseEvents();
    g.run.xp = 3; g.xpSystem.checkLevelUp();
    g.game.events.emit('blur'); g.game.events.emit('hidden');
    assert.equal(g.run.phase, 'paused');
    g.game.events.emit('focus'); assert.equal(g.run.phase, 'paused');
    g.game.events.emit('visible'); assert.equal(g.run.phase, 'choosingUpgrade');
    assert.equal(g.time.paused, true);
    g.chooseUpgrade(1); assert.equal(g.run.phase, 'playing');
    g.events.emit('shutdown');
    assert.equal(g.game.events.eventNames().length, 0);
    assert.equal(g.events.listenerCount('shutdown'), 0);
}

// Clean restart defaults; no remaining system callbacks or objects after shutdown.
for (let cycle = 0; cycle < 10; cycle++) {
    const { game: g, timers, tweens, advance } = fixture();
    g.enemySystem.spawnBread();
    const enemy = g.enemySystem.enemies[0];
    enemy.hp = 3; enemy.sprite.x = g.player.x + 20; enemy.sprite.y = g.player.y;
    g.combatSystem.attack(); enemy.brain.state = 'active'; enemy.brain.remaining = 0.1; g.combatSystem.resolveEnemyAttack(enemy);
    g.xpSystem.dropGem(500, 400);
    g.events.emit('shutdown');
    assert.equal(g.enemySystem.enemies.length, 0);
    assert.equal(g.xpSystem.gems.length, 0);
    assert.ok(timers.every(timer => timer.removed));
    assert.ok(tweens.every(tween => tween.removed));
    const fresh = createRunState();
    assert.equal(fresh.phase, 'playing'); assert.equal(fresh.runTime, 0);
    assert.equal(fresh.health, 6); assert.equal(fresh.weapon.lastAttack, -1000);
    const snapshot = JSON.stringify(g.run); advance(10000);
    assert.equal(JSON.stringify(g.run), snapshot);
}
console.log('PASS Step A: pause/resume, cooldown/timer preservation, fatal-frame cutoff, nested interruption, fresh runs and shutdown cleanup.');

// Portrait blocks gameplay; returning to landscape preserves the upgrade screen.
{
    const { game: g } = fixture();
    g.bindPauseEvents();
    g.run.xp = 3; g.xpSystem.checkLevelUp();
    orientation.matches = true; orientation.emit('change');
    assert.equal(g.run.phase, 'paused');
    const snapshot = JSON.stringify(g.run);
    g.update(1000, 1000);
    g.chooseUpgrade(0);
    assert.equal(JSON.stringify(g.run), snapshot);
    g.game.events.emit('blur');
    orientation.matches = false; orientation.emit('change');
    assert.equal(g.run.phase, 'paused');
    g.game.events.emit('focus');
    assert.equal(g.run.phase, 'choosingUpgrade');
    g.events.emit('shutdown');
    assert.equal(orientation.listenerCount('change'), 0);
}
console.log('PASS Step B: portrait pause, nested focus/orientation interruptions, upgrade preservation and orientation listener cleanup.');

// Independent fingers, keyboard parity, cancellation, interruption and cleanup.
const { PlayerInput } = load('input/PlayerInput');
for (let cycle = 0; cycle < 10; cycle++) {
    const { game: g, objects } = fixture();
    const allKeys = [];
    function key() {
        const value = { isDown: false, _justDown: false, reset() { this.isDown = false; this._justDown = false; } };
        allKeys.push(value);
        return value;
    }
    g.input = Object.assign(new EventEmitter(), {
        mousePointer: { id: 0 },
        keyboard: {
            createCursorKeys: () => Object.fromEntries(['left', 'right', 'up', 'down', 'space', 'shift'].map(name => [name, key()])),
            addKeys: names => Object.fromEntries(names.split(',').map(name => [name, key()])),
            addCapture() {}, resetKeys() { allKeys.forEach(value => value.reset()); }
        }
    });
    const input = new PlayerInput(g, () => g.run.phase === 'playing');
    g.playerInput = input;
    g.bindPauseEvents();
    const [left, right, jump, attack] = objects.filter(object => object.kind === 'circle' && object.eventNames().includes('pointerdown'));
    const p1 = { id: 1 }, p2 = { id: 2 }, p3 = { id: 3 }, p4 = { id: 4 };
    left.emit('pointerdown', p1); jump.emit('pointerdown', p2); attack.emit('pointerdown', p3);
    assert.equal(input.readActions().left, true);
    assert.equal(input.readActions().jump, true);
    assert.equal(input.readActions().attack, true);
    g.input.emit('pointerup', p2);
    assert.equal(input.readActions().jump, false);
    assert.equal(input.readActions().left, true);
    assert.equal(input.readActions().attack, true);
    left.emit('pointerdown', p4); left.emit('pointerout', p1);
    assert.equal(input.readActions().left, true);
    g.input.emit('pointerupoutside', p4);
    assert.equal(input.readActions().left, false);
    assert.equal(input.readActions().attack, true);
    right.emit('pointerdown', { id: 0 });
    g.input.emit('gameout');
    assert.equal(input.readActions().right, false);
    assert.equal(input.readActions().attack, true);
    g.input.emit('pointerupoutside', p3);
    assert.equal(input.readActions().attack, false);
    // A touch tap can begin and end between two gameplay frames.
    attack.emit('pointerdown', p3);
    attack.emit('pointerup', p3);
    assert.equal(input.readActions().attack, true);
    assert.equal(input.readActions().attack, false);
    // Every original keyboard alias and edge-triggered menu key remains available.
    for (const [value, action] of [
        [input.cursors.left, 'left'], [input.keys.A, 'left'],
        [input.cursors.right, 'right'], [input.keys.D, 'right'],
        [input.cursors.up, 'jump'], [input.cursors.space, 'jump'], [input.keys.W, 'jump'], [input.keys.J, 'attack']
    ]) {
        value.isDown = true; assert.equal(input.readActions()[action], true);
        value.isDown = false; assert.equal(input.readActions()[action], false);
    }
    input.keys.R._justDown = true;
    assert.equal(input.restartPressed(), true); assert.equal(input.restartPressed(), false);
    for (const [name, index] of [['ONE', 0], ['TWO', 1], ['THREE', 2]]) {
        input.keys[name]._justDown = true;
        assert.equal(input.upgradeChoice(), index); assert.equal(input.upgradeChoice(), undefined);
    }
    left.emit('pointerdown', p1); input.keys.J.isDown = true;
    g.game.events.emit('blur');
    assert.equal(g.run.phase, 'paused'); assert.equal(input.keys.J.isDown, false);
    g.game.events.emit('focus');
    assert.equal(input.readActions().left, false); assert.equal(input.readActions().attack, false);
    for (const [target, event] of [[windowStub, 'orientationchange'], [screenOrientation, 'change']]) {
        left.emit('pointerdown', p1); input.keys.J.isDown = true;
        target.emit(event);
        assert.equal(input.readActions().left, false); assert.equal(input.keys.J.isDown, false);
    }
    g.run.xp = g.xpSystem.xpNeeded(); g.xpSystem.checkLevelUp();
    left.emit('pointerdown', p1); attack.emit('pointerdown', p2);
    g.chooseUpgrade(0);
    assert.equal(input.readActions().left, false); assert.equal(input.readActions().attack, false);
    g.events.emit('shutdown');
    assert.equal(g.input.eventNames().length, 0);
    assert.equal(g.game.events.eventNames().length, 0);
    assert.equal(windowStub.eventNames().length, 0);
    assert.equal(screenOrientation.eventNames().length, 0);
    assert.equal(orientation.eventNames().length, 0);
    for (const button of [left, right, jump, attack]) assert.equal(button.eventNames().length, 0);
}
console.log('PASS Step C: independent simultaneous fingers, per-pointer release/cancel/out, keyboard parity, focus/rotation resets, modal gating and 10 listener-cleanup cycles.');

// The browser host only scales the canvas; logical coordinates stay fixed.
{
    const startGame = load('main').default;
    const engine = startGame('game-container');
    assert.equal(engine.config.width, 1024); assert.equal(engine.config.height, 768);
    assert.equal(engine.config.scale.mode, phaser.Scale.FIT);
    assert.equal(engine.config.scale.autoCenter, phaser.Scale.CENTER_BOTH);
    assert.equal(engine.config.input.activePointers, 4);
    assert.equal(engine.config.fps.smoothStep, false); // No 120-frame startup simulation clamp.
    const observer = observers.at(-1);
    assert.equal(observer.element, parentElement);
    observer.callback(); assert.equal(engine.refreshes, 1);
    assert.equal(engine.config.width, 1024); assert.equal(engine.config.height, 768);
    engine.events.emit('destroy'); assert.equal(observer.disconnected, true);
}
console.log('PASS browser host configuration: fixed coordinates, FIT scaling, four touch pointers and resize-observer cleanup.');

// Every Phaser scene loader inherits Vite's deployment base, including public assets.
for (const base of ['./', '/llamaknight/']) {
    const engine = load('main', base).default('game-container');
    assert.equal(engine.config.loader.baseURL, base);
    const { Boot } = load('scenes/Boot', base);
    const { Preloader } = load('scenes/Preloader', base);
    const requests = [];
    const loader = {
        path: '',
        setPath(value) { this.path = value.endsWith('/') ? value : `${value}/`; return this; },
        image(key, file) { requests.push({ key, url: `${engine.config.loader.baseURL}${this.path}${file}` }); },
        spritesheet(key, file) { this.image(key, file); }
    };
    const boot = new Boot(); boot.load = loader; boot.preload();
    const preloader = new Preloader(); preloader.load = loader; preloader.preload();
    const origin = 'https://ianswebsolutions.com/';
    const expected = base === './' ? '/assets/' : '/llamaknight/assets/';
    assert.ok(requests.length >= 7);
    for (const request of requests) {
        const url = new URL(request.url, origin);
        assert.ok(url.pathname.startsWith(expected), `${request.key}: ${url.pathname}`);
        assert.ok(fs.existsSync(path.join(__dirname, '../public/assets', url.pathname.slice(expected.length))));
    }
    engine.events.emit('destroy');
}
console.log('PASS deployment paths: localhost and GitHub Pages Boot, logo, character sheets and sword effect requests.');

const { CHARACTERS } = load('characters/definitions');
const { WEAPONS } = load('weapons/definitions');
const { applyUpgrade } = load('systems/applyUpgrade');
const { Player } = load('entities/Player');
const { getRosieLine } = load('dialogue/rosieDialogue');

// Starting stats, shared jumping, distinguishable visuals, per-run weapon stats.
for (const characterId of ['llamaCrunch', 'candy']) {
    const character = CHARACTERS[characterId];
    assert.equal(character.health, characterId === 'candy' ? 4 : 6);
    assert.equal(character.moveSpeed, characterId === 'candy' ? 350 : 280);
    const { game: g } = fixture(characterId);
    const definition = WEAPONS[character.startingWeapon];
    assert.equal(g.run.health, character.health);
    assert.equal(g.run.moveSpeed, character.moveSpeed);
    assert.equal(g.run.weapon.id, character.startingWeapon);
    assert.equal(g.run.weapon.cooldown, definition.cooldown);
    const player = new Player(g, g.run, g.groundY);
    const start = player.x;
    player.update({ left: false, right: true, jump: true }, 0.05);
    assert.equal(player.x, start + character.moveSpeed * 0.05);
    assert.equal(g.run.velocityY, -570);
    assert.equal(player.y, g.groundY - 40 - 28.5);
    assert.equal(player.sprite.children.length, characterId === 'candy' ? 11 : 7);
    for (let i = 0; i < 100; i++) player.update({ left: false, right: true, jump: false }, 0.05);
    assert.equal(player.x, start + character.moveSpeed * 0.05 * 101);
    assert.equal(player.y, g.groundY - 40);
    for (const id of ['power', 'speed', 'range', 'heart', 'magnet', 'stride']) {
        const state = createRunState(characterId);
        const original = JSON.parse(JSON.stringify(state));
        state.health = 1;
        applyUpgrade(state, id);
        if (id === 'power') assert.equal(state.weapon.damage, definition.damage + 1);
        if (id === 'speed') assert.equal(state.weapon.cooldown, Math.round(definition.cooldown * 0.85));
        if (id === 'range') assert.equal(state.weapon.range, definition.range + 20);
        if (id === 'heart') { assert.equal(state.maxHealth, character.health + 1); assert.equal(state.health, 3); }
        if (id === 'magnet') assert.equal(state.magnetRadius, original.magnetRadius + 45);
        if (id === 'stride') assert.equal(state.moveSpeed, character.moveSpeed * 1.12);
        assert.equal(WEAPONS[character.startingWeapon].damage, definition.damage);
        const fresh = createRunState(characterId, original.seed);
        assert.equal(JSON.stringify(fresh), JSON.stringify(original));
        assert.notEqual(state.weapon, fresh.weapon);
    }
    const fast = createRunState(characterId);
    for (let i = 0; i < 40; i++) applyUpgrade(fast, 'speed');
    assert.equal(fast.weapon.cooldown, 120);
}
console.log('PASS characters: exact starting stats, independent weapon state, shared movement/gravity, distinct visuals and all six upgrades for both heroes.');

// Ranged attacks hit the nearest enemy once, use the same kill/XP path, and respect cooldowns.
{
    const { game: g } = fixture('candy');
    for (const x of [650, 500]) {
        g.enemySystem.spawnBread(WORLD.enemyStartX + g.enemySystem.enemies.length * WORLD.enemySpacing);
        const enemy = g.enemySystem.enemies.at(-1);
        enemy.sprite.x = x; enemy.sprite.y = g.player.y; enemy.hp = 1;
    }
    const far = g.enemySystem.enemies[0];
    g.combatSystem.attack();
    assert.equal(g.combatSystem.projectiles.length, 1);
    g.combatSystem.update(0.3);
    assert.equal(g.run.kills, 1); assert.equal(g.enemySystem.enemies.length, 1);
    assert.equal(g.enemySystem.enemies[0], far);
    assert.equal(g.xpSystem.gems.length, 1);
    assert.equal(g.combatSystem.projectiles.length, 0);
    g.run.runTime = 0.899; g.combatSystem.attack();
    assert.equal(g.combatSystem.projectiles.length, 0);
    g.run.runTime = 0.900; g.combatSystem.attack();
    assert.equal(g.combatSystem.projectiles.length, 1);
    g.combatSystem.update(0.8); // Swept collision cannot skip the enemy at large steps.
    assert.equal(g.run.kills, 2);
    assert.equal(g.xpSystem.gems.length, 2);
    // Dropped XP stays at its world position; walk to it instead of waiting for scrolling.
    for (const x of [500, 650]) {
        g.player.x = x;
        for (let frame = 0; frame < 30; frame++) g.xpSystem.update(0.05);
    }
    assert.equal(g.run.xp, 2);
    g.xpSystem.dropGem(g.player.x, g.player.y);
    g.xpSystem.update(0.05);
    assert.equal(g.run.level, 2); assert.equal(g.run.phase, 'choosingUpgrade');
    g.chooseUpgrade(0);
    assert.equal(g.run.weapon.damage, 2);
}

// Projectiles freeze with the run and expire at range, on death, or on shutdown.
{
    const { game: g } = fixture('candy');
    g.combatSystem.attack();
    const shot = g.combatSystem.projectiles[0];
    const x = shot.sprite.x;
    g.run.xp = 3; g.xpSystem.checkLevelUp();
    g.combatSystem.update(10); g.combatSystem.attack();
    assert.equal(shot.sprite.x, x); assert.equal(g.combatSystem.projectiles.length, 1);
    g.chooseUpgrade(0);
    g.combatSystem.update(0.05);
    assert.equal(shot.sprite.x, x + 32.5);
    for (let frame = 0; frame < 30; frame++) g.combatSystem.update(0.05);
    assert.equal(g.combatSystem.projectiles.length, 0); assert.equal(shot.sprite.active, false);
    g.run.runTime = 1; g.combatSystem.attack();
    const finalShot = g.combatSystem.projectiles[0];
    g.endGame();
    g.combatSystem.update(1);
    assert.equal(finalShot.sprite.x, g.player.x + 30);
    g.events.emit('shutdown');
    assert.equal(g.combatSystem.projectiles.length, 0); assert.equal(finalShot.sprite.active, false);
}

// Shots snapshot upgraded stats at firing, stop on a hit, and miss enemies below a jump.
{
    const { game: g, advance } = fixture('candy');
    applyUpgrade(g.run, 'power'); applyUpgrade(g.run, 'range');
    g.enemySystem.spawnBread();
    const enemy = g.enemySystem.enemies[0];
    enemy.hp = 3; enemy.sprite.x = 450; enemy.sprite.y = g.player.y;
    g.combatSystem.attack();
    assert.equal(g.combatSystem.projectiles[0].damage, 2);
    assert.equal(g.combatSystem.projectiles[0].remaining, 670);
    g.combatSystem.update(0.2);
    assert.equal(enemy.hp, 1); assert.equal(enemy.sprite.alpha, 0.5);
    advance(100); assert.equal(enemy.sprite.alpha, 1);
    g.run.runTime = 1; g.player.y -= 150; g.combatSystem.attack();
    for (let i = 0; i < 30; i++) g.combatSystem.update(0.05);
    assert.equal(enemy.hp, 1); assert.equal(g.combatSystem.projectiles.length, 0);
}
console.log('PASS weapons: swept/nearest projectile hits, single-hit shots, cooldowns, shared kill/XP/level-up flow, upgrades, pause, range expiry, jumping misses and cleanup.');

// Character-specific dialogue covers each event and does not tick through a pause.
for (const characterId of ['llamaCrunch', 'candy']) {
    const { game: g, rosie, advance } = fixture(characterId);
    assert.equal(rosie.speech.text, getRosieLine({ characterId, event: 'start' }));
    g.enemySystem.spawnBread();
    const enemy = g.enemySystem.enemies[0];
    enemy.sprite.x = g.player.x; enemy.sprite.y = g.player.y;
    enemy.brain.state = 'active'; enemy.brain.remaining = 0.1; g.combatSystem.resolveEnemyAttack(enemy);
    assert.equal(rosie.speech.text, getRosieLine({ characterId, event: 'damage' }));
    g.run.xp = 3; g.xpSystem.checkLevelUp();
    const levelLine = getRosieLine({ characterId, event: 'levelUp' });
    assert.equal(rosie.speech.text, levelLine);
    advance(10000); assert.equal(rosie.speech.text, levelLine);
    g.chooseUpgrade(0);
    g.run.health = 1; g.run.runTime = 1;
    enemy.brain.state = 'active'; enemy.brain.remaining = 0.1; g.combatSystem.resolveEnemyAttack(enemy);
    assert.equal(g.run.phase, 'gameOver');
    assert.equal(rosie.speech.text, getRosieLine({ characterId, event: 'death' }));
    advance(10000);
    assert.equal(rosie.speech.text, getRosieLine({ characterId, event: 'death' }));
    g.events.emit('shutdown');
}
assert.notEqual(getRosieLine({ characterId: 'candy', event: 'start' }), getRosieLine({ characterId: 'llamaCrunch', event: 'start' }));
console.log('PASS dialogue: character-specific start/damage/level/death events, priority on fatal damage, paused taunts and timer cleanup.');

function installKeyboard(scene) {
    const keys = [];
    const key = () => {
        const value = { isDown: false, _justDown: false, reset() { this.isDown = false; this._justDown = false; } };
        keys.push(value); return value;
    };
    scene.input = Object.assign(new EventEmitter(), { mousePointer: { id: 0 }, keyboard: {
        addKeys: names => Object.fromEntries(names.split(',').map(name => [name, key()])),
        createCursorKeys: () => Object.fromEntries(['left', 'right', 'up', 'down', 'space', 'shift'].map(name => [name, key()])),
        addCapture() {}, resetKeys() { keys.forEach(value => value.reset()); }
    } });
}

// Real create/init and restart routing use the selected hero, with no upgraded state reused.
for (const characterId of ['llamaCrunch', 'candy']) {
    const { game: g } = fixture();
    g.events.emit('shutdown'); // Remove the fixture's initial scene before a fresh create.
    installKeyboard(g);
    g.init({ characterId }); g.create();
    assert.equal(g.run.characterId, characterId);
    assert.equal(g.run.health, CHARACTERS[characterId].health);
    assert.equal(g.run.weapon.id, CHARACTERS[characterId].startingWeapon);
    applyUpgrade(g.run, 'power'); g.endGame(); g.restartRun();
    assert.equal(JSON.stringify(g.transitions.at(-1)), JSON.stringify(['restart', { characterId }]));
    const data = g.transitions.at(-1)[1];
    g.events.emit('shutdown'); g.init(data); g.create();
    assert.equal(g.run.characterId, characterId); assert.equal(g.run.weapon.damage, WEAPONS[CHARACTERS[characterId].startingWeapon].damage);
    g.endGame(); g.returnToMenu();
    assert.equal(JSON.stringify(g.transitions.at(-1)), JSON.stringify(['start', 'MainMenu', undefined]));
    g.events.emit('shutdown');
    g.init({ characterId: '__proto__' }); assert.equal(g.selectedCharacter, 'llamaCrunch');
}

// Selection supports pointer, arrow/confirm, direct number keys, back and duplicate-start guarding.
const { CharacterSelect } = load('scenes/CharacterSelect');
for (const method of ['pointer', 'keyboard', 'direct']) {
    const { game: host, objects } = fixture();
    const select = new CharacterSelect();
    Object.assign(select, { add: host.add, cameras: host.cameras, scene: host.scene, scale: host.scale, events: host.events });
    installKeyboard(select); select.create();
    if (method === 'pointer') {
        const cards = objects.filter(object => object.kind === 'rectangle' && object.eventNames().includes('pointerdown'));
        cards[1].emit('pointerdown');
    } else if (method === 'keyboard') {
        select.keys.RIGHT._justDown = true; select.update();
        select.keys.ENTER._justDown = true; select.update();
    } else { select.keys.TWO._justDown = true; select.update(); }
    assert.equal(JSON.stringify(host.transitions.at(-1)), JSON.stringify(['start', 'Game', { characterId: 'candy' }]));
    const count = host.transitions.length; select.startRun(0);
    assert.equal(host.transitions.length, count);
    select.create(); // Returning to the screen allows a fresh choice.
    select.keys.ONE._justDown = true; select.update();
    assert.equal(host.transitions.at(-1)[2].characterId, 'llamaCrunch');
    select.create(); orientation.matches = true; select.startRun(1); orientation.matches = false;
    assert.equal(select.starting, false);
    select.keys.ESC._justDown = true; select.update();
    assert.equal(host.transitions.at(-1)[1], 'MainMenu');
    host.events.emit('shutdown');
}
console.log('PASS selection: mouse/touch cards, keyboard navigation/direct choice, duplicate-start guard, real scene initialization, same-character restarts, menu return and re-selection.');

// Focused weapon balance: sector hits every eligible enemy exactly once per swing.
{
    const { game: g, advance } = fixture('llamaCrunch');
    assert.equal(g.run.weapon.id, 'swordSlash');
    assert.equal(WEAPONS.swordSlash.name, 'Sword Slash');
    assert.equal(g.run.weapon.damage, 2);
    assert.equal(g.run.weapon.cooldown, 500);
    assert.equal(g.run.weapon.range, 115);
    const positions = [
        [30, 0, true], [80, 30, true], [50, -40, true],
        [-10, 0, false], [10, 40, false], [116, 0, false], [100, 60, false]
    ];
    const enemies = positions.map(([dx, dy]) => {
        g.enemySystem.spawnBread(WORLD.enemyStartX + g.enemySystem.enemies.length * WORLD.enemySpacing);
        const enemy = g.enemySystem.enemies.at(-1);
        enemy.sprite.x = g.player.x + dx; enemy.sprite.y = g.player.y + dy; enemy.hp = 7;
        return enemy;
    });
    g.combatSystem.attack();
    const firstSlash = [...g.combatSystem.slashes][0];
    assert.ok(firstSlash.children.some(child => child.kind === 'graphics'));
    positions.forEach(([, , hit], index) => assert.equal(enemies[index].hp, hit ? 5 : 7));
    // Neither holding attack within the cooldown nor updating the visual causes another hit.
    for (const elapsed of [0.016, 0.100, 0.300, 0.499]) {
        g.run.runTime = elapsed;
        g.combatSystem.attack(); g.combatSystem.update(0.016);
        positions.forEach(([, , hit], index) => assert.equal(enemies[index].hp, hit ? 5 : 7));
    }
    assert.equal(g.combatSystem.slashes.size, 1);
    advance(170); assert.equal(firstSlash.active, false);
    g.run.runTime = 0.500; g.combatSystem.attack();
    positions.forEach(([, , hit], index) => assert.equal(enemies[index].hp, hit ? 3 : 7));
    g.events.emit('shutdown');
    assert.equal(g.combatSystem.slashes.size, 0);
}

// Multi-kill sword swings award one gem per enemy and feed the unchanged XP/upgrade flow.
{
    const { game: g } = fixture('llamaCrunch');
    for (const dx of [25, 35, 45]) {
        g.enemySystem.spawnBread(WORLD.enemyStartX + g.enemySystem.enemies.length * WORLD.enemySpacing);
        const enemy = g.enemySystem.enemies.at(-1);
        enemy.sprite.x = g.player.x + dx; enemy.sprite.y = g.player.y; enemy.hp = 2;
    }
    g.combatSystem.attack();
    assert.equal(g.run.kills, 3); assert.equal(g.enemySystem.enemies.length, 0);
    assert.equal(g.xpSystem.gems.length, 3);
    for (let frame = 0; frame < 20 && g.run.phase === 'playing'; frame++) g.xpSystem.update(0.05);
    assert.equal(g.run.level, 2); assert.equal(g.run.phase, 'choosingUpgrade');
    g.chooseUpgrade(0); assert.equal(g.run.weapon.damage, 3);
    g.enemySystem.spawnBread(WORLD.enemyStartX + WORLD.enemySpacing * 3);
    const enemy = g.enemySystem.enemies[0];
    enemy.sprite.x = g.player.x + 50; enemy.sprite.y = g.player.y; enemy.hp = 3;
    g.run.runTime = 0.5; g.combatSystem.attack();
    assert.equal(g.run.kills, 4);
}

// Candy retains one projectile per attack and exactly one enemy hit per projectile.
{
    const { game: g } = fixture('candy');
    assert.equal(g.run.weapon.damage, 1); assert.equal(g.run.weapon.cooldown, 900);
    for (let i = 0; i < 3; i++) {
        g.enemySystem.spawnBread(WORLD.enemyStartX + g.enemySystem.enemies.length * WORLD.enemySpacing);
        const enemy = g.enemySystem.enemies.at(-1);
        enemy.sprite.x = g.player.x + 90; enemy.sprite.y = g.player.y; enemy.hp = 4;
    }
    g.combatSystem.attack(); assert.equal(g.combatSystem.projectiles.length, 1);
    const shot = g.combatSystem.projectiles[0];
    g.combatSystem.update(0.1);
    assert.equal(shot.sprite.active, false); assert.equal(g.combatSystem.projectiles.length, 0);
    assert.equal(g.enemySystem.enemies.filter(enemy => enemy.hp === 3).length, 1);
    assert.equal(g.enemySystem.enemies.filter(enemy => enemy.hp === 4).length, 2);
    g.run.runTime = 0.899; g.combatSystem.attack(); assert.equal(g.combatSystem.projectiles.length, 0);
    g.run.runTime = 0.900; g.combatSystem.attack(); assert.equal(g.combatSystem.projectiles.length, 1);
}
console.log('PASS focused balance: 2-damage/500 ms forward sword sector, multi-target single-hit swings, cooldown boundaries, multi-kill XP/upgrades, and 1-damage/900 ms non-piercing Candy shots.');

{
    const { game: g } = fixture('candy');
    // Charging requires a hold; releasing a complete charge fires a single
    // stronger projectile without altering the standard Candy shot.
    assert.equal(g.combatSystem.updateCharge(true, 0.40), true);
    assert.equal(g.combatSystem.projectiles.length, 0);
    assert.equal(g.combatSystem.updateCharge(true, 0.26), true);
    assert.equal(g.combatSystem.updateCharge(false, 0.01), true);
    assert.equal(g.combatSystem.projectiles.length, 1);
    const shot = g.combatSystem.projectiles[0];
    assert.equal(shot.damage, 3);
    assert.equal(shot.charged, true);
    assert.equal(g.run.weapon.lastAttack, 0);
    assert.equal(g.combatSystem.updateCharge(false, 0.01), false);
    assert.equal(g.combatSystem.projectiles.length, 1);
    g.events.emit('shutdown');
}
{
    const { game: g } = fixture('candy');
    g.combatSystem.updateCharge(true, 0.20);
    g.combatSystem.updateCharge(false, 0.01);
    assert.equal(g.combatSystem.projectiles.length, 1);
    assert.equal(g.combatSystem.projectiles[0].damage, 1,
        'Releasing early retains standard shot damage');
    g.events.emit('shutdown');
}
{
    const { game: g } = fixture('candy');
    // A short tap inside the last 100ms of cooldown must be delivered
    // when cooldown expires; earlier implementation discarded it on press.
    g.run.weapon.lastAttack = 0;
    g.run.runTime = 0.83;
    g.combatSystem.updateCharge(true, 0.01);
    assert.equal(g.combatSystem.isCharging, true);
    g.combatSystem.updateCharge(false, 0.01);
    assert.equal(g.combatSystem.projectiles.length, 0);
    g.run.runTime = 0.91;
    g.combatSystem.updateCharge(false, 0.08);
    assert.equal(g.combatSystem.projectiles.length, 1);
    g.events.emit('shutdown');
}
{
    const { game: g } = fixture('candy');
    let normalAttacks = 0, chargeAnimations = 0;
    g.player.showAttack = () => { normalAttacks++; return false; };
    g.player.showCharge = () => { chargeAnimations++; };
    // A quick tap must exclusively select attack.png (not charging.png).
    g.combatSystem.updateCharge(true, 0.055);
    assert.equal(chargeAnimations, 0, 'Quick J taps must not start charge artwork');
    g.combatSystem.updateCharge(false, 0.01);
    assert.equal(normalAttacks, 1, 'Normal J tap must start attack.png');
    assert.equal(g.combatSystem.projectiles.length, 1, 'Normal Candy projectile stays available');
    // After cooldown, a held press should use charging.png, not attack.png.
    g.run.runTime = 1.0;
    g.combatSystem.updateCharge(true, 0.07);
    assert.equal(chargeAnimations, 0);
    g.combatSystem.updateCharge(true, 0.10);
    assert.equal(chargeAnimations, 1, 'Sustained J press starts charge art');
    assert.equal(normalAttacks, 1);
    g.combatSystem.updateCharge(true, 0.50);
    g.combatSystem.updateCharge(false, 0.01);
    assert.equal(normalAttacks, 1, 'Strong charge release must not restart normal attack.png');
    assert.equal(g.combatSystem.projectiles.length, 2);
    assert.equal(g.combatSystem.projectiles[1].damage, 3);
    g.events.emit('shutdown');
}
console.log('PASS Candy tap visuals: attack.png only for quick tap; charge art only for sustained hold.');

console.log('PASS Candy charge: hold threshold, strong release, early release and no duplicate projectiles.');

// Holding J / ATK for a charged shot must not also fire the regular shot.
// Verify the source's single-control wiring so a separate CHG key cannot regress.
{
    const inputSource = fs.readFileSync(path.join(__dirname, '../src/game/input/PlayerInput.ts'), 'utf8');
    const gameSource = fs.readFileSync(path.join(__dirname, '../src/game/scenes/Game.ts'), 'utf8');
    assert.ok(!inputSource.includes("'CHG', 'charge'"));
    assert.ok(!inputSource.includes("this.keys.C.isDown"));
    assert.ok(gameSource.includes('this.combatSystem.updateCharge(chargeHeld, dt)'));
    assert.ok(gameSource.includes('movementLocked ? { ...actions, left: false, right: false, jump: false }'));
}
console.log('PASS Candy controls: existing J/ATK tap-or-hold drives charge, without separate key.');




// Optional sprite sheets never replace a working placeholder with invalid frames.
const { CHARACTER_SPRITES, hasCharacterSheet, loadCharacterSheets, registerCharacterAnimations } = load('characters/spriteAnimations');
function installCharacterSprites(scene, width, height, missingFrame, selectedPack = CHARACTER_SPRITES.llama) {
    const animations = new Map();
    const pack = selectedPack;
    const { animationSource } = load('rendering/spriteAssets');
    const sources = new Map();
    for (const state of Object.keys(pack.animations)) {
        const source = animationSource(pack, state);
        sources.set(source.key, source);
        const fallback = pack.animations[state].fallback;
        if (fallback) sources.set(fallback.sheet.key, fallback.sheet);
    }
    scene.textures = {
        exists: key => sources.has(key),
        get: key => {
            const source = sources.get(key);
            return { getSourceImage: () => ({ width: width ?? source.width, height: height ?? source.height }),
                has: name => Number(name) !== missingFrame && Number(name) >= 0 &&
                    Number(name) < source.width / 256 * (source.height / 256),
                get: () => ({ width: 256, height: 256 }) };
        }
    };
    scene.anims = {
        exists: key => animations.has(key),
        create: animation => animations.set(animation.key, animation),
        generateFrameNumbers: (key, config) => (config.frames ?? Array.from({ length: config.end - config.start + 1 }, (_, index) => config.start + index)).map(frame => ({ key, frame }))
    };
    scene.add.sprite = (x, y, key, frame) => {
        const sprite = scene.add.image(x, y, key, frame);
        sprite.plays = []; sprite.texture = { key };
        sprite.setFlipX = value => { sprite.flipX = value; return sprite; };
        sprite.setOrigin = (ox, oy) => { sprite.originX = ox; sprite.originY = oy; return sprite; };
        sprite.setScale = scale => { sprite.scale = scale; return sprite; };
        sprite.setFrame = frame => { sprite.frame = frame; return sprite; };
        sprite.setTexture = (key, frame) => { sprite.texture = { key }; sprite.textureKey = key; sprite.frame = frame; return sprite; };
        sprite.anims = {
            isPlaying: false, paused: false,
            stop() { this.isPlaying = false; },
            pause() { if (!this.paused) { this.wasPlaying = this.isPlaying; this.isPlaying = false; this.paused = true; } },
            resume() { if (this.paused) { this.isPlaying = this.wasPlaying; this.paused = false; } }
        };
        sprite.play = name => {
            sprite.plays.push(name); sprite.animationKey = name;
            sprite.textureKey = animations.get(name).frames[0].key;
            sprite.anims.paused = false; sprite.anims.isPlaying = true;
            return sprite;
        };
        return sprite;
    };
    return animations;
}
{
    const { game: g } = fixture();
    const queued = [];
    g.load = { spritesheet: (...args) => queued.push(args) };
    loadCharacterSheets(g);
    assert.equal(queued.length, 11); // Native charge sheet plus the 10 existing actor sheets.
    const queuedByKey = new Map(queued.map(entry => [entry[0], entry]));
    for (const [key, file, end] of [
        ['llama-crunch-idle', 'idle.png', 3], ['llama-crunch-run', 'run.png', 5],
        ['llama-crunch-attack', 'attack.png', 4], ['llama-crunch', 'llama-crunch-9x3-256-import-test.png', 26]
    ]) {
        const entry = queuedByKey.get(key);
        assert.equal(entry[1], `characters/llama-crunch/${file}`);
        assert.equal(entry[2].frameWidth, 256); assert.equal(entry[2].frameHeight, 256);
        assert.equal(entry[2].startFrame, 0); assert.equal(entry[2].endFrame, end);
    }
    for (const [key, file, end] of [
        ['candy-idle', 'idle.png', 3], ['candy-run', 'run.png', 5],
        ['candy-jump', 'jump.png', 5], ['candy-attack', 'attack.png', 5],
        ['candy-death', 'death.png', 5],
        ['candy-levelup', 'levelup.png', 5]
    ]) {
        const entry = queuedByKey.get(key);
        assert.ok(entry, `Candy asset is loaded: ${key}`);
        assert.equal(entry[1], `characters/candy/${file}`);
        assert.equal(entry[2].frameWidth, 256);
        assert.equal(entry[2].frameHeight, 256);
        assert.equal(entry[2].endFrame, end);
    }
    let animations = installCharacterSprites(g, 2172, 724);
    registerCharacterAnimations(g);
    assert.equal(animations.size, 0); assert.equal(hasCharacterSheet(g, CHARACTER_SPRITES.llama), false);
    const wrongSize = new Player(g, g.run, g.groundY);
    assert.equal(wrongSize.sprite.children.length, 7);
    animations = installCharacterSprites(g, 2304, 768, 26);
    registerCharacterAnimations(g); assert.equal(animations.size, 0);
    assert.equal(new Player(g, g.run, g.groundY).sprite.children.length, 7);
    animations = installCharacterSprites(g);
    registerCharacterAnimations(g); registerCharacterAnimations(g);
    assert.equal(animations.size, 7);
    for (const [name, start, end, fps, repeat] of [
        ['idle', 0, 3, 6, -1], ['run', 0, 5, 10, -1], ['jump', 10, 12, 12, 0],
        ['fall', 13, 14, 10, 0], ['attack', 0, 4, 30, 0], ['hurt', 19, 21, 18, 0], ['death', 22, 26, 10, 0]
    ]) {
        const animation = animations.get(`llama-crunch:${name}`);
        assert.equal(animation.frames[0].frame, start); assert.equal(animation.frames.at(-1).frame, end);
        assert.equal(animation.frameRate, fps); assert.equal(animation.repeat, repeat);
    }
    g.events.emit('shutdown');
}

// Animation states and priorities are presentation-only; the container remains the anchor.
{
    const { game: g } = fixture();
    installCharacterSprites(g); registerCharacterAnimations(g);
    const player = new Player(g, g.run, g.groundY);
    const sprite = player.sprite.children[0];
    assert.equal(sprite.animationKey, 'llama-crunch:idle');
    assert.equal(player.sprite.children.length, 1);
    assert.equal(sprite.originX, 0.5); assert.equal(sprite.originY, 0.875);
    assert.equal(sprite.scale, 0.5); assert.equal(sprite.x, 0); assert.equal(sprite.y, 40);
    const x = player.x;
    player.update({ left: false, right: true, jump: false }, 0.05);
    assert.equal(player.x, x + 14); assert.equal(sprite.animationKey, 'llama-crunch:run');
    player.update({ left: false, right: false, jump: true }, 0.05);
    assert.equal(sprite.animationKey, 'llama-crunch:jump');
    g.run.velocityY = 20;
    player.update({ left: false, right: false, jump: false }, 0.01);
    assert.equal(sprite.animationKey, 'llama-crunch:fall');
    player.showAttack(); assert.equal(sprite.animationKey, 'llama-crunch:attack');
    player.showHurt(); assert.equal(sprite.animationKey, 'llama-crunch:hurt');
    player.showAttack(); assert.equal(sprite.animationKey, 'llama-crunch:hurt');
    const state = JSON.stringify(g.run);
    player.setVisualPhase('choosingUpgrade'); assert.equal(sprite.anims.paused, true);
    player.setVisualPhase('playing'); assert.equal(sprite.anims.isPlaying, true);
    assert.equal(JSON.stringify(g.run), state);
    sprite.anims.isPlaying = false;
    player.update({ left: false, right: false, jump: false }, 0.01);
    assert.equal(sprite.animationKey, 'llama-crunch:fall');
    player.showDeath(); assert.equal(sprite.animationKey, 'llama-crunch:death');
    sprite.anims.isPlaying = false;
    player.showHurt(); player.showAttack();
    assert.equal(sprite.animationKey, 'llama-crunch:death');
    const plays = sprite.plays.length;
    player.update({ left: false, right: false, jump: false }, 0.01);
    assert.equal(sprite.plays.length, plays); // Hold the final death frame without restarting it.
    const fresh = new Player(g, createRunState(), g.groundY);
    assert.equal(fresh.sprite.children[0].animationKey, 'llama-crunch:idle');
    assert.equal(new Player(g, createRunState('candy'), g.groundY).sprite.children.length, 11);
    g.events.emit('shutdown');
}

// Candy's jump is physics-driven: ascent frames 1-4 do not loop,
// frame 5 is held in descent, and frame 6 appears only after landing.
// Casting may enlarge the artwork but may never change the player hitbox.
{
    const { game: g } = fixture('candy');
    const animations = installCharacterSprites(g, undefined, undefined, undefined, CHARACTER_SPRITES.candy);
    registerCharacterAnimations(g);
    const candy = CHARACTER_SPRITES.candy.animations;
    assert.equal(candy.run.fps, 8);
    assert.equal(candy.idle.fps, 5);
    assert.equal(JSON.stringify(animations.get('candy:idle').frames.map(f => f.frame)), JSON.stringify([0, 1, 3, 1]));
    assert.equal(candy.jump.end, 3); assert.equal(candy.jump.repeat, 0);
    assert.equal(candy.fall.start, 4); assert.equal(candy.fall.end, 4);
    assert.equal(animations.get('candy:jump').frames.at(-1).frame, 3);
    const player = new Player(g, g.run, g.groundY), art = player.sprite.children[0];
    const controls = { left: false, right: false, jump: false };
    g.run.onGround = false; g.run.velocityY = -500;
    player.update(controls, 0.05); assert.equal(art.animationKey, 'candy:jump');
    g.run.velocityY = 40;
    player.update(controls, 0.01); assert.equal(art.animationKey, 'candy:fall');
    assert.equal(art.frame, undefined); // Fall's only animated frame is index 4.
    g.run.onGround = true; g.run.velocityY = 0;
    player.update(controls, 0.01);
    assert.equal(art.textureKey, 'candy-jump'); assert.equal(art.frame, 5);
    player.update(controls, 0.2);
    assert.equal(art.animationKey, 'candy:idle');
    // The idle loop excludes the blink entirely until the timed pause.
    for (let i = 0; i < 76; i++) player.update(controls, 0.05);
    assert.equal(art.anims.paused, false);
    player.update(controls, 0.25);
    assert.equal(art.frame, 2);
    assert.equal(art.anims.paused, true);
    player.update(controls, 0.14);
    assert.equal(art.anims.paused, false);
    assert.equal(art.frame, 0);
    player.showAttack();
    assert.equal(art.scale, 0.64);
    art.anims.isPlaying = false;
    player.update(controls, 0.01);
    assert.equal(art.scale, 0.5);

    // Regression from the 14 Nov recording: attacking during a jump,
    // entering descent mid-cast, and moving must never shrink the casting art.
    g.run.onGround = false; g.run.velocityY = -250;
    player.update({ ...controls, right: true }, 0.015);
    player.showAttack();
    assert.equal(art.animationKey, 'candy:attack');
    assert.equal(art.scale, 0.64);
    g.run.velocityY = 120;
    player.update({ ...controls, right: true }, 0.015);
    assert.equal(art.animationKey, 'candy:attack');
    assert.equal(art.scale, 0.64, 'Candy must remain full-size while attack overlaps falling');
    art.anims.isPlaying = false;
    player.update({ ...controls, right: true }, 0.015);
    assert.equal(art.animationKey, 'candy:fall');
    assert.equal(art.scale, 0.5, 'Resize only after falling animation has replaced attack');

    // Attack can also overlap landing: the deferred landing frame should
    // replace the full-size casting artwork when the attack finishes.
    player.showAttack();
    g.run.onGround = true; g.run.velocityY = 0;
    player.visual.update(g.run, true, 0.015);
    assert.equal(art.animationKey, 'candy:attack');
    assert.equal(art.scale, 0.64);
    art.anims.isPlaying = false;
    player.visual.update(g.run, true, 0.015);
    assert.equal(art.textureKey, 'candy-jump');
    assert.equal(art.frame, 5);
    assert.equal(art.scale, 0.5);
    g.events.emit('shutdown');
}
console.log('PASS Candy animation: slower run, physics-driven jump, occasional blink, full-size airborne casting and deferred landing.');

// Scale/origin/offset adjustments do not change movement or any run-state field.
{
    const { game: g } = fixture();
    installCharacterSprites(g); registerCharacterAnimations(g);
    const config = CHARACTER_SPRITES.llama;
    const original = { scale: config.scale, originX: config.originX, originY: config.originY, offsetX: config.offsetX, offsetY: config.offsetY };
    try {
        Object.assign(config, { scale: 0.8, originX: 0.3, originY: 0.9, offsetX: 25, offsetY: 35 });
        const state = createRunState(); const snapshot = JSON.stringify(state);
        const player = new Player(g, state, g.groundY);
        assert.equal(player.x, 170); assert.equal(player.y, g.groundY - 40);
        assert.equal(player.sprite.children[0].scale, 0.8);
        assert.equal(player.sprite.children[0].x, 25); assert.equal(player.sprite.children[0].y, 35);
        assert.equal(JSON.stringify(state), snapshot);
        player.update({ left: true, right: false, jump: false }, 0.05);
        assert.equal(player.x, 156);
    } finally { Object.assign(config, original); }
    g.events.emit('shutdown');
}

// Only accepted attacks and damage events trigger poses; death does not delay the phase.
{
    const { game: g } = fixture();
    installCharacterSprites(g); registerCharacterAnimations(g);
    g.player = new Player(g, g.run, g.groundY);
    g.combatSystem = new CombatSystem(g, g.run, g.player, g.enemySystem,
        (x, y) => g.xpSystem.dropGem(x, y), () => g.endGame(), () => g.updateHud());
    const sprite = g.player.sprite.children[0];
    g.combatSystem.attack(); assert.equal(sprite.animationKey, 'llama-crunch:attack');
    const plays = sprite.plays.length;
    g.combatSystem.attack(); assert.equal(sprite.plays.length, plays);
    g.enemySystem.spawnBread(); const enemy = g.enemySystem.enemies[0];
    enemy.sprite.x = g.player.x; enemy.sprite.y = g.player.y;
    enemy.brain.state = 'active'; enemy.brain.remaining = 0.1; g.combatSystem.resolveEnemyAttack(enemy); assert.equal(sprite.animationKey, 'llama-crunch:hurt');
    g.run.health = 1; g.run.runTime = 1;
    enemy.brain.state = 'active'; enemy.brain.remaining = 0.1; g.combatSystem.resolveEnemyAttack(enemy);
    assert.equal(g.run.phase, 'gameOver'); assert.equal(sprite.animationKey, 'llama-crunch:death');
    g.setPauseReason('portrait', true);
    assert.equal(g.run.phase, 'gameOver'); assert.equal(sprite.anims.paused, true);
    g.setPauseReason('portrait', false);
    assert.equal(sprite.anims.paused, false); assert.equal(sprite.animationKey, 'llama-crunch:death');
    g.events.emit('shutdown');
}
console.log('PASS sprite integration: exact sheet/frame validation, animation mapping, fallback, priorities, phase pause, combat hooks, Candy preservation and visual-only transforms.');

// Validate the actual deployed PNG, rather than relying only on mock textures.
{
    const { inflateSync } = require('node:zlib');
    const { animationSource } = load('rendering/spriteAssets');
    const pack = CHARACTER_SPRITES.llama;
    const sources = new Map(Object.keys(pack.animations).map(state => {
        const source = animationSource(pack, state); return [source.key, source];
    }));
    const slashEffect = load('weapons/slashEffect').SWORD_SLASH_EFFECT;
    sources.set(slashEffect.key, slashEffect);
    const { breadSheet } = load('enemies/bread');
    for (const state of ['idle', 'run', 'attack', 'death']) { const source = breadSheet(state); sources.set(source.key, source); }
    for (const sheet of sources.values()) {
        const file = path.join(__dirname, '../public/assets', sheet.path);
        assert.ok(fs.existsSync(file), `Configured character asset missing: ${file}`);
        const png = fs.readFileSync(file);
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        assert.equal(width, sheet.width); assert.equal(height, sheet.height);
        assert.equal(width % 256, 0); assert.equal(height % 256, 0);
        assert.equal(png[24], 8); assert.equal(png[25], 6); assert.equal(png[28], 0);
        const chunks = [];
        for (let cursor = 8; cursor < png.length;) {
            const length = png.readUInt32BE(cursor);
            if (png.subarray(cursor + 4, cursor + 8).toString() === 'IDAT') chunks.push(png.subarray(cursor + 8, cursor + 8 + length));
            cursor += length + 12;
        }
        const raw = inflateSync(Buffer.concat(chunks));
        const stride = width * 4;
        assert.equal(raw.length, (stride + 1) * height);
        let previous = Buffer.alloc(stride), cursor = 0, transparent = 0, visible = 0;
        for (let y = 0; y < height; y++) {
            const filter = raw[cursor++];
            assert.ok(filter <= 4);
            const row = Buffer.from(raw.subarray(cursor, cursor + stride)); cursor += stride;
            for (let x = 0; x < stride; x++) {
                const left = x >= 4 ? row[x - 4] : 0, up = previous[x], diagonal = x >= 4 ? previous[x - 4] : 0;
                let predictor = 0;
                if (filter === 1) predictor = left;
                else if (filter === 2) predictor = up;
                else if (filter === 3) predictor = Math.floor((left + up) / 2);
                else if (filter === 4) {
                    const value = left + up - diagonal;
                    const a = Math.abs(value - left), b = Math.abs(value - up), c = Math.abs(value - diagonal);
                    predictor = a <= b && a <= c ? left : b <= c ? up : diagonal;
                }
                row[x] = (row[x] + predictor) & 255;
            }
            for (let x = 3; x < stride; x += 4) { if (row[x] === 0) transparent++; else visible++; }
            previous = row;
        }
        assert.ok(transparent > 0, 'Character PNG must contain transparent pixels');
        assert.ok(visible > 0, 'Character PNG must not be completely blank');
        console.log(`PASS actual asset: ${width} x ${height}, ${(width / 256) * (height / 256)} cells, RGBA transparency (${transparent} transparent pixels), configured path exists.`);
    }
}

// Candy must never silently fall back to the placeholder because a newly
// uploaded PNG has the wrong dimensions or is not an RGBA 256px strip.
{
    for (const [name, frames] of [
        ['idle', 4], ['run', 6], ['jump', 6], ['attack', 6],
        ['death', 6], ['levelup', 6], ['projectile', 6]
    ]) {
        const file = path.join(__dirname, '../public/assets/characters/candy', `${name}.png`);
        assert.ok(fs.existsSync(file), `Missing Candy asset: ${name}`);
        const png = fs.readFileSync(file);
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${name}: PNG signature`);
        assert.equal(png.readUInt32BE(16), frames * 256, `${name}: width must be ${frames} x 256`);
        assert.equal(png.readUInt32BE(20), 256, `${name}: height must be 256`);
        assert.equal(png[24], 8, `${name}: 8-bit PNG`);
        assert.equal(png[25], 6, `${name}: RGBA PNG required`);
    }
    const chargeFile = path.join(__dirname, '../public/assets/characters/candy/charging.png');
    const chargePng = fs.readFileSync(chargeFile);
    assert.equal(chargePng.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const chargeWidth = chargePng.readUInt32BE(16), chargeHeight = chargePng.readUInt32BE(20);
    console.log(`Candy charging: ${chargeWidth} x ${chargeHeight}`);
    // charging.png is the six-frame horizontal strip, not the old 6x2 grid.
    assert.equal(chargeWidth, 1536);
    assert.equal(chargeHeight, 256);
    assert.equal(chargeWidth / 256, 6);
    assert.equal(chargePng[25], 6, 'chargefix must be RGBA');
    console.log('PASS Candy assets: all seven currently configured source strips are 256px horizontal RGBA; hit.png still needs conversion.');
}

// Preferred separate-state packs switch textures without changing the parent/gameplay state.
{
    const { game: g } = fixture();
    const combined = CHARACTER_SPRITES.llama;
    const animations = installCharacterSprites(g);
    const states = ['idle', 'run', 'jump', 'fall', 'attack', 'hurt', 'death'];
    const pack = {
        format: 'separate', key: 'llama-crunch', scale: combined.scale,
        originX: combined.originX, originY: combined.originY, offsetX: combined.offsetX, offsetY: combined.offsetY,
        animations: Object.fromEntries(states.map(state => {
            const original = combined.animations[state];
            const count = original.end - original.start + 1;
            return [state, { start: 0, end: count - 1, fps: original.fps, repeat: original.repeat,
                sheet: { key: `llama-crunch-sheet:${state}`, path: `characters/llama-crunch/${state}.png`,
                    width: count * 256, height: 256, frameWidth: 256, frameHeight: 256 } }];
        }))
    };
    let missing;
    g.textures = {
        exists: key => states.some(state => pack.animations[state].sheet.key === key && state !== missing),
        get: key => {
            const state = states.find(name => pack.animations[name].sheet.key === key);
            const clip = pack.animations[state];
            return { getSourceImage: () => ({ width: clip.sheet.width, height: clip.sheet.height }),
                has: name => Number(name) >= 0 && Number(name) <= clip.end,
                get: () => ({ width: 256, height: 256 }) };
        }
    };
    CHARACTER_SPRITES.llama = pack;
    try {
        const queued = [];
        g.load = { spritesheet: (...args) => queued.push(args) };
        loadCharacterSheets(g);
        assert.equal(queued.length, 14); // Native charge sheet, seven temporary Llama and six Candy sources.
        assert.equal(new Set(queued.map(args => args[0])).size, 14);
        registerCharacterAnimations(g);
        assert.equal(animations.size, 7);
        for (const state of states) {
            const animation = animations.get(`llama-crunch:${state}`);
            assert.equal(animation.frames[0].key, pack.animations[state].sheet.key);
            assert.equal(animation.frames[0].frame, 0);
            assert.equal(animation.frames.at(-1).frame, pack.animations[state].end);
        }
        const player = new Player(g, g.run, g.groundY);
        const sprite = player.sprite.children[0];
        const check = state => {
            assert.equal(sprite.textureKey, pack.animations[state].sheet.key);
            assert.equal(sprite.scale, 0.5); assert.equal(sprite.originY, 0.875);
            assert.equal(sprite.x, 0); assert.equal(sprite.y, 40);
        };
        check('idle');
        player.update({ left: false, right: true, jump: false }, 0.05); check('run');
        player.update({ left: false, right: false, jump: true }, 0.05); check('jump');
        g.run.velocityY = 10;
        player.update({ left: false, right: false, jump: false }, 0.01); check('fall');
        player.showAttack(); check('attack'); player.showHurt(); check('hurt'); player.showDeath(); check('death');
        assert.equal(player.x, 184); // Same 280 px/s movement, independent of texture changes.
        missing = 'fall';
        assert.equal(hasCharacterSheet(g, pack), false);
        assert.equal(new Player(g, g.run, g.groundY).sprite.children.length, 7);
        missing = undefined;
        pack.animations.idle.sheet.frameWidth = 128;
        assert.equal(hasCharacterSheet(g, pack), false);
        pack.animations.idle.sheet.frameWidth = 256;
        pack.animations.idle.end = 999;
        assert.equal(hasCharacterSheet(g, pack), false);
        pack.animations.idle.end = combined.animations.idle.end;
        const jump = pack.animations.jump;
        delete pack.animations.jump;
        assert.equal(hasCharacterSheet(g, pack), false);
        pack.animations.jump = jump;
        assert.equal(hasCharacterSheet(g, pack), true);
    } finally { CHARACTER_SPRITES.llama = combined; }
    g.events.emit('shutdown');
}
console.log('PASS visual contract: separate state textures, seven-state completeness, 256-pixel enforcement, invalid-range rejection, legacy support and unchanged gameplay anchors.');

// Shared facing persists through idle, opposite inputs, airborne/action states and flips only art.
{
    const { game: g } = fixture();
    installCharacterSprites(g); registerCharacterAnimations(g);
    const player = new Player(g, g.run, g.groundY);
    const art = player.sprite.children[0];
    assert.equal(player.facing, 1);
    const transform = [art.x, art.y, art.originX, art.originY, art.scale];
    player.update({ left: true, right: false, jump: false }, 0.05);
    assert.equal(player.facing, -1); assert.equal(art.flipX, true);
    assert.equal(player.x, 156); assert.equal(player.sprite.scaleX, 1);
    player.update({ left: false, right: false, jump: false }, 0.05);
    assert.equal(player.facing, -1); assert.equal(art.flipX, true);
    player.update({ left: true, right: true, jump: false }, 0.05);
    assert.equal(player.facing, -1); assert.equal(player.x, 156);
    player.update({ left: false, right: false, jump: true }, 0.05);
    assert.equal(art.animationKey, 'llama-crunch:jump'); assert.equal(art.flipX, true);
    g.run.velocityY = 10;
    player.update({ left: false, right: false, jump: false }, 0.01);
    assert.equal(art.animationKey, 'llama-crunch:fall'); assert.equal(art.flipX, true);
    player.showAttack(); assert.equal(art.animationKey, 'llama-crunch:attack'); assert.equal(art.flipX, true);
    player.showHurt(); assert.equal(art.animationKey, 'llama-crunch:hurt'); assert.equal(art.flipX, true);
    player.update({ left: false, right: true, jump: false }, 0.01);
    assert.equal(player.facing, 1); assert.equal(art.flipX, false);
    player.showDeath(); assert.equal(art.animationKey, 'llama-crunch:death'); assert.equal(art.flipX, false);
    assert.equal(JSON.stringify([art.x, art.y, art.originX, art.originY, art.scale]), JSON.stringify(transform));
    assert.equal(player.sprite.flipX, undefined); assert.equal(player.sprite.scaleX, 1);
    assert.equal(new Player(g, createRunState(), g.groundY).facing, 1);
}
for (const characterId of ['llamaCrunch', 'candy']) {
    const { game: g } = fixture(characterId); // Both shape-based fallbacks use the same method.
    const player = new Player(g, g.run, g.groundY);
    const original = player.sprite.children.map(part => [part.x, part.scaleX]);
    player.update({ left: true, right: false, jump: false }, 0.05);
    player.sprite.children.forEach((part, index) => {
        assert.equal(part.x, -original[index][0]); assert.equal(part.scaleX, -original[index][1]);
    });
    player.update({ left: false, right: false, jump: false }, 0.05);
    assert.equal(player.facing, -1); assert.equal(player.sprite.scaleX, 1);
    player.showAttack(); player.showHurt(); player.showDeath();
    assert.equal(player.facing, -1);
    player.update({ left: false, right: true, jump: false }, 0.05);
    player.sprite.children.forEach((part, index) => {
        assert.equal(part.x, original[index][0]); assert.equal(part.scaleX, original[index][1]);
    });
    assert.equal(player.facing, 1); assert.equal(player.sprite.scaleX, 1);
}

// Flipping with a custom origin/offset preserves the configured anchor exactly.
{
    const { game: g } = fixture(); installCharacterSprites(g); registerCharacterAnimations(g);
    const config = CHARACTER_SPRITES.llama;
    const original = { originX: config.originX, offsetX: config.offsetX };
    try {
        config.originX = 0.3; config.offsetX = 17;
        const player = new Player(g, g.run, g.groundY), art = player.sprite.children[0];
        player.update({ left: true, right: false, jump: false }, 0);
        assert.equal(player.x, 170); assert.equal(player.y, g.groundY - 40);
        assert.equal(art.flipX, true); assert.equal(art.originX, 0.3); assert.equal(art.x, 17);
        player.update({ left: false, right: true, jump: false }, 0);
        assert.equal(art.flipX, false); assert.equal(art.originX, 0.3); assert.equal(art.x, 17);
    } finally { Object.assign(config, original); }
}

// Sword aims in facing direction without flipping/scaling the effect container or changing damage.
{
    const { game: g } = fixture(); g.player.facing = -1;
    const enemies = [-40, -80, 40].map(dx => {
        g.enemySystem.spawnBread(WORLD.enemyStartX + g.enemySystem.enemies.length * WORLD.enemySpacing); const enemy = g.enemySystem.enemies.at(-1);
        enemy.sprite.x = g.player.x + dx; enemy.sprite.y = g.player.y; enemy.hp = 7;
        return enemy;
    });
    g.combatSystem.attack();
    assert.equal(enemies[0].hp, 5); assert.equal(enemies[1].hp, 5); assert.equal(enemies[2].hp, 7);
    const slash = [...g.combatSystem.slashes][0];
    assert.equal(slash.scaleX, 1); assert.equal(slash.flipX, undefined);
    assert.ok(slash.children.filter(part => part.kind === 'rectangle').every(part => part.x < 0));
    g.run.runTime = 0.499; g.combatSystem.attack(); assert.equal(enemies[0].hp, 5);
    g.run.runTime = 0.5; g.combatSystem.attack(); assert.equal(enemies[0].hp, 3);
    g.events.emit('shutdown');
}

// A shot keeps its firing direction after turning and hits only the nearest enemy on that path.
{
    const { game: g } = fixture('candy'); g.player.facing = -1;
    for (const x of [100, 160, 450]) {
        g.enemySystem.spawnBread(WORLD.enemyStartX + g.enemySystem.enemies.length * WORLD.enemySpacing); const enemy = g.enemySystem.enemies.at(-1);
        enemy.sprite.x = x; enemy.sprite.y = g.player.y; enemy.hp = 1;
    }
    g.combatSystem.attack(); const shot = g.combatSystem.projectiles[0];
    assert.equal(shot.sprite.x, 270); assert.equal(shot.direction, -1); assert.equal(shot.sprite.scaleX, 1);
    g.player.facing = 1;
    g.combatSystem.update(0.5);
    assert.equal(g.run.kills, 1); assert.equal(shot.sprite.active, false);
    assert.equal(g.enemySystem.enemies[0].sprite.x, 100); assert.equal(g.enemySystem.enemies[1].sprite.x, 450);
    g.run.runTime = 0.9; g.combatSystem.attack();
    const next = g.combatSystem.projectiles[0]; assert.equal(next.direction, 1); assert.equal(next.sprite.x, 330);
    g.player.facing = -1; g.combatSystem.update(0.3);
    assert.equal(g.run.kills, 2); assert.equal(g.xpSystem.gems.length, 2);
    g.run.runTime = 1.8; g.combatSystem.attack();
    g.combatSystem.update(1);
    assert.equal(g.combatSystem.projectiles.length, 0);
    g.events.emit('shutdown');
}
console.log('PASS facing: animated and placeholder art, retained idle/airborne/action direction, stable origins/anchors, directional sword/projectiles, unchanged damage/cooldowns and unflipped effects.');

// Mixed packs prefer the corrected strips independently, with per-state legacy fallback.
{
    const { game: g } = fixture();
    const animations = installCharacterSprites(g);
    const { resolveCharacterAnimation } = load('characters/spriteAnimations');
    registerCharacterAnimations(g);
    for (const [state, key, start, end] of [
        ['idle', 'llama-crunch-idle', 0, 3], ['run', 'llama-crunch-run', 0, 5],
        ['attack', 'llama-crunch-attack', 0, 4], ['jump', 'llama-crunch', 10, 12],
        ['fall', 'llama-crunch', 13, 14], ['hurt', 'llama-crunch', 19, 21], ['death', 'llama-crunch', 22, 26]
    ]) {
        const clip = animations.get(`llama-crunch:${state}`);
        assert.equal(clip.frames[0].key, key); assert.equal(clip.frames[0].frame, start);
        assert.equal(clip.frames.at(-1).frame, end);
    }
    const exists = g.textures.exists;
    g.textures.exists = key => key !== 'llama-crunch-run' && exists(key);
    assert.equal(hasCharacterSheet(g, CHARACTER_SPRITES.llama), true);
    assert.equal(resolveCharacterAnimation(g, CHARACTER_SPRITES.llama, 'run').source.key, 'llama-crunch');
    assert.equal(resolveCharacterAnimation(g, CHARACTER_SPRITES.llama, 'idle').source.key, 'llama-crunch-idle');
    animations.clear(); registerCharacterAnimations(g);
    const run = animations.get('llama-crunch:run');
    assert.equal(run.frames[0].key, 'llama-crunch'); assert.equal(run.frames[0].frame, 4);
    assert.equal(run.frames.at(-1).frame, 9);
    g.textures.exists = key => key !== 'llama-crunch-run' && key !== 'llama-crunch' && exists(key);
    assert.equal(hasCharacterSheet(g, CHARACTER_SPRITES.llama), false);
    assert.equal(new Player(g, g.run, g.groundY).sprite.children.length, 7);
    g.events.emit('shutdown');
}

// Baked attack effects suppress only the duplicate drawing, never the hit or cooldown.
for (const useLegacyAttack of [false, true]) {
    const { game: g } = fixture();
    const animations = installCharacterSprites(g);
    if (useLegacyAttack) {
        const exists = g.textures.exists;
        g.textures.exists = key => key !== 'llama-crunch-attack' && exists(key);
    }
    registerCharacterAnimations(g);
    g.player = new Player(g, g.run, g.groundY);
    const art = g.player.sprite.children[0];
    g.combatSystem = new CombatSystem(g, g.run, g.player, g.enemySystem,
        (x, y) => g.xpSystem.dropGem(x, y), () => g.endGame(), () => g.updateHud());
    g.enemySystem.spawnBread();
    const enemy = g.enemySystem.enemies[0];
    enemy.sprite.x = g.player.x + 40; enemy.sprite.y = g.player.y; enemy.hp = 7;
    g.combatSystem.attack();
    assert.equal(enemy.hp, 5);
    assert.equal(g.combatSystem.slashes.size, useLegacyAttack ? 1 : 0);
    assert.equal(animations.get('llama-crunch:attack').frames[0].key, useLegacyAttack ? 'llama-crunch' : 'llama-crunch-attack');
    g.run.runTime = 0.499; g.combatSystem.attack(); assert.equal(enemy.hp, 5);
    g.run.runTime = 0.5; g.combatSystem.attack(); assert.equal(enemy.hp, 3);
    g.player.update({ left: true, right: false, jump: false }, 0.01);
    assert.equal(art.flipX, true);
    g.run.runTime = 1; enemy.sprite.x = g.player.x - 40; g.combatSystem.attack();
    assert.equal(enemy.hp, 1); assert.equal(art.flipX, true);
    g.events.emit('shutdown');
}
console.log('PASS corrected strips: active mixed sources, per-state combined fallback, retained flipping, baked slash suppression and identical damage/cooldowns.');

function installSlashEffect(scene) {
    const animations = installCharacterSprites(scene);
    const { SWORD_SLASH_EFFECT: effect, registerWeaponEffects } = load('weapons/slashEffect');
    const exists = scene.textures.exists, get = scene.textures.get;
    scene.textures.exists = key => key === effect.key || exists(key);
    scene.textures.get = key => key === effect.key ? {
        getSourceImage: () => ({ width: 1280, height: 256 }),
        has: frame => Number(frame) >= 0 && Number(frame) <= 4,
        get: () => ({ width: 256, height: 256 })
    } : get(key);
    registerCharacterAnimations(scene); registerWeaponEffects(scene);
    return { animations, effect };
}

// External sword effect: five frames once, uniform range scaling and exact pause/cleanup.
{
    const { game: g } = fixture();
    const { animations, effect } = installSlashEffect(g);
    const { loadWeaponEffects } = load('weapons/slashEffect');
    const queued = []; g.load = { spritesheet: (...args) => queued.push(args) }; loadWeaponEffects(g);
    assert.equal(queued[0][1], 'weapons/sword-slash/effect.png');
    assert.equal(queued[0][2].frameWidth, 256); assert.equal(queued[0][2].frameHeight, 256);
    assert.equal(queued[0][2].startFrame, 0); assert.equal(queued[0][2].endFrame, 4);
    assert.equal(queued[1][0], 'weapon:candy-projectile');
    assert.equal(queued[1][1], 'characters/candy/projectile.png');
    assert.equal(queued[1][2].frameWidth, 256);
    assert.equal(queued[1][2].frameHeight, 256);
    // Regression: loading only impact frames 4-5 made the projectile invisible
    // because the flight sprites explicitly request frames 0-3.
    assert.equal(queued[1][2].startFrame, 0);
    assert.equal(queued[1][2].endFrame, 5);
    const animation = animations.get(effect.animationKey);
    assert.equal(JSON.stringify(animation.frames.map(frame => frame.frame)), JSON.stringify([0, 1, 2, 3, 4]));
    assert.equal(animation.frameRate, 18); assert.equal(animation.repeat, 0);
    g.player = new Player(g, g.run, g.groundY);
    g.combatSystem = new CombatSystem(g, g.run, g.player, g.enemySystem,
        (x, y) => g.xpSystem.dropGem(x, y), () => g.endGame(), () => g.updateHud());
    const character = g.player.sprite.children[0];
    g.enemySystem.spawnBread(); const enemy = g.enemySystem.enemies[0];
    enemy.hp = 7; enemy.sprite.x = g.player.x + 50; enemy.sprite.y = g.player.y;
    g.combatSystem.attack();
    assert.equal(enemy.hp, 5); assert.equal(g.combatSystem.slashes.size, 1);
    assert.equal(character.animationKey, 'llama-crunch:attack'); // Character pose and external effect start together.
    assert.equal(animations.get(character.animationKey).frames.length, 5);
    const slash = [...g.combatSystem.slashes][0];
    assert.equal(slash.animationKey, effect.animationKey); assert.equal(slash.flipX, false);
    assert.equal(slash.x, g.player.x + 115 / 2); assert.equal(slash.y, g.player.y);
    assert.equal(slash.scale, 115 / 256); assert.equal(slash.originX, 0.5); assert.equal(slash.originY, 0.5);
    g.run.xp = 3; g.xpSystem.checkLevelUp();
    assert.equal(slash.anims.paused, true); assert.equal(character.anims.paused, true);
    g.chooseUpgrade(0); assert.equal(slash.anims.paused, false); assert.equal(character.anims.paused, false);
    g.setPauseReason('portrait', true); assert.equal(slash.anims.paused, true);
    g.setPauseReason('portrait', false); assert.equal(slash.anims.paused, false);
    slash.emit('animationcomplete');
    assert.equal(slash.active, false); assert.equal(g.combatSystem.slashes.size, 0);
    // Range upgrades affect only the next effect's footprint, not the paused existing swing.
    applyUpgrade(g.run, 'range');
    g.player.update({ left: true, right: false, jump: false }, 0.01);
    enemy.sprite.x = g.player.x - 50;
    g.run.runTime = 0.5; g.combatSystem.attack();
    assert.equal(enemy.hp, 2); // +1 damage from the level-up choice, unchanged upgrade behaviour.
    const left = [...g.combatSystem.slashes][0];
    assert.equal(left.flipX, true); assert.equal(left.x, g.player.x - 135 / 2);
    assert.equal(character.flipX, true); assert.equal(character.animationKey, 'llama-crunch:attack');
    assert.equal(left.scale, 135 / 256);
    g.run.runTime = 0.999; g.combatSystem.attack(); assert.equal(g.combatSystem.slashes.size, 1);
    g.endGame(); assert.equal(left.active, false); assert.equal(g.combatSystem.slashes.size, 0);
    g.events.emit('shutdown');
}

// Restart removes an in-flight animation and its completion listener.
{
    const { game: g } = fixture(); installSlashEffect(g);
    g.combatSystem.attack(); const slash = [...g.combatSystem.slashes][0];
    g.events.emit('shutdown');
    assert.equal(slash.active, false); assert.equal(slash.eventNames().length, 0);
    assert.equal(g.combatSystem.slashes.size, 0);
}

// A missing external effect retains baked character visuals; Candy never spawns the effect.
{
    const { game: g } = fixture('candy'); installSlashEffect(g);
    g.combatSystem.attack();
    assert.equal(g.combatSystem.slashes.size, 0); assert.equal(g.combatSystem.projectiles.length, 1);
    g.events.emit('shutdown');
}
console.log('PASS sword effect: actual PNG, five frames at 18 FPS once, left flip, range upgrade scaling, simultaneous character/effect playback, pause/resume, cleanup and unchanged damage/cooldowns/Candy.');

// Completing the character attack returns to the current grounded or airborne pose.
for (const state of ['idle', 'run', 'jump', 'fall']) {
    const { game: g } = fixture(); installSlashEffect(g);
    g.player = new Player(g, g.run, g.groundY);
    g.combatSystem = new CombatSystem(g, g.run, g.player, g.enemySystem,
        (x, y) => g.xpSystem.dropGem(x, y), () => g.endGame(), () => g.updateHud());
    const character = g.player.sprite.children[0];
    g.combatSystem.attack();
    assert.equal(character.animationKey, 'llama-crunch:attack');
    assert.equal(g.combatSystem.slashes.size, 1);
    character.anims.isPlaying = false;
    if (state === 'jump' || state === 'fall') {
        g.run.onGround = false; g.run.velocityY = state === 'jump' ? -150 : 150;
        g.player.sprite.y = g.groundY - 100;
    }
    g.player.update({ left: false, right: state === 'run', jump: false }, 0.01);
    assert.equal(character.animationKey, `llama-crunch:${state}`);
    g.events.emit('shutdown');
}
console.log('PASS simultaneous attacks: both five-frame animations start together, mirror/pause together and return to idle/run/jump/fall without changing combat.');

// Adventure movement: left boundary, unlimited forward travel and smooth camera.
for (const characterId of ['llamaCrunch', 'candy']) {
    const { game: g } = fixture(characterId);
    const player = new Player(g, g.run, g.groundY);
    player.sprite.x = 4000;
    const speed = CHARACTERS[characterId].moveSpeed;
    player.update({ left: false, right: true, jump: false }, 0.05);
    assert.equal(player.x, 4000 + speed * 0.05);
    player.update({ left: true, right: false, jump: false }, 0.05);
    assert.equal(player.x, 4000);
    player.sprite.x = 100000;
    player.update({ left: false, right: false, jump: false }, 0.05);
    assert.equal(player.x, 100000);
    player.sprite.x = -10;
    player.update({ left: false, right: false, jump: false }, 0.05);
    assert.equal(player.x, 45);
    const camera = g.cameras.main;
    for (let frame = 0; frame < 180; frame++) g.worldCamera.update(5000, 1 / 60);
    const screenRatio = (5000 - camera.scrollX) / camera.width;
    assert.ok(screenRatio >= 0.35 && screenRatio <= 0.40);
    assert.equal(camera.scrollY, 0);
    for (let frame = 0; frame < 180; frame++) g.worldCamera.update(100000, 1 / 60);
    assert.ok(Math.abs(camera.scrollX - (100000 - camera.width * WORLD.rightFollowRatio)) < 0.01);
    for (let frame = 0; frame < 180; frame++) {
        g.worldCamera.update(45, 1 / 60);
        assert.ok(camera.scrollX >= 0);
    }
    assert.equal(camera.scrollX, 0);
    camera.setScroll(5000, 0);
    new WorldCamera(camera, g.scale.height);
    assert.equal(camera.scrollX, 0);
    g.events.emit('shutdown');
}

// Fixed world placements retain difficulty metadata and survive camera movement.
{
    const { game: g } = fixture();
    const camera = g.cameras.main;
    g.run.runTime = 34;
    g.enemySystem.spawnBread(); const first = g.enemySystem.enemies[0];
    camera.setScroll(6000, 0);
    g.enemySystem.spawnBread(WORLD.enemyStartX + WORLD.enemySpacing * 8); const second = g.enemySystem.enemies[1];
    assert.equal(second.sprite.x - first.sprite.x, WORLD.enemySpacing * 8);
    assert.equal(second.sprite.x, WORLD.enemyStartX + WORLD.enemySpacing * 8);
    assert.equal(second.hp, 6); assert.equal(second.speed, 125);
    assert.equal(first.hp, second.hp);
    g.enemySystem.update(0.05, () => {});
    assert.equal(first.sprite.active, false); // Distant sprite unloads; health remains in its record.
    assert.equal(g.enemySystem.records.get(first.placementId).hp, first.hp);
    assert.equal(first.sprite.x, WORLD.enemyStartX);
    assert.equal(second.sprite.active, true);
    g.events.emit('shutdown');
}

// World-space projectile hits and gem attraction remain independent of camera scroll.
{
    const { game: g } = fixture('candy');
    g.cameras.main.setScroll(6000, 0); g.player.x = 6500;
    g.enemySystem.spawnBread(); const enemy = g.enemySystem.enemies[0];
    enemy.sprite.x = 6750; enemy.sprite.y = g.player.y; enemy.hp = 1;
    g.combatSystem.attack();
    const shot = g.combatSystem.projectiles[0];
    g.combatSystem.update(0.2);
    assert.equal(shot.sprite.active, true); assert.equal(shot.sprite.x, 6660);
    g.combatSystem.update(0.1);
    assert.equal(g.run.kills, 1); assert.equal(shot.sprite.active, false);
    const gem = g.xpSystem.gems[0]; assert.equal(gem.sprite.x, 6750);
    g.xpSystem.update(1); assert.equal(gem.sprite.x, 6750); // No artificial scrolling.
    g.cameras.main.setScroll(7000, 0);
    g.xpSystem.update(1); assert.equal(gem.sprite.x, 6750); // Backtracking does not erase rewards.
    g.player.x = 6750; g.xpSystem.update(0.05);
    assert.equal(g.run.xp, 1); assert.equal(g.xpSystem.gems.length, 0);
    g.events.emit('shutdown');
}

// Sword effects/contact damage use the same world anchor at large positions.
{
    const { game: g } = fixture(); installSlashEffect(g);
    g.player.x = 8500; g.cameras.main.setScroll(8000, 0);
    g.enemySystem.spawnBread(); const enemy = g.enemySystem.enemies[0];
    enemy.hp = 7; enemy.sprite.x = 8540; enemy.sprite.y = g.player.y;
    g.combatSystem.attack(); assert.equal(enemy.hp, 5);
    const slash = [...g.combatSystem.slashes][0]; assert.equal(slash.x, 8500 + 115 / 2);
    enemy.sprite.x = 8500; enemy.brain.state = 'active'; enemy.brain.remaining = 0.1; g.combatSystem.resolveEnemyAttack(enemy);
    assert.equal(g.run.health, 5);
    g.events.emit('shutdown');
}

// The scene stops automatic scenery/distance progression and freezes the camera on pause.
{
    const { game: g, objects } = fixture();
    g.events.emit('shutdown'); installKeyboard(g); g.init({ characterId: 'llamaCrunch' }); g.create();
    g.enemySystem.update = () => {}; // Isolate exploration from temporary spawn behaviour.
    const worldRectangles = objects.filter(object => object.kind === 'rectangle' && object.scrollFactorX !== 0);
    const positions = worldRectangles.map(object => object.x);
    for (let frame = 0; frame < 60; frame++) g.update(frame * 16, 16);
    assert.equal(g.player.x, 170); assert.equal(g.run.distance, 0); assert.equal(g.cameras.main.scrollX, 0);
    assert.equal(JSON.stringify(worldRectangles.map(object => object.x)), JSON.stringify(positions));
    g.player.sprite.x = 5000;
    g.run.startX = g.run.furthestX = 5000;
    g.playerInput.keys.D.isDown = true;
    g.update(1000, 16);
    assert.ok(g.player.x > 5000);
    assert.equal(g.run.distance, (g.player.x - 5000) / WORLD.pixelsPerMetre);
    assert.ok(g.cameras.main.scrollX > 0);
    g.setPauseReason('focus', true);
    const snapshot = JSON.stringify(g.run), scroll = g.cameras.main.scrollX;
    for (let frame = 0; frame < 30; frame++) g.update(1100 + frame * 16, 16);
    assert.equal(JSON.stringify(g.run), snapshot); assert.equal(g.cameras.main.scrollX, scroll);
    g.setPauseReason('focus', false);
    const distance = g.run.distance;
    g.update(2000, 16); assert.equal(g.run.distance, distance);
    g.events.emit('shutdown');
    assert.equal(g.game.events.eventNames().length, 0);
}

// Real overlay renderers and touch buttons retain screen-space scroll factors/input coordinates.
{
    const { game: g, objects } = fixture(); g.cameras.main.setScroll(8000, 0);
    const { createUpgradePanel } = load('ui/UpgradePanel');
    let chosen;
    const panel = createUpgradePanel(g, 2, [{ title: 'POWER', description: '+1 damage' }], index => { chosen = index; });
    assert.equal(panel.scrollFactorX, 0);
    assert.ok(panel.children.filter(child => child.eventNames().includes('pointerdown'))
        .every(child => child.scrollFactorX === 0 && child.scrollFactorY === 0));
    const card = panel.children.find(child => child.eventNames().includes('pointerdown'));
    card.emit('pointerdown'); assert.equal(chosen, 0); assert.equal(card.x, 512);
    const { createGameOverPanel } = load('ui/GameOverPanel');
    const before = objects.length;
    createGameOverPanel(g, g.run, () => {}, () => {}, 'TRY AGAIN');
    assert.ok(objects.slice(before).filter(object => object !== panel).every(object => object.scrollFactorX === 0));
    const controlsStart = objects.length;
    installKeyboard(g); new PlayerInput(g, () => g.run.phase === 'playing');
    assert.ok(objects.slice(controlsStart).every(object => object.scrollFactorX === 0));
    const { Hud } = load('ui/Hud'); const hud = new Hud(g);
    assert.equal(hud.text.scrollFactorX, 0); assert.equal(hud.text.x, 18);
    assert.equal(g.rosie.panel.scrollFactorX, 0);
    assert.equal(g.rosie.panel.children.length, 3); // Portrait card, face, speech; no cage bars.
    g.events.emit('shutdown');
}

// Rosie appears briefly and occasionally; hide and dialogue timers obey scene pause/cleanup.
{
    const { game: g, rosie, advance, timers } = fixture('candy');
    assert.equal(rosie.panel.visible, true);
    advance(WORLD.rosieLineDuration); assert.equal(rosie.panel.visible, false);
    advance(WORLD.rosieDialogueInterval - WORLD.rosieLineDuration);
    assert.equal(rosie.panel.visible, true); assert.equal(rosie.speech.textChanges, 1);
    g.setPhase('paused'); advance(10000); assert.equal(rosie.panel.visible, true);
    g.setPhase('playing'); advance(WORLD.rosieLineDuration); assert.equal(rosie.panel.visible, false);
    g.events.emit('shutdown'); assert.ok(timers.every(timer => timer.removed));
}
console.log('PASS adventure Stage 1: free movement/world bounds, smooth bounded camera, world spawns, far-world combat/XP, static scenery, fixed UI, intermittent Rosie and pause/restart cleanup.');

// Camera framing is position-based: turning without moving must not swing the world.
{
    const { game: g } = fixture();
    const player = new Player(g, g.run, g.groundY);
    player.sprite.x = 5000;
    for (let i = 0; i < 180; i++) g.worldCamera.update(player.x, 1 / 60);
    const scroll = g.cameras.main.scrollX;
    for (const left of [true, false, true, false]) {
        player.update({ left, right: !left, jump: false }, 0);
        g.worldCamera.update(player.x, 1 / 60);
        assert.equal(g.cameras.main.scrollX, scroll);
        assert.ok(Math.abs(player.x - scroll - 1024 * WORLD.rightFollowRatio) < 1e-7);
    }
    g.events.emit('shutdown');
}

// World occupants stay fixed, survive backtracking and cannot stream/pile up while idle.
{
    const { game: g } = fixture();
    for (let i = 0; i < 2400; i++) { g.run.runTime += 0.05; g.enemySystem.update(0.05, () => {}); }
    assert.equal(g.enemySystem.enemies.length, 2); // One viewport of preparation, no timed stream.
    const first = g.enemySystem.enemies[0];
    assert.equal(first.sprite.x, WORLD.enemyStartX); assert.equal(first.sprite.scrollFactorX, 1);
    g.cameras.main.setScroll(5000, 0);
    for (let i = 0; i < 60; i++) g.enemySystem.update(0.05, () => {});
    assert.equal(first.sprite.x, WORLD.enemyStartX); assert.equal(first.sprite.active, false);
    g.cameras.main.setScroll(0, 0); g.enemySystem.update(0.05, () => {});
    const restored = g.enemySystem.enemies.find(enemy => enemy.placementX === WORLD.enemyStartX);
    assert.equal(restored.sprite.x, WORLD.enemyStartX); assert.equal(restored.sprite.visible, true);
    g.enemySystem.damage(restored, restored.hp);
    for (let i = 0; i < 2400; i++) g.enemySystem.update(0.05, () => {});
    assert.ok(g.enemySystem.enemies.every(enemy => enemy.sprite.x !== WORLD.enemyStartX));
    assert.equal(g.enemySystem.records.get(breadPlacementId(g.run.seed, WORLD.enemyStartX)).defeated, true);
    g.events.emit('shutdown'); assert.equal(g.enemySystem.records.size, 0);
}

function explorationFixture(characterId = 'llamaCrunch') {
    const result = fixture(characterId);
    result.game.events.emit('shutdown');
    installKeyboard(result.game); result.game.init({ characterId }); result.game.create();
    result.game.enemySystem.update = () => {}; // Isolate travel from contact damage.
    return result;
}

// Placement data exists before travel; sprites are prepared off-screen without a timer.
{
    const { game: g } = fixture();
    assert.equal(g.enemySystem.records.size, 0);
    g.enemySystem.prepare();
    assert.equal(g.enemySystem.enemies.length, 2);
    const first = g.enemySystem.enemies[0];
    first.hp = 7;
    const seen = new Set(g.enemySystem.enemies);
    for (let scroll = 0; scroll < 9000; scroll += 10) {
        g.cameras.main.setScroll(scroll, 0);
        g.enemySystem.update(0, enemy => {
            assert.equal(enemy.sprite.visible, true, 'No distant contact processing');
        });
        for (const enemy of g.enemySystem.enemies) {
            if (!seen.has(enemy)) {
                assert.ok(enemy.sprite.x - 29 > scroll + 1024, 'New bread must be fully outside viewport');
                seen.add(enemy);
            }
        }
        for (const x of [0, 1, 2, 3, 4].flatMap(index => generateSection(index, g.run.seed).enemies.map(enemy => enemy.x)).filter(x => x >= scroll && x <= scroll + 1024)) {
            assert.ok(g.enemySystem.enemies.some(enemy => enemy.sprite.x === x), 'Every visible slot already prepared');
        }
    }
    assert.ok(g.enemySystem.enemies.length <= 11, 'Live enemies remain bounded');
    assert.equal(first.hp, 7);
    const defeated = g.enemySystem.enemies[3]; const defeatedX = defeated.sprite.x;
    g.enemySystem.damage(defeated, defeated.hp);
    for (let scroll = 9000; scroll >= 0; scroll -= 10) {
        g.cameras.main.setScroll(scroll, 0); g.enemySystem.update(0, () => {});
        for (const enemy of g.enemySystem.enemies) {
            if (!seen.has(enemy)) {
                assert.ok(enemy.sprite.x + 29 < scroll || enemy.sprite.x - 29 > scroll + 1024,
                    'Restored bread must also be fully outside viewport on approach');
                seen.add(enemy);
            }
        }
    }
    const restored = g.enemySystem.enemies.find(enemy => enemy.placementX === WORLD.enemyStartX);
    assert.equal(restored.hp, 7);
    assert.notEqual(restored, first);
    assert.ok(!g.enemySystem.enemies.some(enemy => enemy.sprite.x === defeatedX));
    assert.equal(g.run.runTime, 0, 'Preparation has no timer dependency');
    g.events.emit('shutdown');
    assert.equal(g.enemySystem.records.size, 0);
}

// The real scene starts with its off-screen occupants ready before rendering.
{
    const { game: g } = explorationFixture();
    assert.equal(g.enemySystem.enemies.length, 2);
    assert.ok(g.enemySystem.enemies.every(enemy => enemy.sprite.x - 29 > 1024));
    g.events.emit('shutdown');
}

// Progress is a furthest-world-X high-water mark, not accumulated movement or idle time.
{
    const { game: g } = explorationFixture();
    const walk = (key, frames) => {
        g.playerInput.keys.D.isDown = key === 'D'; g.playerInput.keys.A.isDown = key === 'A';
        for (let frame = 0; frame < frames; frame++) g.update(frame * 1000 / 60, 1000 / 60);
    };
    walk('D', 60); const first = g.run.distance;
    assert.ok(Math.abs(first - 280 / WORLD.pixelsPerMetre) < 1e-7);
    walk('A', 60); assert.equal(g.run.distance, first);
    walk('D', 30); assert.equal(g.run.distance, first);
    walk('', 60); assert.equal(g.run.distance, first);
    walk('D', 60); assert.ok(g.run.distance > first);
    assert.ok(Math.abs(g.run.distance - 420 / WORLD.pixelsPerMetre) < 1e-7);
    assert.equal(g.run.furthestX, g.player.x);
    g.events.emit('shutdown');
}

// Low render rates must not reduce movement speed by discarding delta above 50 ms.
for (const fps of [60, 20, 15, 8]) {
    const { game: g } = explorationFixture();
    g.playerInput.keys.D.isDown = true;
    for (let frame = 0; frame < fps; frame++) g.update(frame * 1000 / fps, 1000 / fps);
    assert.ok(Math.abs(g.player.x - 450) < 1e-7, `${fps} FPS movement differs`);
    assert.ok(Math.abs(g.run.runTime - 1) < 1e-7);
    assert.ok(Math.abs(g.run.distance - 280 / WORLD.pixelsPerMetre) < 1e-7);
    g.events.emit('shutdown');
}

// Unsmoothed 30 FPS time yields identical early/late speed for either character.
for (const [characterId, speed] of [['llamaCrunch', 280], ['candy', 350]]) {
    const { game: g } = explorationFixture(characterId);
    // Measure unobstructed speed independently of living enemy blockers.
    g.enemySystem.resolvePlayerMovement = (_from, to) => to;
    g.playerInput.keys.D.isDown = true;
    for (let second = 0; second < 8; second++) {
        const startX = g.player.x;
        for (let frame = 0; frame < 30; frame++) g.update(0, 1000 / 30);
        assert.ok(Math.abs(g.player.x - startX - speed) < 1e-7);
        assert.equal(g.run.moveSpeed, speed);
    }
    g.events.emit('shutdown');
}

// Scenery is static world geometry and only the visible strip is submitted for rendering.
{
    const { game: g } = explorationFixture();
    const scenery = () => [...g.world.sections.values()].flatMap(section => section.scenery);
    const coordinates = scenery().map(block => block.x);
    assert.ok(scenery().filter(block => block.visible).length <= 12);
    assert.ok(scenery().every(block => block.scrollFactorX === 1));
    g.cameras.main.setScroll(8000, 0); g.world.update();
    assert.ok(scenery().filter(block => block.visible).length <= 12);
    assert.ok(scenery().filter(block => block.visible).every(block => block.x > 7000));
    g.cameras.main.setScroll(0, 0); g.world.update();
    assert.equal(scenery()[0].visible, true);
    assert.deepEqual(scenery().filter(block => block.x < WORLD.sectionLength).map(block => block.x),
        coordinates.filter(x => x < WORLD.sectionLength));
    g.events.emit('shutdown');
}

// Temporary coordinate/FPS overlay reports world-to-screen maths and redraws at most 5 Hz.
{
    const { game: g } = fixture();
    const { WorldDebug } = load('ui/WorldDebug');
    g.player.x = 2500; g.cameras.main.setScroll(2100, 0);
    g.enemySystem.spawnBread(2600);
    const debug = new WorldDebug(g);
    debug.update(g.player, g.cameras.main, g.enemySystem.enemies, 16);
    const text = debug.text.text.join('\n');
    assert.ok(text.includes('Player world X:  2500.0'));
    assert.ok(text.includes('Camera scroll X: 2100.0'));
    assert.ok(text.includes('Player screen X: 400.0'));
    assert.ok(text.includes('Enemy world X:   2600.0'));
    assert.equal(debug.text.scrollFactorX, 0);
    const updates = debug.text.textChanges;
    for (let i = 0; i < 199; i++) debug.update(g.player, g.cameras.main, g.enemySystem.enemies, 1);
    assert.equal(debug.text.textChanges, updates);
    debug.update(g.player, g.cameras.main, g.enemySystem.enemies, 1);
    assert.equal(debug.text.textChanges, updates + 1);
    g.events.emit('shutdown');
}
console.log('PASS world corrections: stable framing on turns, persistent fixed enemies, no idle spawn stream, furthest-forward progress, render culling, low-FPS speed and throttled coordinate diagnostics.');

// Diagnostics use raw elapsed time, detecting half-speed simulation even when FPS is stable.
for (const simulationRatio of [0.5, 1]) {
    const { game: g } = fixture();
    const { WorldDebug } = load('ui/WorldDebug');
    const debug = new WorldDebug(g);
    g.game.loop = { rawDelta: 1000 / 30, actualFps: 30 };
    debug.resetSample(g.player, g.cameras.main);
    for (let frame = 0; frame < 240; frame++) {
        g.player.x += 280 / 30 * simulationRatio;
        debug.update(g.player, g.cameras.main, [], 1000 / 30 * simulationRatio,
            1000 / 30 * simulationRatio, 280);
        if (frame === 29 || frame === 239) {
            const text = debug.text.text.join('\n');
            assert.ok(text.includes(`World speed: ${(280 * simulationRatio).toFixed(1)} / 280 units/s`));
            assert.ok(text.includes(`Sim / real time: ${simulationRatio.toFixed(2)}x`));
        }
    }
    debug.resetSample(g.player, g.cameras.main);
    assert.equal(debug.elapsed, 0); assert.equal(debug.travelled, 0);
    g.events.emit('shutdown');
}
console.log('PASS startup fixes: unsmoothed engine time, raw-time speed diagnostics, off-screen preparation, bounded active occupants, persistent health/deaths and no timed pop-in.');

// Endless section descriptors are deterministic, contiguous and preserve the original lattices.
{
    const a = generateSection(25, 12345), b = generateSection(25, 12345);
    assert.deepEqual(a, b);
    assert.notEqual(a.seed, generateSection(25, 54321).seed);
    assert.equal(a.endX, generateSection(26, 12345).startX);
    assert.ok(a.enemies.every(({ x }) => x >= a.startX && x < a.endX && (x - WORLD.enemyStartX) % WORLD.enemySpacing === 0));
    assert.ok(a.sceneryXs.every(x => x >= a.startX && x < a.endX && x % 160 === 0));
    assert.equal(createRunState('candy', 12345).seed, 12345);
}

// Distant occupants release sprites, retaining wounds/difficulty/deaths across many sections.
{
    const { game: g } = fixture(); g.run.seed = 12345; g.enemySystem.prepare();
    const wounded = g.enemySystem.enemies[0]; wounded.hp = 7;
    g.enemySystem.damage(wounded, 2);
    const speed = wounded.speed, dead = g.enemySystem.enemies[1], deadX = dead.placementX;
    g.enemySystem.damage(dead, dead.hp);
    for (let index = 1; index < 200; index++) {
        g.cameras.main.setScroll(index * WORLD.sectionLength, 0);
        g.run.runTime += 60;
        g.world.update(); g.enemySystem.prepare();
        assert.ok(g.world.sections.size <= 5);
        assert.ok(g.enemySystem.enemies.length <= 14);
    }
    assert.equal(wounded.sprite.active, false);
    for (let index = 199; index >= 0; index--) {
        g.cameras.main.setScroll(index * WORLD.sectionLength, 0);
        g.world.update(); g.enemySystem.prepare();
    }
    const restored = g.enemySystem.enemies.find(enemy => enemy.placementX === wounded.placementX);
    assert.equal(restored.hp, 5); assert.equal(restored.speed, speed);
    assert.ok(!g.enemySystem.enemies.some(enemy => enemy.placementX === deadX));
    assert.equal(g.enemySystem.records.get(dead.placementId).defeated, true);
    g.events.emit('shutdown'); assert.equal(g.world.sections.size, 0); assert.equal(g.enemySystem.records.size, 0);
}

// Uncollected XP streams out/in exactly once at its last attracted position; collected XP stays gone.
{
    const { game: g } = fixture();
    const originalX = g.player.x + 55, y = g.player.y;
    g.xpSystem.dropGem(originalX, y); g.xpSystem.update(0.01);
    const x = g.xpSystem.gems[0].sprite.x;
    assert.ok(x < originalX);
    g.cameras.main.setScroll(30000, 0); g.player.x = 30400;
    g.xpSystem.update(0);
    assert.equal(g.xpSystem.gems.length, 0);
    assert.equal(g.xpSystem.dormant.get(0).length, 1);
    g.cameras.main.setScroll(0, 0); g.player.x = 170;
    for (let i = 0; i < 10; i++) g.xpSystem.update(0);
    assert.equal(g.xpSystem.gems.length, 1); assert.equal(g.xpSystem.gems[0].sprite.x, x);
    assert.equal(g.xpSystem.dormant.size, 0);
    g.player.x = x; g.xpSystem.update(0);
    assert.equal(g.run.xp, 1); assert.equal(g.xpSystem.gems.length, 0);
    for (const scroll of [30000, 0, 50000, 0]) {
        g.cameras.main.setScroll(scroll, 0); g.player.x = scroll + 400; g.xpSystem.update(0);
        assert.equal(g.xpSystem.gems.length, 0); assert.equal(g.xpSystem.dormant.size, 0);
    }
    assert.equal(g.run.xp, 1);
    // Existing magnet upgrades must also reach dormant drops beyond the visible viewport.
    g.cameras.main.setScroll(0, 0); g.player.x = 170; g.xpSystem.dropGem(200, y);
    g.cameras.main.setScroll(30000, 0); g.player.x = 30400; g.xpSystem.update(0);
    g.run.magnetRadius = 31000; g.xpSystem.update(0.01);
    assert.equal(g.xpSystem.dormant.size, 0); assert.equal(g.xpSystem.gems.length, 1);
    g.events.emit('shutdown'); assert.equal(g.xpSystem.dormant.size, 0);
}

// Live terrain/enemy/XP objects stay bounded over long travel with drops left behind.
{
    const { game: g, objects } = fixture();
    let maxActive = 0;
    for (let index = 0; index < 1000; index++) {
        const scroll = index * WORLD.sectionLength;
        g.cameras.main.setScroll(scroll, 0); g.player.x = scroll + 400;
        g.world.update(); g.enemySystem.prepare();
        g.xpSystem.dropGem(scroll + 900, g.player.y); g.xpSystem.update(0);
        const active = objects.filter(object => object.active).length;
        maxActive = Math.max(maxActive, active);
        assert.ok(active < 320, `Live objects grew at section ${index}: ${active}`);
        assert.ok(g.xpSystem.gems.length <= 5);
    }
    assert.ok(g.enemySystem.records.size > 1000, 'Persistent records, not sprites, retain visited state');
    assert.ok(g.xpSystem.dormant.size > 900, 'Uncollected rewards remain available');
    console.log(`PASS streaming growth: 1,000 sections / 2.56 million world units, maximum ${maxActive} live objects (including children).`);
    g.events.emit('shutdown');
    assert.equal(objects.filter(object => object.active && object.scrollFactorX === 1).length, 0);
}

// The real scene walks beyond the previous endpoint with continuous speed/framing/progress.
for (const characterId of ['llamaCrunch', 'candy']) {
    const { game: g } = explorationFixture(characterId);
    // Isolate world extension/camera from combat obstacles and destructible walls.
    g.enemySystem.resolvePlayerMovement = (_from, to) => to;
    g.world.resolvePlayerMovement = (_from, to) => to;
    g.player.sprite.x = 15500;
    for (let i = 0; i < 180; i++) g.worldCamera.update(g.player.x, 1 / 60);
    g.playerInput.keys.D.isDown = true;
    let previousScroll = g.cameras.main.scrollX;
    for (let i = 0; i < 180; i++) {
        g.update(i * 1000 / 30, 1000 / 30);
        assert.ok(g.cameras.main.scrollX >= previousScroll);
        assert.ok(g.cameras.main.scrollX - previousScroll < 15, 'No camera jump on extension');
        previousScroll = g.cameras.main.scrollX;
    }
    assert.ok(g.player.x > 17000);
    assert.ok(Math.abs(g.player.x - 15500 - CHARACTERS[characterId].moveSpeed * 6) < 1e-6);
    const distance = g.run.distance;
    g.playerInput.keys.D.isDown = false; g.playerInput.keys.A.isDown = true;
    for (let i = 0; i < 300; i++) g.update(0, 1000 / 30);
    assert.equal(g.run.distance, distance);
    g.events.emit('shutdown');
}
console.log('PASS endless foundation: seeded sections, unbounded forward movement/camera, persistent wounds/deaths/rewards, bounded live objects, cleanup and forward-only scoring.');

// Arbitrarily upgraded melee reach still has loaded targets outside the normal buffer.
{
    const { game: g } = fixture();
    g.run.weapon.range = 10000;
    g.enemySystem.prepare();
    const distant = g.enemySystem.enemies.find(enemy => enemy.sprite.x > 9000);
    assert.ok(distant);
    g.enemySystem.prepare();
    assert.ok(g.enemySystem.enemies.includes(distant));
    assert.equal(distant.sprite.active, true);
    assert.equal(g.run.weapon.range, 10000);
    g.events.emit('shutdown');
}

// Re-entering sections cannot duplicate terrain, enemy placements, or live/dormant rewards.
{
    const { game: g, objects } = fixture();
    g.enemySystem.prepare();
    const wounded = g.enemySystem.enemies[0], dead = g.enemySystem.enemies[1];
    wounded.hp = 7; g.enemySystem.damage(wounded, 2); g.enemySystem.damage(dead, dead.hp);
    const woundedId = wounded.placementId, deadId = dead.placementId;
    // Two legitimate drops at the same position must remain distinct, exactly once each.
    g.xpSystem.dropGem(800, g.player.y - 200);
    g.xpSystem.dropGem(800, g.player.y - 200);
    const rewardIds = Array.from(g.xpSystem.gems, gem => gem.id);
    g.xpSystem.dropGem(1800, g.player.y);
    const collectedId = g.xpSystem.gems.at(-1).id;
    g.player.x = 1800; g.xpSystem.update(0); assert.equal(g.run.xp, 1);
    const descriptions = new Map();
    // Track section-owned objects by identity: terrain now includes multiple
    // landmark shape families, not just the original three rectangle colours.
    const sectionObjectsSeen = new Set();
    let maxActive = 0;
    const check = scroll => {
        g.cameras.main.setScroll(scroll, 0); g.player.x = scroll + 400;
        g.run.runTime += 0.1;
        // Repeated preparation at an identical boundary must be idempotent.
        for (let repeat = 0; repeat < 3; repeat++) {
            g.world.update(); g.enemySystem.prepare(); g.xpSystem.update(0);
        }
        const terrain = [];
        for (const [index, section] of g.world.sections) {
            assert.equal(section.data.id, `${g.run.seed}:${index}`);
            if (!descriptions.has(index)) descriptions.set(index, JSON.stringify(section.data));
            assert.equal(JSON.stringify(section.data), descriptions.get(index));
            terrain.push(...section.objects);
        }
        for (const object of terrain) {
            assert.equal(object.active, true, 'Loaded section objects are active');
            sectionObjectsSeen.add(object);
        }
        const liveWorld = [...sectionObjectsSeen].filter(object => object.active);
        assert.equal(liveWorld.length, terrain.length, 'No live orphan terrain after unload/reload');
        assert.ok(liveWorld.every(object => terrain.includes(object)));
        const enemies = g.enemySystem.enemies;
        assert.equal(new Set(enemies.map(enemy => enemy.placementId)).size, enemies.length);
        assert.ok(!enemies.some(enemy => enemy.placementId === deadId));
        const restored = enemies.find(enemy => enemy.placementId === woundedId);
        if (restored) assert.equal(restored.hp, 5);
        const drops = [...g.xpSystem.gems.map(gem => ({ id: gem.id, x: gem.sprite.x, y: gem.sprite.y, value: gem.value })),
            ...[...g.xpSystem.dormant.values()].flat()];
        const dropIds = drops.map(gem => gem.id);
        assert.equal(new Set(dropIds).size, drops.length, 'A drop cannot be both live and dormant');
        assert.deepEqual(dropIds.sort((a, b) => a - b), rewardIds);
        assert.ok(!dropIds.includes(collectedId));
        assert.ok(drops.every(drop => drop.x === 800 && drop.y === g.player.y - 200 && drop.value === 1));
        assert.equal(g.run.xp, 1);
        maxActive = Math.max(maxActive, objects.filter(object => object.active).length);
        assert.ok(g.world.sections.size <= 5); assert.ok(enemies.length <= 14);
    };
    const end = WORLD.sectionLength * 12;
    for (let scroll = 0; scroll <= end; scroll += 160) check(scroll);
    const savedEnemyState = JSON.stringify([...g.enemySystem.records].sort());
    for (let scroll = end; scroll >= 0; scroll -= 160) check(scroll);
    assert.equal(JSON.stringify([...g.enemySystem.records].sort()), savedEnemyState);
    for (let scroll = 0; scroll <= end; scroll += 160) check(scroll);
    assert.equal(JSON.stringify([...g.enemySystem.records].sort()), savedEnemyState);
    assert.ok(maxActive < 300, `Section streaming should remain bounded with landmarks: ${maxActive}`);
    g.events.emit('shutdown');
    assert.equal(g.world.sections.size, 0); assert.equal(g.enemySystem.records.size, 0);
    assert.equal(g.xpSystem.gems.length, 0); assert.equal(g.xpSystem.dormant.size, 0);
    console.log(`PASS round-trip sections: forward/back/forward across 12 sections, stable IDs/state, no duplicate terrain/enemies/XP, maximum ${maxActive} live objects.`);
}

// Duplicate preparation cannot create a second instance or award a second death.
{
    const { game: g } = fixture();
    const first = g.enemySystem.spawnBread();
    assert.equal(g.enemySystem.spawnBread(), first);
    assert.equal(g.enemySystem.enemies.length, 1);
    assert.equal(g.enemySystem.damage(first, first.hp), true);
    const hp = first.hp;
    assert.equal(g.enemySystem.damage(first, 2), false); assert.equal(first.hp, hp);
    assert.equal(g.enemySystem.spawnBread(), undefined);
    assert.equal(g.enemySystem.enemies.length, 0);
    // Content IDs, rather than coordinates, distinguish future colocated placements.
    const a = g.enemySystem.spawnBread(2000, 'test:placement:a');
    const b = g.enemySystem.spawnBread(2000, 'test:placement:b');
    assert.notEqual(a, b); assert.equal(g.enemySystem.records.size, 3);
    g.events.emit('shutdown');
}

// Mobile widens the view without changing vertical world units or desktop FIT layout.
{
    const { viewportWidth } = load('ui/layout');
    for (const [width, height] of [[844, 390], [852, 393], [932, 430], [915, 412], [740, 360]]) {
        assert.ok(Math.abs(viewportWidth(width, height, true) * height / 768 - width) < 1);
        assert.equal(viewportWidth(width, height, false), 1024);
    }
    assert.equal(viewportWidth(390, 844, true), 1024);
    mobileLayout = true;
    parentElement.clientWidth = 750; parentElement.clientHeight = 369; // safe-area-adjusted parent
    const engine = load('main').default('game-container');
    assert.equal(engine.config.height, 768);
    assert.equal(engine.config.width, viewportWidth(750, 369, true));
    const resize = observers.at(-1);
    const refreshOrder = [];
    engine.scale.getParentBounds = () => refreshOrder.push('parent');
    const setSize = engine.scale.setGameSize;
    engine.scale.setGameSize = (...args) => { refreshOrder.push('size'); setSize(...args); };
    parentElement.clientWidth = 820; parentElement.clientHeight = 370; resize.callback();
    assert.equal(engine.scale.width, viewportWidth(820, 370, true));
    assert.equal(engine.scale.height, 768);
    assert.deepEqual(refreshOrder, ['parent', 'size']);
    engine.events.emit('destroy'); assert.equal(resize.disconnected, true);
    delete parentElement.clientWidth; delete parentElement.clientHeight;
    mobileLayout = false;
}

// Joystick has one independent owner, binary full-speed direction, a neutral zone and clean release.
mobileLayout = true;
for (let cycle = 0; cycle < 10; cycle++) {
    const { game: g, objects } = fixture(); installKeyboard(g);
    g.scale.width = 1662; g.cameras.main.width = 1662;
    const input = new PlayerInput(g, () => g.run.phase === 'playing');
    g.playerInput = input; g.bindPauseEvents();
    const joystick = input.joystick;
    const actions = objects.filter(object => object.kind === 'circle' && object.args[0] === 70);
    const jump = actions[0], attack = actions[1];
    const p1 = { id: 1, x: 128, y: 642 }, p2 = { id: 2 }, p3 = { id: 3 };
    joystick.base.emit('pointerdown', p1); assert.equal(input.readActions().right, false);
    g.input.emit('pointermove', { ...p1, x: 144 }); assert.equal(input.readActions().right, false);
    g.input.emit('pointermove', { ...p1, x: 175 }); assert.equal(input.readActions().right, true);
    jump.emit('pointerdown', p2); attack.emit('pointerdown', p3);
    assert.equal(input.readActions().jump, true); assert.equal(input.readActions().attack, true);
    joystick.base.emit('pointerdown', { id: 4, x: 50 });
    g.input.emit('pointermove', { id: 4, x: 50 }); assert.equal(input.readActions().right, true);
    g.input.emit('pointermove', { ...p1, x: 20 });
    assert.equal(input.readActions().left, true); assert.equal(input.readActions().right, false);
    // Moving beyond the circle keeps ownership until that finger lifts/cancels.
    joystick.base.emit('pointerout', p1); assert.equal(input.readActions().left, true);
    g.input.emit('pointerup', p2);
    assert.equal(input.readActions().jump, false); assert.equal(input.readActions().left, true);
    assert.equal(input.readActions().attack, true);
    g.input.emit('pointerupoutside', p1);
    assert.equal(input.readActions().left, false); assert.equal(input.readActions().attack, true);
    assert.equal(joystick.thumb.x, joystick.base.x);
    g.input.emit('pointerup', p3); assert.equal(input.readActions().attack, false);
    // Resize and interruption cancel all held inputs, without changing run stats/position.
    joystick.base.emit('pointerdown', { ...p1, x: 180 });
    const state = JSON.stringify(g.run);
    g.scale.width = 1800; g.scale.emit('resize');
    assert.equal(input.readActions().right, false); assert.equal(joystick.pointerId, undefined);
    assert.equal(attack.x, 1698); assert.equal(JSON.stringify(g.run), state);
    joystick.base.emit('pointerdown', { ...p1, x: 180 });
    g.game.events.emit('blur'); g.game.events.emit('focus'); assert.equal(input.readActions().right, false);
    joystick.base.emit('pointerdown', { ...p1, x: 180 });
    orientation.matches = true; orientation.emit('change'); assert.equal(joystick.pointerId, undefined);
    orientation.matches = false; orientation.emit('change'); assert.equal(g.run.phase, 'playing');
    g.run.xp = 3; g.xpSystem.checkLevelUp(); joystick.base.emit('pointerdown', { ...p1, x: 180 });
    assert.equal(input.readActions().right, false); g.chooseUpgrade(0);
    g.events.emit('shutdown'); assert.equal(g.input.listenerCount('pointermove'), 0);
    assert.equal(g.scale.listenerCount('resize'), 0); assert.equal(joystick.pointerId, undefined);
    assert.equal(orientation.listenerCount('change'), 0);
}

// Mobile HUD omits desktop instructions; modals redraw without accumulating click targets.
{
    const { game: g, objects } = fixture(); g.scale.width = 1662;
    const { Hud } = load('ui/Hud'), hud = new Hud(g); hud.update(g.run, 3);
    const hudText = hud.text.text.join('\n');
    assert.ok(hudText.includes('♥ 6/6')); assert.ok(hudText.includes('XP 0/3')); assert.ok(hudText.includes('Sword Slash'));
    assert.ok(!hudText.includes('J =')); assert.equal(hud.text.args[1].fontSize, '32px');
    const { createUpgradePanel } = load('ui/UpgradePanel'); let chosen;
    const panel = createUpgradePanel(g, 2, [{ title: 'POWER', description: '+1 damage' }], index => chosen = index);
    const previous = panel.children.find(child => child.eventNames().includes('pointerdown'));
    for (const width of [1500, 1800, 1662]) { g.scale.width = width; g.scale.emit('resize'); }
    assert.equal(previous.active, false);
    const cards = panel.children.filter(child => child.eventNames().includes('pointerdown'));
    assert.equal(cards.length, 1); assert.equal(cards[0].x, 831); assert.equal(cards[0].scrollFactorX, 0);
    cards[0].emit('pointerdown'); assert.equal(chosen, 0);
    panel.destroy();
    assert.ok(!objects.some(object => object.active && object.visible !== false && object.eventNames().includes('pointerdown')));
    g.events.emit('shutdown'); assert.equal(g.scale.listenerCount('resize'), 0);
}
mobileLayout = false;
assert.equal(WORLD.debugOverlay, false);
console.log('PASS mobile UX: aspect-preserving viewport sizing, independent joystick/jump/attack, dead zone, cancellation/resizing/rotation/10 restarts, readable fixed HUD/modals and debug off by default.');

// Fullscreen is mobile/gesture opt-in at the menu and safely falls back when unavailable.
{
    const { requestMobileFullscreen } = load('ui/layout');
    let requested = 0;
    parentElement.requestFullscreen = options => { requested++; assert.equal(options.navigationUI, 'hide'); return Promise.reject(new Error('Unavailable')); };
    documentStub.fullscreenEnabled = true;
    requestMobileFullscreen(); assert.equal(requested, 0); // desktop
    mobileLayout = true; documentStub.fullscreenEnabled = false;
    requestMobileFullscreen(); assert.equal(requested, 0);
    documentStub.fullscreenEnabled = true;
    requestMobileFullscreen(); assert.equal(requested, 1); // rejection has a handler
    documentStub.fullscreenElement = {};
    requestMobileFullscreen(); assert.equal(requested, 1);
    delete documentStub.fullscreenEnabled; delete documentStub.fullscreenElement; delete parentElement.requestFullscreen;
    mobileLayout = false;
}


// Handheld Safari/Android still use the full usable viewport when pointer queries differ.
{
    const { isMobileLayout, viewportWidth } = load('ui/layout');
    mobileLayout = false;
    windowStub.navigator = { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone)' };
    assert.equal(isMobileLayout(), true);
    assert.equal(viewportWidth(750, 369, isMobileLayout()), 1561);
    windowStub.navigator = { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh)' };
    assert.equal(isMobileLayout(), false);
    delete windowStub.navigator;
}

// Adventure Stage 2B: both weapons use their existing geometry/cooldowns against crates.
{
    const { game: g } = fixture(); g.structures.prepare();
    const crate = g.structures.crates.find(crate => crate.placement.x === 620);
    assert.equal(crate.hp, 3); g.player.x = 530;
    g.combatSystem.attack(); assert.equal(crate.hp, 1); assert.equal(g.run.kills, 0);
    g.combatSystem.attack(); assert.equal(crate.hp, 1); // same swing/cooldown cannot hit twice
    g.run.runTime = 0.5; g.combatSystem.attack();
    assert.equal(g.structures.records.get(crate.placement.id).destroyed, true);
    assert.equal(g.xpSystem.gems.length, 1); assert.equal(g.run.kills, 0);
    g.structures.damageCrate(crate, 100); assert.equal(g.xpSystem.gems.length, 1);
    g.player.x = 620; g.xpSystem.update(0); assert.equal(g.run.xp, 1);
    g.cameras.main.setScroll(20000, 0); g.structures.prepare();
    g.cameras.main.setScroll(0, 0); g.structures.prepare();
    assert.ok(!g.structures.crates.some(item => item.placement.id === crate.placement.id));
    g.events.emit('shutdown'); assert.equal(g.structures.effects.size, 0);
}
{
    const { game: g } = fixture('candy'); g.structures.prepare(); g.player.x = 500;
    const crate = g.structures.crates.find(crate => crate.placement.x === 620);
    const enemy = g.enemySystem.spawnBread(700);
    for (const [time, expectedHp] of [[0, 2], [0.9, 1], [1.8, 0]]) {
        g.run.runTime = time; g.combatSystem.attack(); g.combatSystem.update(0.2);
        assert.equal(crate.hp, expectedHp); assert.equal(enemy.hp, enemy.maxHealth);
        assert.equal(g.combatSystem.projectiles.length, 0, 'Crate impact consumes a non-piercing shot');
    }
    assert.equal(g.xpSystem.gems.length, 1); assert.equal(g.run.kills, 0);
    g.events.emit('shutdown');
}
{
    const { game: g, advance } = fixture(); g.structures.prepare();
    const [first, second] = g.structures.crates;
    second.sprite.x = first.sprite.x + 25; g.player.x = first.sprite.x - 60;
    g.combatSystem.attack(); assert.equal(first.hp, 1); assert.equal(second.hp, 1);
    g.setPhase('choosingUpgrade'); advance(200); assert.equal(first.sprite.alpha, 0.5);
    g.setPhase('playing'); advance(100); assert.equal(first.sprite.alpha, 1);
    g.cameras.main.setScroll(20000, 0); g.structures.prepare();
    assert.equal(first.sprite.active, false);
    g.cameras.main.setScroll(0, 0); g.structures.prepare();
    const restored = g.structures.crates.find(crate => crate.placement.id === first.placement.id);
    assert.equal(restored.hp, 1); assert.equal(restored.sprite.children.length, 6, 'Wounds/cracks persist');
    const gems = g.xpSystem.gems.length;
    g.setPhase('gameOver'); g.structures.damageCrate(restored, 10);
    assert.equal(restored.hp, 1); assert.equal(g.xpSystem.gems.length, gems);
    g.events.emit('shutdown'); assert.equal(g.structures.records.size, 0);
}

// Seeded health rewards persist off-screen, remain available at full health, and collect once.
{
    const { game: g } = fixture();
    let seed = 0;
    while (!generateSection(0, seed).structures[0].healthDrop) seed++;
    g.run.seed = seed; g.structures.prepare(); const crate = g.structures.crates[0];
    const id = `${crate.placement.id}:health`;
    g.structures.damageCrate(crate, crate.hp); g.player.x = crate.sprite.x;
    g.healthPickups.update(); assert.equal(g.healthPickups.active.size, 1);
    assert.equal(g.healthPickups.records.get(id).collected, false);
    g.cameras.main.setScroll(30000, 0); g.player.x = 30400; g.healthPickups.update();
    assert.equal(g.healthPickups.active.size, 0);
    g.cameras.main.setScroll(0, 0); g.player.x = 620; g.run.health--;
    g.healthPickups.update(); assert.equal(g.run.health, g.run.maxHealth);
    assert.equal(g.healthPickups.records.get(id).collected, true);
    g.healthPickups.drop(id, 620, g.player.y); g.run.health--;
    for (const x of [30000, 0, 30000, 0]) { g.cameras.main.setScroll(x, 0); g.healthPickups.update(); }
    assert.equal(g.run.health, g.run.maxHealth - 1); assert.equal(g.healthPickups.active.size, 0);
    g.events.emit('shutdown'); assert.equal(g.healthPickups.records.size, 0);
}

// New environmental systems keep live objects bounded throughout long travel and round trips.
{
    const { game: g, objects } = fixture(); let maximum = 0;
    for (let index = 0; index < 500; index++) {
        const x = index * WORLD.sectionLength;
        g.cameras.main.setScroll(x, 0); g.player.x = x + 400;
        g.world.update(); g.structures.prepare(); g.structures.prepare();
        g.healthPickups.drop(`test:${index}`, x + 800, g.player.y); g.healthPickups.update();
        assert.equal(new Set(g.structures.crates.map(crate => crate.placement.id)).size, g.structures.crates.length);
        assert.ok(g.structures.crates.length < 12); assert.ok(g.healthPickups.active.size < 8);
        maximum = Math.max(maximum, objects.filter(object => object.active).length);
    }
    assert.ok(maximum < 320); console.log(`PASS structures streaming: 500 sections, maximum ${maximum} live objects including health drops.`);
    g.events.emit('shutdown');
}
console.log('PASS Adventure Stage 2B: deterministic crates, shared sword/projectile hits, unchanged cooldowns, persistent damage/destruction, XP/health once, pause/death guards and cleanup.');

// Stage 2C: first chest is early, free upgrade uses the existing modal, and opens only once.
{
    const { game: g } = fixture(); g.run.xp = 2; g.structures.prepare();
    const placement = generateSection(0, g.run.seed).structures.find(item => item.kind === 'chest');
    assert.equal(placement.x, 900); assert.equal(placement.reward, 'upgrade');
    g.player.x = placement.x + STRUCTURES.chest.range + 1;
    g.structures.update(true); assert.equal(g.structures.opened.size, 0);
    g.player.x = placement.x; g.player.y -= 200;
    g.structures.update(true); assert.equal(g.structures.opened.size, 0);
    g.player.y = g.groundY - 40;
    g.setPhase('paused'); g.structures.interact(); assert.equal(g.structures.opened.size, 0);
    g.setPhase('playing'); g.structures.update(); assert.equal(g.structures.prompt.visible, true);
    g.structures.prompt.emit('pointerdown');
    assert.equal(g.run.phase, 'choosingUpgrade'); assert.equal(g.run.level, 1); assert.equal(g.run.xp, 2);
    assert.equal(g.offered.length, 3); assert.equal(g.structures.prompt.visible, false);
    g.structures.interact(); assert.equal(g.structures.opened.size, 1);
    const damage = g.run.weapon.damage; g.chooseUpgrade(0);
    assert.equal(g.run.weapon.damage, damage + 1); assert.equal(g.run.phase, 'playing');
    g.cameras.main.setScroll(25000, 0); g.structures.prepare();
    assert.ok(!g.structures.activeChests.has(placement.id));
    g.cameras.main.setScroll(0, 0); g.structures.prepare(); g.structures.interact();
    assert.equal(g.run.weapon.damage, damage + 1); assert.equal(g.run.xp, 2);
    assert.equal(g.structures.activeChests.get(placement.id).sprite.children[2].args[2], 0x342a31);
    g.events.emit('shutdown'); assert.equal(g.structures.opened.size, 0); assert.equal(g.scale.listenerCount('resize'), 0);
}

// Seeded later chests cover XP/healing; full-health healing converts to XP without duplicate rewards.
for (const reward of ['xp', 'heal']) {
    for (const fullHealth of [false, true]) {
        const { game: g, advance } = fixture();
        let seed = 0, placement;
        do { placement = generateSection(3, seed++).structures.find(item => item.kind === 'chest'); } while (placement.reward !== reward);
        g.run.seed = seed - 1;
        assert.equal(JSON.stringify(generateSection(3, g.run.seed).structures.find(item => item.kind === 'chest')), JSON.stringify(placement));
        g.run.health = fullHealth ? g.run.maxHealth : g.run.maxHealth - 2;
        g.player.x = placement.x; g.cameras.main.setScroll(placement.x - 400, 0); g.structures.prepare();
        g.structures.update(true);
        if (reward === 'heal' && !fullHealth) {
            assert.equal(g.run.health, g.run.maxHealth); assert.equal(g.run.xp, 0); assert.equal(g.run.level, 1);
            assert.ok(g.rewardNotice.text.text.includes('+2 HEALTH'));
        } else {
            assert.equal(g.run.level, 2); assert.equal(g.run.xp, 0); assert.equal(g.run.phase, 'choosingUpgrade');
            assert.ok(g.rewardNotice.text.text.includes('+3 XP'));
            advance(3000); assert.equal(g.rewardNotice.text.visible, true, 'Notice clock pauses with upgrades');
            g.chooseUpgrade(0);
        }
        const snapshot = JSON.stringify(g.run);
        g.structures.interact(); assert.equal(JSON.stringify(g.run), snapshot);
        advance(STRUCTURES.chest.noticeMs); assert.equal(g.rewardNotice.text.visible, false);
        for (const scroll of [0, placement.x - 400, 0, placement.x - 400]) {
            g.cameras.main.setScroll(scroll, 0); g.structures.prepare(); g.structures.update(true);
        }
        assert.equal(JSON.stringify(g.run), snapshot);
        assert.equal(g.structures.opened.size, 1);
        g.events.emit('shutdown');
    }
}

// Real scene coordination consumes E once and stops remaining substeps when chest UI pauses the run.
{
    const { game: g } = explorationFixture();
    g.player.sprite.x = 900; g.playerInput.keys.E._justDown = true;
    g.update(0, 250);
    assert.equal(g.run.phase, 'choosingUpgrade'); assert.equal(g.run.level, 1); assert.equal(g.run.xp, 0);
    assert.ok(Math.abs(g.run.runTime - 0.05) < 1e-8);
    assert.equal(g.playerInput.interactPressed(), false);
    g.chooseUpgrade(0); assert.equal(g.run.phase, 'playing');
    g.update(0, 16); assert.equal(g.run.phase, 'playing');
    g.events.emit('shutdown');
}
console.log('PASS Stage 2C: deterministic early/later chests, contextual tap/E interaction, free upgrades without levelling, XP/healing rewards, persistent opened state, pause-aware notices and cleanup.');


// Bread state progression: no contact damage, committed windup, one strike, recovery and return.
{
    const { game: g } = fixture(); const { BREAD } = load('enemies/bread');
    g.enemySystem.player = g.player; g.player.x = 300;
    const enemy = g.enemySystem.spawnBread(500);
    assert.equal(g.combatSystem.resolveEnemyAttack(enemy), false);
    const strike = e => g.combatSystem.resolveEnemyAttack(e);
    g.enemySystem.update(0.05, strike); assert.equal(enemy.brain.state, 'chase'); assert.ok(enemy.sprite.x < 500);
    g.player.x = enemy.sprite.x - 40;
    g.enemySystem.update(0.05, strike); assert.equal(enemy.brain.state, 'windup'); assert.equal(g.run.health, 6);
    const before = JSON.stringify(enemy.brain); g.setPhase('choosingUpgrade');
    g.enemySystem.update(1, strike); assert.equal(JSON.stringify(enemy.brain), before);
    g.setPhase('playing'); g.enemySystem.update(BREAD.windup, strike);
    assert.equal(enemy.brain.state, 'active'); assert.equal(g.run.health, 5);
    g.enemySystem.update(BREAD.active / 2, strike); assert.equal(g.run.health, 5);
    g.enemySystem.update(BREAD.active / 2, strike); assert.equal(enemy.brain.state, 'recover');
    g.enemySystem.update(BREAD.recovery, strike); g.player.x = enemy.sprite.x + 200;
    g.enemySystem.update(0.05, strike); assert.equal(enemy.brain.facing, 1);
    g.player.x = enemy.sprite.x + BREAD.loseRange + 100;
    g.enemySystem.update(0.05, strike); assert.ok(['return', 'idle'].includes(enemy.brain.state));
    g.events.emit('shutdown');
}
{
    const { game: g } = fixture(); g.enemySystem.player = g.player;
    const enemy = g.enemySystem.spawnBread(2500); enemy.hp = 7; g.enemySystem.damage(enemy, 2);
    g.cameras.main.setScroll(2200, 0); g.player.x = 2750;
    for (let i = 0; i < 25; i++) g.enemySystem.update(0.05, () => false);
    assert.ok(enemy.sprite.x > 2560); const x = enemy.sprite.x, brain = JSON.stringify(enemy.brain), id = enemy.placementId;
    g.cameras.main.setScroll(20000, 0); g.enemySystem.prepare(); assert.equal(enemy.sprite.active, false);
    g.cameras.main.setScroll(x - 400, 0); g.enemySystem.prepare();
    const restored = g.enemySystem.enemies.find(e => e.placementId === id);
    assert.equal(restored.sprite.x, x); assert.equal(restored.hp, 5); assert.equal(JSON.stringify(restored.brain), brain);
    assert.equal(g.enemySystem.damage(restored, 5), true); assert.equal(g.enemySystem.damage(restored, 5), false);
    assert.ok(!g.enemySystem.enemies.includes(restored)); assert.equal(restored.sprite.active, true);
    g.enemySystem.update(load('enemies/bread').BREAD.deathDuration + 0.01, () => false);
    assert.equal(restored.sprite.active, false);
    assert.equal(g.enemySystem.spawnBread(2500, id), undefined);
    g.events.emit('shutdown'); assert.equal(g.enemySystem.occupied.size, 0);
}
console.log('PASS Bread AI: chase both directions, telegraph/one-hit active window/recovery, no contact ticks, pause, return, moving section persistence and immediate death deactivation.');

// Bread patrols and chases must obey terrain support, including actual pits.
{
    const { game: g } = fixture();
    const { BREAD } = load('enemies/bread');
    const { BALANCE } = load('config/balance');
    g.enemySystem.player = g.player;
    g.player.x = 9999;
    const bread = g.enemySystem.spawnBread(500);
    bread.brain.state = 'patrol'; bread.brain.targetX = 700;
    g.enemySystem.setTerrain({
        enemyHeadExposed: () => true,
        standingY: (x, foot) => x < 520 && Math.abs(foot - g.groundY) < 3 ? g.groundY : undefined,
        landingY: (x, from, to) => x < 520 && from <= g.groundY + 1 && to >= g.groundY
            ? g.groundY : undefined
    });
    g.enemySystem.update(0.05, () => false);
    assert.equal(bread.sprite.y, g.groundY - BALANCE.enemy.groundOffset,
        'Bread remains grounded while supported');
    for (let i = 0; i < 15; i++) g.enemySystem.update(0.05, () => false);
    assert.ok(bread.sprite.x >= 520, 'Bread walks off the ledge');
    assert.ok(bread.sprite.y > g.groundY - BALANCE.enemy.groundOffset,
        'Bread actually falls into a gap');
    for (let i = 0; i < 60; i++) g.enemySystem.update(0.05, () => false);
    assert.equal(bread.sprite.active, false, 'Bread disappears below the map');
    assert.equal(g.enemySystem.records.get(bread.placementId).defeated, true,
        'Pit-fallen Bread stays gone even after streaming');
    assert.equal(g.run.kills, 0, 'Pit falls do not award player kills');
    g.events.emit('shutdown');
}
// Once returning home, a Bread must ignore players even if they enter
// the expanded detection range, until the original home point is reached.
{
    const { game: g } = fixture();
    g.enemySystem.player = g.player;
    const bread = g.enemySystem.spawnBread(500);
    bread.sprite.x = 560;
    bread.brain.state = 'return';
    g.player.x = 620;
    g.enemySystem.update(0.05, () => false);
    assert.equal(bread.brain.state, 'return');
    assert.ok(bread.sprite.x < 560);
    for (let i = 0; i < 18; i++) g.enemySystem.update(0.05, () => false);
    assert.equal(bread.brain.state, 'return', 'Bread ignores nearby player until home');
    g.enemySystem.update(0.05, () => false);
    assert.equal(bread.brain.state, 'idle', 'Bread completes return-home first');
    g.enemySystem.update(0.05, () => false);
    assert.equal(bread.brain.state, 'chase', 'Bread can re-aggro after arriving home');
    g.events.emit('shutdown');
}
console.log('PASS Bread terrain/aggro: supported walking, pit gravity, persistent fall and mandatory return home.');




// Resolve shielding at impact, independently of the stance artwork or windup start.
for (const [character, facing, sourceSide, raisedAtStart, raisedAtImpact, blocked] of [
    ['llamaCrunch', 1, 1, true, true, true], ['llamaCrunch', 1, -1, true, true, false],
    ['llamaCrunch', -1, -1, true, true, true], ['llamaCrunch', 1, 1, true, false, false],
    ['llamaCrunch', 1, 1, false, true, true], ['candy', 1, 1, true, true, false]
]) {
    const { game: g } = fixture(character);
    g.player = new Player(g, g.run, g.groundY);
    g.combatSystem = new CombatSystem(g, g.run, g.player, g.enemySystem, () => {}, () => g.endGame(), () => {});
    g.player.update({ left: facing === -1, right: facing === 1, jump: false }, 0);
    g.player.setShielding(raisedAtStart);
    const enemy = g.enemySystem.spawnBread(g.player.x + sourceSide * 40); enemy.brain.facing = -sourceSide;
    g.player.setShielding(raisedAtImpact);
    enemy.brain.state = 'active'; enemy.brain.remaining = 0.1;
    const hp = g.run.health; assert.equal(g.combatSystem.resolveEnemyAttack(enemy), true);
    assert.equal(g.run.health, hp - (blocked ? 0 : 1));
    if (blocked) assert.equal(g.combatSystem.slashes.size, 1);
    g.events.emit('shutdown');
}
for (const character of ['llamaCrunch', 'candy']) {
    const { game: g } = fixture(character); g.player = new Player(g, g.run, g.groundY);
    g.combatSystem = new CombatSystem(g, g.run, g.player, g.enemySystem, () => {}, () => {}, () => {});
    const start = g.player.x; g.player.setShielding(true);
    g.player.update({ left: false, right: true, jump: true }, 0.1);
    const multiplier = character === 'llamaCrunch' ? load('characters/shield').SHIELD.movementMultiplier : 1;
    assert.ok(Math.abs(g.player.x - start - g.run.moveSpeed * multiplier * 0.1) < 1e-8);
    assert.equal(g.run.onGround, character === 'llamaCrunch');
    assert.equal(g.run.velocityY, character === 'llamaCrunch' ? 0 : -490);
    const last = g.run.weapon.lastAttack; g.combatSystem.attack();
    assert.equal(g.run.weapon.lastAttack === last, character === 'llamaCrunch');
    g.player.setShielding(false); const x = g.player.x;
    g.player.update({ left: false, right: true, jump: false }, 0.1);
    assert.ok(Math.abs(g.player.x - x - g.run.moveSpeed * 0.1) < 1e-8);
    g.combatSystem.attack(); assert.equal(g.run.weapon.lastAttack, 0);
    g.events.emit('shutdown');
}
{
    mobileLayout = true;
    const { game: g, objects } = fixture(); installKeyboard(g); g.scale.width = 1662;
    const input = new PlayerInput(g, () => g.run.phase === 'playing', true);
    const buttons = objects.filter(o => o.kind === 'circle' && o.args[0] === 70);
    input.joystick.base.emit('pointerdown', { id: 1, x: 180 });
    buttons[0].emit('pointerdown', { id: 2 }); buttons[1].emit('pointerdown', { id: 3 }); buttons[2].emit('pointerdown', { id: 4 });
    assert.equal(input.shieldHeld(), true); assert.equal(input.readActions().right, true);
    assert.equal(input.readActions().jump, true); assert.equal(input.readActions().attack, true);
    g.input.emit('pointerup', { id: 4 }); assert.equal(input.shieldHeld(), false); assert.equal(input.readActions().attack, true);
    input.keys.K.isDown = true; assert.equal(input.shieldHeld(), true);
    input.clearAll(); assert.equal(input.shieldHeld(), false);
    g.events.emit('shutdown'); assert.equal(g.scale.listenerCount('resize'), 0); mobileLayout = false;
    const source = load('characters/shield').CHARACTER_SHIELDS.llama;
    const png = fs.readFileSync(path.join(__dirname, '../public/assets', source.path));
    assert.equal(png.readUInt32BE(16), source.width); assert.equal(png.readUInt32BE(20), source.height);
    assert.equal(source.width / source.frameSize, 3); assert.equal(png[25], 6);
}
console.log('PASS shielding: front/back/left blocks at impact, late raise/release, unchanged Candy, movement/jump/attack restoration, four independent fingers, cleanup and native shield sheet.');

// Regional balance is fixed at original placement, never elapsed time or player level.
{
    const { BREAD } = load('enemies/bread');
    const { DIFFICULTY, difficultyRegion } = load('world/difficulty');
    assert.deepEqual([BREAD.patrolSpeed, BREAD.chaseSpeed, BREAD.detectionRange, BREAD.loseRange,
        BREAD.windup, BREAD.recovery], [35, 125, 390, 600, 0.35, 0.9]);
    const boundary = load('config/balance').BALANCE.player.startX + DIFFICULTY.metresPerRegion * WORLD.pixelsPerMetre;
    assert.equal(difficultyRegion(boundary - 1), 0); assert.equal(difficultyRegion(boundary), 1);
    const { game: g } = fixture();
    const early = g.enemySystem.spawnBread(500);
    assert.equal(early.hp, 6); assert.equal(early.damage, 1); assert.equal(early.difficultyTier, 0);
    g.run.runTime = 9999; g.run.level = 40; g.run.furthestX = boundary * 20;
    const waiting = g.enemySystem.spawnBread(700);
    assert.equal(waiting.hp, early.hp); assert.equal(waiting.speed, 125);
    const later = g.enemySystem.spawnBread(boundary + 100);
    assert.equal(later.hp, 7); assert.equal(later.difficultyTier, 1);
    assert.equal(g.enemySystem.spawnBread(boundary * 20).hp, 10);
    g.enemySystem.damage(later, 2);
    g.cameras.main.setScroll(50000, 0); g.enemySystem.prepare();
    const restored = g.enemySystem.spawnBread(boundary + 100, later.placementId);
    assert.equal(restored.hp, 5); assert.equal(restored.maxHealth, 7);
    assert.equal(restored.damage, 1); assert.equal(restored.difficultyTier, 1);
    g.events.emit('shutdown');
}
{
    const { game: g } = fixture();
    const enemy = g.enemySystem.spawnBread(g.player.x + 50); enemy.sprite.y = g.player.y;
    for (const [time, hp] of [[0, 4], [0.5, 2], [1, 0]]) {
        g.run.runTime = time; g.combatSystem.attack(); assert.equal(enemy.hp, hp);
    }
    assert.equal(g.run.kills, 1); assert.equal(g.xpSystem.gems.length, 1);
    applyUpgrade(g.run, 'power'); applyUpgrade(g.run, 'power');
    assert.equal(Math.ceil(6 / g.run.weapon.damage), 2);
    applyUpgrade(g.run, 'power'); applyUpgrade(g.run, 'power');
    const upgradedTarget = g.enemySystem.spawnBread(g.player.x + 55); upgradedTarget.sprite.y = g.player.y;
    g.run.runTime = 1.5; g.combatSystem.attack();
    assert.equal(upgradedTarget.hp, 0); assert.equal(g.run.kills, 2);
    g.events.emit('shutdown');
}
// The non-looping stance ends on frame 1; held input never restarts it.
{
    const { game: g } = fixture();
    const animations = installCharacterSprites(g); registerCharacterAnimations(g);
    const { CHARACTER_SHIELDS, registerShieldAnimations } = load('characters/shield');
    const sheet = CHARACTER_SHIELDS.llama, textures = g.textures;
    g.textures = {
        exists: key => key === sheet.key || textures.exists(key),
        get: key => key === sheet.key ? {
            getSourceImage: () => ({ width: sheet.width, height: sheet.height }),
            has: name => Number(name) >= 0 && Number(name) < 3,
            get: () => ({ width: sheet.frameSize, height: sheet.frameSize })
        } : textures.get(key)
    };
    registerShieldAnimations(g);
    const clip = animations.get(sheet.key);
    assert.deepEqual(clip.frames.map(frame => frame.frame), [0, 1]); assert.equal(clip.repeat, 0);
    g.player = new Player(g, g.run, g.groundY);
    g.player.setShielding(true); assert.equal(g.run.shielding, true);
    const shield = g.player.visual.shield;
    shield.anims.isPlaying = false; // Phaser completes once, retaining its last frame.
    g.player.setShielding(true); g.player.update({ left: true, right: false, jump: false }, 0.01);
    assert.equal(shield.plays.length, 1); assert.equal(shield.flipX, true); assert.equal(shield.visible, true);
    g.player.setShielding(false); g.player.update({ left: false, right: false, jump: false }, 0);
    assert.equal(shield.visible, false); assert.equal(g.player.visual.animated.animationKey, 'llama-crunch:idle');
    g.events.emit('shutdown');
}
console.log('PASS balance polish: fixed regional stats/persistence, capped health growth, three starting sword hits, and non-looping shield frame-1 hold/release/facing.');

// Living bodies stop horizontal passage without contact damage or sprite-dependent bounds.
for (const character of ['llamaCrunch', 'candy']) {
    const { game: g } = fixture(character);
    g.player = new Player(g, g.run, g.groundY);
    const width = load('config/balance').BALANCE.player.contactWidth;
    const enemy = g.enemySystem.spawnBread(400);
    const resolve = (from, to, y) => g.enemySystem.resolvePlayerMovement(from, to, y);
    const right = { left: false, right: true, jump: false };
    const left = { left: true, right: false, jump: false };
    g.player.sprite.x = 300;
    g.player.update(right, 1, resolve); assert.equal(g.player.x, 400 - width);
    const health = g.run.health;
    g.player.update(right, 0.05, resolve); assert.equal(g.player.x, 400 - width);
    g.player.update(left, 0.05, resolve); assert.ok(g.player.x < 400 - width);
    g.player.sprite.x = 500;
    g.player.update(left, 1, resolve); assert.equal(g.player.x, 400 + width);
    assert.equal(g.run.health, health, 'Body contact does not add damage ticks');
    // Elevated movement can cross; an overlap can always be escaped.
    assert.equal(resolve(300, 500, enemy.sprite.y - 100), 500);
    assert.equal(resolve(390, 300, enemy.sprite.y), 300);
    assert.equal(resolve(410, 500, enemy.sprite.y), 500);
    g.enemySystem.player = g.player;
    g.player.sprite.x = 400 + width;
    g.enemySystem.move(enemy, 600, 125, 1); assert.equal(enemy.sprite.x, 400);
    g.enemySystem.damage(enemy, enemy.hp);
    assert.equal(resolve(300, 500, enemy.sprite.y), 500, 'Death removes the blocker immediately');
    g.events.emit('shutdown');
}
console.log('PASS Bread body collision: both characters, both directions, swept steps, retreat/overlap escape, jumping clearance, enemy movement and death removal without contact damage.');

// Shield immobilizes Crunch immediately, while airborne gravity and release remain natural.
{
    const { game: g } = fixture(); g.player = new Player(g, g.run, g.groundY);
    g.player.setShielding(true);
    const x = g.player.x, y = g.player.y;
    for (const left of [true, false]) {
        g.player.update({ left, right: !left, jump: true }, 0.1);
        assert.equal(g.player.x, x); assert.equal(g.player.y, y);
        assert.equal(g.run.onGround, true); assert.equal(g.run.velocityY, 0);
    }
    g.player.setShielding(false);
    g.player.update({ left: false, right: true, jump: true }, 0.1);
    assert.equal(g.player.x, x + g.run.moveSpeed * 0.1); assert.equal(g.run.onGround, false);
    g.player.setShielding(true);
    const airborneX = g.player.x, airborneY = g.player.y, velocity = g.run.velocityY;
    g.player.update({ left: false, right: true, jump: true }, 0.1);
    assert.equal(g.player.x, airborneX); assert.notEqual(g.player.y, airborneY);
    assert.equal(g.run.velocityY, velocity + load('config/balance').BALANCE.player.gravity * 0.1);
    g.events.emit('shutdown');
}
console.log('PASS stationary shield: no horizontal movement or jumping, immediate release, airborne gravity and unchanged Candy controls.');


// Elevated rewards are deterministic, collected once, and remain claimed after streaming.
{
    const { game: g } = fixture();
    const { PlatformRewardSystem } = load('systems/PlatformRewardSystem');
    const rewards = new PlatformRewardSystem(g, g.run, g.player, g.groundY, xp => g.xpSystem.award(xp));
    const platforms = generateSection(0, g.run.seed).platforms;
    assert.equal(platforms.length, 4);
    assert.ok(platforms[1].x - platforms[0].x > 0 && platforms[1].x - platforms[0].x <= 400, 'Varied paired ledges remain reachable');
    g.cameras.main.setScroll(700, 0);
    rewards.prepare();
    const prize = [...rewards.active.values()].find(entry => entry.sprite.x === platforms[2].x);
    assert.ok(prize, 'An upper route has an XP reward');
    g.player.x = prize.sprite.x; g.player.y = prize.sprite.y;
    rewards.update();
    assert.equal(g.run.xp, 1);
    g.cameras.main.setScroll(10000, 0); rewards.prepare();
    g.cameras.main.setScroll(700, 0); rewards.prepare();
    assert.ok(![...rewards.active.values()].some(entry => entry.sprite.x === platforms[2].x));
    assert.equal(g.run.xp, 1);
    const chest = generateSection(1, g.run.seed).structures.find(item => item.kind === 'chest' && item.elevation);
    assert.ok(chest && chest.elevation === generateSection(1, g.run.seed).platforms[1].height);
    rewards.destroy(); g.events.emit('shutdown');
    console.log('PASS elevated rewards: repeatable ledges, collectible XP and persistent once-per-run prizes.');
}

// Bread Archers aim before firing, shoot in the correct direction and remain
// defeated even when the camera streams the section out and back.
{
    const { game: g } = fixture();
    const { ArcherSystem } = load('systems/ArcherSystem');
    const hits = [], kills = [];
    const archers = new ArcherSystem(g, g.run, g.groundY, g.player,
        direction => hits.push(direction), (x, y) => kills.push([x, y]));
    const perch = generateSection(1, g.run.seed).platforms[3];
    g.cameras.main.setScroll(perch.x - 700, 0);
    g.player.x = perch.x - 165;
    g.player.y = g.groundY - perch.height - 32;
    archers.prepare();
    assert.equal(archers.archers.length, 1);
    const archer = archers.archers[0];
    archers.update(0.02);
    assert.equal(archer.state, 'aim');
    assert.equal(archer.warning.visible, true);
    archers.update(0.75);
    assert.equal(archer.state, 'reload');
    assert.equal(archer.warning.visible, false);
    for (let step = 0; step < 8; step++) archers.update(0.1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0], 1, 'Shot approaches player from their right');
    assert.equal(archers.damage(archer, 2), false);
    assert.equal(archer.sprite.alpha, 0.5, 'Nonlethal hit fades Pyromancer like Bread');
    assert.equal(archers.damage(archer, 2), true);
    assert.equal(archer.sprite.alpha, 1, 'Lethal hit restores opacity for death animation');
    assert.equal(kills.length, 1);
    g.cameras.main.setScroll(14000, 0); archers.prepare();
    g.cameras.main.setScroll(perch.x - 700, 0); archers.prepare();
    assert.equal(archers.archers.length, 0, 'Dead archer does not respawn on return');
    archers.destroy(); g.events.emit('shutdown');
    console.log('PASS Bread Archers: spawn, aiming tell, projectile, combat damage and persistent death.');
    const { ARCHER } = load('config/archers');
    // A fresh archer patrols its own platform, never walks off an edge,
    // persists position when streamed out, and physically blocks an approaching player.
    const second = new ArcherSystem(g, g.run, g.groundY, g.player, direction => hits.push(direction), () => {});
    g.cameras.main.setScroll(perch.x - 700, 0);
    g.player.x = perch.x - 1100; g.player.y = g.groundY - perch.height - ARCHER.footOffset;
    second.prepare();
    const patrol = second.archers[0];
    assert.ok(patrol, 'A living archer spawns on the platform');
    const start = patrol.sprite.x;
    second.update(0.3);
    assert.ok(patrol.sprite.x > start, 'A non-engaged archer patrols');
    for (let step = 0; step < 150; step++) second.update(0.2);
    assert.ok(patrol.sprite.x >= patrol.minX && patrol.sprite.x <= patrol.maxX,
        'Patrol stays on the ledge');
    const savedX = patrol.sprite.x;
    g.cameras.main.setScroll(14000, 0); second.prepare();
    g.cameras.main.setScroll(perch.x - 700, 0); second.prepare();
    assert.equal(second.archers[0].sprite.x, savedX, 'Patrol position persists when streaming');
    const body = second.archers[0];
    const blocked = second.resolvePlayerMovement(body.sprite.x - 120, body.sprite.x + 30, body.sprite.y);
    assert.equal(blocked, body.sprite.x - ARCHER.contactWidth);
    assert.equal(second.resolvePlayerMovement(body.sprite.x - 120, body.sprite.x + 30,
        body.sprite.y + 160), body.sprite.x + 30, 'No body blocking across different heights');
    // The 68px separation should prevent the rendered Pyromancer and
    // character from visibly overlapping, even if a frame starts inside it.
    assert.equal(ARCHER.contactWidth, 68);
    assert.equal(ARCHER.contactRange, 85, 'Bonk can reach beyond the solid collision boundary');
    assert.equal(second.resolvePlayerMovement(body.sprite.x - 60, body.sprite.x - 45,
        body.sprite.y), body.sprite.x - 60,
        'Player already inside left contact radius cannot walk further in');
    assert.equal(second.resolvePlayerMovement(body.sprite.x + 60, body.sprite.x + 45,
        body.sprite.y), body.sprite.x + 60,
        'Player already inside right contact radius cannot walk further in');
    assert.equal(second.resolvePlayerMovement(body.sprite.x - 60, body.sprite.x - 90,
        body.sprite.y), body.sprite.x - 90, 'Retreat left remains possible');
    assert.equal(second.resolvePlayerMovement(body.sprite.x + 60, body.sprite.x + 90,
        body.sprite.y), body.sprite.x + 90, 'Retreat right remains possible');
    g.player.x = body.sprite.x - 38; g.player.y = body.sprite.y;
    body.state = 'watch';
    second.update(0.02);
    assert.equal(body.state, 'aim', 'Close enemy telegraphs a strike');
    second.update(ARCHER.contactWindup + 0.02);
    assert.ok(hits.length >= 2, 'A close-range strike can damage the player');
    second.destroy();

}


// Pancake archer idle: asset is six transparent 256px frames, grounded at
// the shared y=224 sprite anchor; loader and animation metadata agree.
{
    const { PYROMANCER_IDLE, loadPyromancerIdle } = load('enemies/pyromancer');
    const png = fs.readFileSync(path.join(__dirname, '../public/assets', PYROMANCER_IDLE.path));
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.readUInt32BE(16), 1536);
    assert.equal(png.readUInt32BE(20), 256);
    assert.equal(png[25], 6, 'Original RGBA PNG has transparency');
    assert.equal(PYROMANCER_IDLE.start, 0);
    assert.equal(PYROMANCER_IDLE.end, 5);
    assert.equal(PYROMANCER_IDLE.originY, 224 / 256);
    const requests = [];
    loadPyromancerIdle({ load: { spritesheet: (...params) => requests.push(params) } });
    assert.equal(requests.length, 6, 'All six Pyromancer sheets load');
    assert.equal(requests[0][0], PYROMANCER_IDLE.key);
    assert.equal(requests[0][1], PYROMANCER_IDLE.path);
    assert.equal(requests[0][2].endFrame, 5);
    const { PYROMANCER_RUN, hasPyromancerRun } = load('enemies/pyromancer');
    const runPng = fs.readFileSync(path.join(__dirname, '../public/assets', PYROMANCER_RUN.path));
    assert.equal(runPng.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(runPng.readUInt32BE(16), 1536, 'Run sheet contains six 256px frames');
    assert.equal(runPng.readUInt32BE(20), 256);
    assert.equal(runPng[25], 6, 'Run sheet is RGBA');
    assert.equal(PYROMANCER_RUN.scale, PYROMANCER_IDLE.scale);
    assert.equal(PYROMANCER_RUN.originY, PYROMANCER_IDLE.originY);
    assert.equal(typeof hasPyromancerRun, 'function');
    assert.equal(requests.length, 6, 'All six Pyromancer sheets are loaded');
    assert.equal(requests[1][0], PYROMANCER_RUN.key);
    assert.equal(requests[1][2].endFrame, 5);
    console.log('PASS pancake animations: idle/run sheets, transparent RGBA frames, matching anchors.');
}

// Pyromancer animation source contracts: six original RGBA strips,
// two non-looping attacks, a non-looping death and one-shot projectile.
// The projectile animates frames 0-3, holds frame 3 while flying,
// and shows frame 5 only after a confirmed collision.
{
    const pyro = load('enemies/pyromancer');
    const states = ['ATTACK', 'BONK', 'DEATH', 'FIREBALL'];
    for (const state of states) {
        const spec = pyro['PYROMANCER_' + state];
        assert.ok(spec, state + ' animation registered');
        const bytes = fs.readFileSync(path.join(__dirname, '../public/assets', spec.path));
        assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', state + ' is PNG');
        assert.equal(bytes.readUInt32BE(16), 1536, state + ' is six frames wide');
        assert.equal(bytes.readUInt32BE(20), 256, state + ' frame height');
        assert.equal(bytes[25], 6, state + ' supports transparency');
        assert.equal(spec.start, 0);
        assert.equal(spec.end, state === 'FIREBALL' ? 3 : 5);
        assert.equal(spec.repeat, 0, state + ' plays once, never loops');
        assert.equal(spec.originY, 224 / 256);
    }
    assert.ok(pyro.PYROMANCER_ATTACK.scale > pyro.PYROMANCER_IDLE.scale,
        'Attack art compensates for smaller figure drawn inside the frame');
    assert.equal(pyro.PYROMANCER_FIREBALL.impactFrame, 5, 'Final frame is impact-only');
    assert.ok(pyro.PYROMANCER_BONK.scale > pyro.PYROMANCER_IDLE.scale,
        'Bonk animation compensates for smaller illustrated pancake');
    assert.equal(pyro.PYROMANCER_DEATH.scale, pyro.PYROMANCER_IDLE.scale);
    console.log('PASS Pyromancer combat: original attack/bonk/death/fireball sheets and animation contracts.');
}


// Render-capable mock verifies actual attack selection, bonk/shot exclusivity,
// projectile survival after a one-shot animation, and death follow-through.
{
    const { game: g } = fixture();
    const pyro = load('enemies/pyromancer');
    const { ArcherSystem } = load('systems/ArcherSystem');
    const { ARCHER } = load('config/archers');
    const sheets = [pyro.PYROMANCER_IDLE, pyro.PYROMANCER_RUN, pyro.PYROMANCER_ATTACK,
        pyro.PYROMANCER_BONK, pyro.PYROMANCER_DEATH, pyro.PYROMANCER_FIREBALL];
    const dimensions = new Map(sheets.map(sheet => [sheet.key, sheet]));
    g.textures = {
        exists(key) { return dimensions.has(key); },
        get(key) {
            const source = dimensions.get(key);
            return {
                getSourceImage() { return { width: source.width, height: source.height }; },
                has(frame) { return +frame >= 0 && +frame <= 5; },
                get() { return { width: 256, height: 256 }; }
            };
        }
    };
    g.anims = { exists: key => sheets.some(sheet => sheet.animationKey === key) };
    g.add.sprite = (x, y, key) => {
        const spr = g.add.container(x, y);
        spr.textureKey = key;
        spr.anims = { isPlaying: false, pause() { this.paused = true; },
            resume() { this.paused = false; }, stop() { this.isPlaying = false; } };
        spr.setFrame = function(frame) { this.frameIndex = frame; return this; };
        spr.play = function(key) { this.played = key; this.anims.isPlaying = true; return this; };
        spr.setFlipX = function(value) { this.flipX = value; return this; };
        return spr;
    };
    const hits = [], kills = [];
    const archers = new ArcherSystem(g, g.run, g.groundY, g.player,
        from => hits.push(from), (x, y) => kills.push([x, y]));
    const perch = generateSection(1, g.run.seed).platforms[3];
    g.cameras.main.setScroll(perch.x - 700, 0);
    g.player.x = perch.x - 165; g.player.y = g.groundY - perch.height - ARCHER.footOffset;
    archers.prepare();
    const actor = archers.archers[0];
    assert.equal(actor.art.played, pyro.PYROMANCER_IDLE.animationKey);
    archers.update(0.02);
    assert.equal(actor.art.played, pyro.PYROMANCER_ATTACK.animationKey, 'Ranged tell plays casting');
    assert.equal(actor.art.scaleX, pyro.PYROMANCER_ATTACK.scale, 'Cast pose does not shrink');
    // Advance in realistic simulation steps; a 700ms single step could move
    // the newly spawned projectile through the player in that same update.
    archers.update(ARCHER.aimDuration - 0.03);
    archers.update(0.04);
    assert.equal(archers.arrows.length, 1, 'Casting releases exactly one projectile');
    const shot = archers.arrows[0].sprite;
    assert.equal(shot.played, pyro.PYROMANCER_FIREBALL.animationKey);
    shot.anims.isPlaying = false; // Projectile animation finished; final frame stays.
    actor.art.anims.isPlaying = false; // Simulate non-looping cast completing in Phaser.
    archers.update(0.01);
    assert.equal(shot.active, true, 'Fireball persists after its last animation frame');
    assert.equal(archers.arrows[0].sprite, shot);
    assert.equal(actor.art.played, pyro.PYROMANCER_IDLE.animationKey, 'Returns to idle');
    assert.equal(actor.art.scaleX, pyro.PYROMANCER_IDLE.scale, 'Idle restores original scale');
    // Flight animation has finished and is holding frame 3, not the impact frame.
    shot.setFrame(pyro.PYROMANCER_FIREBALL.end);
    assert.notEqual(shot.frameIndex, pyro.PYROMANCER_FIREBALL.impactFrame);
    g.player.x = shot.x; g.player.y = shot.y;
    const previousHits = hits.length;
    archers.update(0.01);
    assert.equal(hits.length, previousHits + 1, 'Collision damages exactly once');
    assert.equal(shot.frameIndex, pyro.PYROMANCER_FIREBALL.impactFrame,
        'Final fireball frame appears only at impact');
    assert.equal(shot.active, true, 'Impact frame lingers briefly');
    archers.update(0.14);
    assert.equal(shot.active, false, 'Impact sprite is cleaned up');
    assert.equal(hits.length, previousHits + 1, 'Impact does not damage twice');

    // A separate Pyromancer starts a melee animation but does not cast a fireball.
    g.cameras.main.setScroll(14000, 0); archers.prepare();
    g.cameras.main.setScroll(perch.x - 700, 0); archers.prepare();
    const bonker = archers.archers[0];
    g.player.x = bonker.sprite.x - 78; g.player.y = bonker.sprite.y;
    bonker.state = 'watch';
    archers.update(0.01);
    assert.equal(bonker.art.played, pyro.PYROMANCER_BONK.animationKey, 'Close attack plays bonk');
    assert.equal(bonker.art.scaleX, pyro.PYROMANCER_BONK.scale,
        'Bonk pose matches the corrected character size');
    const shotsBefore = archers.arrows.length;
    archers.update(ARCHER.contactWindup + 0.01);
    assert.equal(archers.arrows.length, shotsBefore, 'Bonk never launches a projectile');
    assert.ok(hits.length > 0, 'Bonk can damage the player');

    assert.equal(archers.damage(bonker, ARCHER.hp), true);
    assert.equal(kills.length, 1, 'Defeat reward triggers once');
    assert.equal(bonker.art.played, pyro.PYROMANCER_DEATH.animationKey, 'Death anim plays');
    assert.equal(bonker.sprite.active, true, 'Death art remains visible briefly');
    archers.update(ARCHER.deathDuration + 0.01);
    assert.equal(bonker.sprite.active, false, 'Death art is cleaned up');
    archers.destroy(); g.events.emit('shutdown');
    console.log('PASS Pyromancer game combat: casting, persistent fireball, bonk without shot and death animation.');
}


// Doubling range must affect actual casting, not just projectile lifetime.
// Platform-bound Pyromancers must not stall at the ledge waiting to get closer.
{
    const { game: g } = fixture();
    const { ArcherSystem } = load('systems/ArcherSystem');
    const { ARCHER } = load('config/archers');
    assert.equal(ARCHER.detectionRange, 900);
    assert.equal(ARCHER.projectileRange, 1400);
    assert.equal(ARCHER.preferredRange, 300);
    const sys = new ArcherSystem(g, g.run, g.groundY, g.player, () => {}, () => {});
    const perch = generateSection(1, g.run.seed).platforms[3];
    g.cameras.main.setScroll(perch.x - 700, 0);
    g.player.y = g.groundY - perch.height - ARCHER.footOffset;
    g.player.x = perch.x - 800;
    sys.prepare();
    const pyro = sys.archers[0];
    assert.ok(pyro);
    sys.update(0.02);
    assert.equal(pyro.state, 'aim', 'Pyromancer aims at a target 800px away without chasing');
    assert.equal(pyro.sprite.x, perch.x, 'Aiming at range does not move off the ledge');
    sys.update(ARCHER.aimDuration + 0.01);
    assert.equal(pyro.state, 'reload', 'Distant Pyromancer actually releases a shot');
    assert.ok(sys.arrows.length > 0, 'Shot exists while travelling across long range');
    sys.destroy();
    g.events.emit('shutdown');
    console.log('PASS Pyromancer doubled range: 900px detection and 1400px projectile, distant casting.');
}

// Pyromancer damage flash restores opacity, refreshes on repeated hits,
// and cancels its timer when a sprite is destroyed.
{
    const { game: g, advance } = fixture();
    const { ArcherSystem } = load('systems/ArcherSystem');
    const { BALANCE } = load('config/balance');
    const sys = new ArcherSystem(g, g.run, g.groundY, g.player, () => {}, () => {});
    const perch = generateSection(1, g.run.seed).platforms[3];
    g.cameras.main.setScroll(perch.x - 700, 0);
    sys.prepare();
    const pyro = sys.archers[0];
    assert.ok(pyro);
    assert.equal(sys.damage(pyro, 1), false);
    assert.equal(pyro.sprite.alpha, 0.5);
    advance(BALANCE.effects.enemyHitDuration - 10);
    assert.equal(pyro.sprite.alpha, 0.5);
    assert.equal(sys.damage(pyro, 1), false, 'Second hit restarts flash');
    advance(10);
    assert.equal(pyro.sprite.alpha, 0.5, 'Old timer cannot end a new flash');
    advance(BALANCE.effects.enemyHitDuration - 10);
    assert.equal(pyro.sprite.alpha, 1, 'Flash restores full opacity');
    sys.destroy(); g.events.emit('shutdown');
    console.log('PASS Pyromancer non-lethal damage fade, refresh and cleanup.');
}


// Living enemy heads are one-way landing platforms. Bread does not deal
// passive contact damage, but can reach a rider with an active melee attack.
// Pyromancer fire contact uses the existing invulnerability cooldown.
{
    const { game: g } = fixture();
    const { Player } = load('entities/Player');
    const { EnemySystem } = load('systems/EnemySystem');
    const { ArcherSystem } = load('systems/ArcherSystem');
    const { BREAD } = load('enemies/bread');
    const { ARCHER } = load('config/archers');
    const { BALANCE } = load('config/balance');
    const breadSystem = new EnemySystem(g, g.run, g.groundY);
    const bread = breadSystem.spawnBread(600);
    const breadTop = bread.sprite.y - BREAD.standHeight;
    assert.equal(breadSystem.landingY(bread.sprite.x, breadTop - 5, breadTop + 10), breadTop);
    assert.equal(breadSystem.landingY(bread.sprite.x + 100, breadTop - 5, breadTop + 10),
        undefined, 'Bread landing needs horizontal overlap');
    assert.equal(breadSystem.landingY(bread.sprite.x, breadTop + 10, breadTop - 5),
        undefined, 'No solid underside when jumping up');
    const player = new Player(g, g.run, g.groundY);
    player.sprite.x = bread.sprite.x;
    player.sprite.y = breadTop - BALANCE.player.groundOffset - 5;
    g.run.onGround = false; g.run.velocityY = 120;
    const surfaces = { landingY: (x, from, to) => breadSystem.landingY(x, from, to),
        standingY: (x, foot) => breadSystem.standingY(x, foot) };
    player.update({ left: false, right: false, jump: false }, 0.05,
        (from, to) => to, surfaces);
    assert.equal(player.y + BALANCE.player.groundOffset, breadTop);
    assert.equal(g.run.onGround, true, 'The player lands on a Bread head');
    const hp = g.run.health;
    breadSystem.update(0.02, () => {});
    assert.equal(g.run.health, hp, 'Standing on Bread is not passive damage');
    g.combatSystem.player = player;
    bread.brain.state = 'active'; bread.brain.remaining = 0.1;
    assert.equal(g.combatSystem.resolveEnemyAttack(bread), true,
        'Bread melee can attack the player standing above it');
    assert.equal(g.run.health, hp - bread.damage);
    breadSystem.damage(bread, 999);
    assert.equal(breadSystem.standingY(bread.sprite.x, breadTop), undefined,
        'Dead Bread cannot support the player');
    breadSystem.destroy();

    const fire = new ArcherSystem(g, g.run, g.groundY, g.player, () => {}, () => {});
    const perch = generateSection(1, g.run.seed).platforms[3];
    g.cameras.main.setScroll(perch.x - 700, 0);
    fire.prepare();
    const pyro = fire.archers[0];
    assert.ok(pyro);
    assert.equal(ARCHER.standHeight, 30, 'Landing height is on the pancake stack beneath the flame crown');
    const pyroTop = pyro.sprite.y - ARCHER.standHeight;
    assert.equal(fire.landingY(pyro.sprite.x, pyroTop - 4, pyroTop + 4), pyroTop);
    assert.equal(fire.landingY(pyro.sprite.x, pyroTop + 5, pyroTop - 4), undefined);
    g.player.x = pyro.sprite.x;
    g.player.y = pyroTop - BALANCE.player.groundOffset;
    assert.equal(fire.playerStandingOnPyromancer(), true);
    g.combatSystem.archers = fire;
    g.run.lastDamage = -1000;
    g.run.runTime = 0;
    const beforeBurn = g.run.health;
    g.combatSystem.resolvePyromancerFireContact();
    assert.equal(g.run.health, beforeBurn - 1, 'Pyromancer burns a rider');
    assert.equal(g.combatSystem.fireTicks.size, 1, 'A successful fire hit shows a damage tick');
    const firstTick = [...g.combatSystem.fireTicks][0];
    assert.equal(firstTick.text, '-1');
    assert.equal(firstTick.args[1].color, '#ff3030', 'Fire damage number is red');
    g.run.runTime = 0.5;
    g.combatSystem.resolvePyromancerFireContact();
    assert.equal(g.run.health, beforeBurn - 1, 'Cooldown prevents per-frame burning');
    assert.equal(g.combatSystem.fireTicks.size, 1, 'No duplicate tick during invulnerability');
    g.run.runTime = 1;
    g.combatSystem.resolvePyromancerFireContact();
    assert.equal(g.run.health, beforeBurn - 2, 'Fire burns again after cooldown');
    assert.equal(g.combatSystem.fireTicks.size, 2, 'Next real fire hit shows another red tick');
    g.player.x += 100;
    assert.equal(fire.playerStandingOnPyromancer(), false);
    g.run.runTime = 2;
    g.combatSystem.resolvePyromancerFireContact();
    assert.equal(g.run.health, beforeBurn - 2, 'No burning after leaving the enemy');
    fire.damage(pyro, 999);
    assert.equal(fire.standingY(pyro.sprite.x, pyroTop), undefined);
    fire.destroy(); g.events.emit('shutdown');
    console.log('PASS enemy standing: Bread head landing, harmless contact, active upward attack, Pyromancer fire with cooldown.');
}


// A player standing on an elevated ledge cannot accidentally land on a Bread
// Roll underneath it, and attacks from underneath may not pass through ledges.
{
    const { game: g } = fixture();
    const { EnemySystem } = load('systems/EnemySystem');
    const { BREAD } = load('enemies/bread');
    const { BALANCE } = load('config/balance');
    const breadSystem = new EnemySystem(g, g.run, g.groundY);
    const bread = breadSystem.spawnBread(700);
    const head = bread.sprite.y - BREAD.standHeight;
    breadSystem.setTerrain({ enemyHeadExposed: () => false });
    assert.equal(breadSystem.landingY(bread.sprite.x, head - 12, head + 15), undefined,
        'Hidden Bread cannot be landed on through a ledge');
    assert.equal(breadSystem.standingY(bread.sprite.x, head), undefined,
        'Hidden Bread cannot support the player on a ledge');
    assert.equal(breadSystem.isPlayerStandingOn(bread, bread.sprite.x,
        head - BALANCE.player.groundOffset), false, 'Hidden Bread cannot attack via head contact');
    const player = g.player;
    player.x = bread.sprite.x;
    player.y = bread.sprite.y - 105;
    g.combatSystem.player = player;
    g.combatSystem.setTerrain({ terrainImpact: () => ({ x: bread.sprite.x, y: bread.sprite.y - 60, t: 0.5 }) });
    bread.brain.state = 'active'; bread.brain.remaining = 0.1;
    const hp = g.run.health;
    assert.equal(g.combatSystem.resolveEnemyAttack(bread), false,
        'Bread strike is intercepted by the platform');
    assert.equal(g.run.health, hp);
    breadSystem.destroy(); g.events.emit('shutdown');
    console.log('PASS terrain obscures covered Bread heads and blocks attacks through ledges.');
}


// Every real combat hit displays a floating damage number; shields and
// invulnerability do not show a number when no health was lost.
{
    const { game: g } = fixture();
    const combat = g.combatSystem;
    const startingHp = g.run.health;
    g.run.lastDamage = -1000;
    g.run.runTime = 0;
    combat.resolveArcherArrow(-1);
    assert.equal(g.run.health, startingHp - 1);
    assert.equal(combat.damageTicks.size, 1, 'Incoming projectile hit shows -1');
    let tick = [...combat.damageTicks][0];
    assert.equal(tick.text, '-1');
    assert.equal(tick.args[1].color, '#ff3030', 'Incoming damage is red');
    g.run.runTime = 0.2;
    combat.resolveArcherArrow(-1);
    assert.equal(combat.damageTicks.size, 1, 'No tick during damage cooldown');

    g.run.runTime = 1.1;
    const bread = g.enemySystem.spawnBread(600);
    assert.ok(bread);
    const enemyHp = bread.hp;
    combat.hitTarget(bread, 2);
    assert.equal(bread.hp, enemyHp - 2);
    tick = [...combat.damageTicks].at(-1);
    assert.equal(tick.text, '-2', 'Outgoing damage reflects attack strength');
    assert.equal(tick.args[1].color, '#ffe28a', 'Enemy damage uses warm gold');
    combat.hitTarget(bread, 999);
    tick = [...combat.damageTicks].at(-1);
    assert.equal(tick.text, `-${enemyHp - 2}`, 'Finishing blow shows actual HP removed');

    const before = combat.damageTicks.size;
    g.run.phase = 'paused';
    combat.resolveArcherArrow(-1);
    assert.equal(combat.damageTicks.size, before, 'Paused combat produces no ticks');
    g.events.emit('shutdown');
    assert.equal(combat.damageTicks.size, 0, 'Damage number effects cleaned up');
    console.log('PASS universal floating damage numbers: incoming, cooldown, enemy and lethal hits.');
}


// Phase 1 environmental hazards: snap traps require three new attack presses,
// while spikes reuse the shared damage cooldown and also affect Bread enemies.
{
    const { game: g } = fixture('candy');
    const { HazardSystem } = load('systems/HazardSystem');
    const { BALANCE } = load('config/balance');
    const fakeArchers = { archers: [], damage() {} };
    const hazards = new HazardSystem(g, g.run, g.groundY, g.player,
        g.enemySystem, fakeArchers, damage => g.combatSystem.applyEnvironmentalDamage(damage));
    const trap = hazards.make({ id: 'test:trap', x: g.player.x, kind: 'snap-trap' });
    hazards.active.set(trap.placement.id, trap);
    g.run.runTime = 1;
    g.run.lastDamage = -1000;
    const before = g.run.health;
    hazards.update();
    assert.equal(g.run.health, before - 1, 'Snap trap deals one initial damage');
    assert.equal(hazards.isPlayerTrapped, true);
    assert.equal(hazards.handlePlayerAttack(true), true);
    assert.equal(trap.trapHits, 1);
    assert.equal(hazards.handlePlayerAttack(true), true);
    assert.equal(trap.trapHits, 1, 'Holding attack does not count as repeated strikes');
    hazards.handlePlayerAttack(false); hazards.handlePlayerAttack(true);
    assert.equal(trap.trapHits, 2);
    assert.equal(hazards.isPlayerTrapped, true, 'Two hits are insufficient');
    hazards.handlePlayerAttack(false); hazards.handlePlayerAttack(true);
    assert.equal(hazards.isPlayerTrapped, false, 'Third discrete strike frees Candy');
    assert.equal(hazards.broken.has('test:trap'), true);
    assert.equal(trap.pieces.every(piece => !piece.active), true, 'Broken trap visuals removed');

    g.run.runTime = 3;
    const spikes = hazards.make({ id: 'test:spikes', x: g.player.x, kind: 'fixed-spikes' });
    hazards.active.set(spikes.placement.id, spikes);
    const remaining = g.run.health;
    hazards.update();
    assert.equal(g.run.health, remaining - 1, 'Spikes hurt the player');
    assert.equal(g.combatSystem.damageTicks.size >= 2, true, 'Hazard damage shows red ticks');
    hazards.update();
    assert.equal(g.run.health, remaining - 1, 'Invulnerability prevents per-frame damage');
    g.run.runTime = 4;
    hazards.update();
    assert.equal(g.run.health, remaining - 2, 'Damage resumes after cooldown');
    const bread = g.enemySystem.spawnBread(g.player.x);
    assert.ok(bread);
    const breadHp = bread.hp;
    hazards.update();
    assert.equal(bread.hp, breadHp - 1, 'Spikes affect Bread enemies');
    hazards.update();
    assert.equal(bread.hp, breadHp - 1, 'Enemy hazard damage has its own cooldown');

    g.run.phase = 'paused';
    const pauseHp = g.run.health;
    g.run.runTime = 10;
    hazards.update();
    assert.equal(g.run.health, pauseHp, 'Paused hazards do not deal damage');
    g.events.emit('shutdown');
    assert.equal(hazards.active.size, 0, 'Hazards clean up at scene shutdown');
    console.log('PASS Phase 1 hazards: three presses, trapped movement state, player/enemy spikes, cooldowns and pause.');
}


// Candy projectiles ignore elevated platforms but are stopped by stone
// walls and by the continuous ground, including at the edge of a pit.
{
    const { game: g } = fixture('candy');
    const section = generateSection(1, g.run.seed);
    const p = section.platforms[0];
    const y = g.groundY - p.height + 12;
    assert.ok(g.world.terrainImpact(p.x - p.width / 2 - 20, y,
        p.x + p.width / 2 + 20, y), 'The platform is physically solid for general collisions');
    assert.equal(g.world.projectileImpact(p.x - p.width / 2 - 20, y,
        p.x + p.width / 2 + 20, y), undefined,
        'Candy spells travel through elevated platform slabs');
    const wall = generateSection(4, g.run.seed).walls[0];
    assert.ok(g.world.projectileImpact(wall.x - 100, g.groundY - 40,
        wall.x + 100, g.groundY - 40), 'Candy shots cannot pass through intact walls');
    assert.ok(g.world.projectileImpact(250, g.groundY + 12, 350, g.groundY + 12),
        'Candy shots cannot pass through ordinary solid ground');
    g.events.emit('shutdown');
}
console.log('PASS Candy collision: passes through floating ledges, blocked by walls and ground.');

// Phase 2: mutable world terrain must update real landing/projectile collision,
// preserve destruction through streaming, and regenerate crumbling ledges.
{
    const { game: g } = fixture();
    const { terrainPieces } = load('world/terrainFeatures');
    const section = generateSection(4, g.run.seed);
    const wall = section.walls[0];
    assert.ok(wall, 'An advanced section contains a breakable wall');
    const bodyY = g.groundY - 40;
    assert.equal(g.world.resolvePlayerMovement(wall.x - 150, wall.x + 150, bodyY),
        wall.x - wall.width / 2 - 23, 'Wall stops horizontal player motion');
    assert.ok(g.world.terrainImpact(wall.x - 120, bodyY, wall.x + 120, bodyY),
        'Wall intercepts a swept projectile');
    let damage = 0;
    while (damage < wall.hp) {
        damage += g.world.damageAtImpact(wall.x, bodyY, 1);
    }
    assert.equal(damage, wall.hp);
    assert.equal(g.world.resolvePlayerMovement(wall.x - 150, wall.x + 150, bodyY),
        wall.x + 150, 'Breaking wall opens the route');
    assert.equal(g.world.terrainImpact(wall.x - 120, bodyY, wall.x + 120, bodyY),
        undefined, 'Projectiles pass through destroyed walls');

    const pieces = terrainPieces(section.platforms, 4);
    const bridge = pieces.find(p => p.feature === 'bridge');
    assert.ok(bridge, 'Advanced terrain contains destructible bridge boards');
    const bridgeTop = g.groundY - bridge.height;
    assert.equal(g.world.landingY(bridge.x, bridgeTop - 4, bridgeTop + 4), bridgeTop);
    assert.equal(g.world.damageAtImpact(bridge.x, bridgeTop + 2, 1), 1);
    assert.equal(g.world.damageAtImpact(bridge.x, bridgeTop + 2, 1), 1);
    assert.notEqual(g.world.landingY(bridge.x, bridgeTop - 4, bridgeTop + 4),
        bridgeTop, 'Destroyed board no longer supports the player');

    const crumble = pieces.find(p => p.feature === 'crumble');
    assert.ok(crumble);
    const crumbleTop = g.groundY - crumble.height;
    assert.equal(g.world.landingY(crumble.x, crumbleTop - 5, crumbleTop + 5), crumbleTop);
    g.world.advance(0.05, crumble.x, crumbleTop);
    g.world.advance(0.81, crumble.x, crumbleTop);
    assert.notEqual(g.world.landingY(crumble.x, crumbleTop - 5, crumbleTop + 5),
        crumbleTop, 'Triggered ledge collapses');
    g.world.advance(4.1, crumble.x + 400, g.groundY);
    assert.equal(g.world.landingY(crumble.x, crumbleTop - 5, crumbleTop + 5),
        crumbleTop, 'Crumbling ledge regenerates');
    g.cameras.main.setScroll(40000, 0);
    g.world.update();
    g.cameras.main.setScroll(wall.x - 400, 0);
    g.world.update();
    assert.equal(g.world.resolvePlayerMovement(wall.x - 150, wall.x + 150, bodyY),
        wall.x + 150, 'Destroyed wall stays destroyed after section reload');
    g.events.emit('shutdown');
    console.log('PASS Phase 2 terrain: wall blocking, projectile hits, bridge board loss, crumble recovery and streaming state.');
}
