import { Scenes } from 'phaser';
import type { Scene, GameObjects } from 'phaser';
import { WORLD } from '../config/world';
import { BALANCE } from '../config/balance';
import { generateSection, sectionWindow } from './sections';
import type { WorldSection } from './sections';
import { landingSurfaceY, standingSurfaceY, terrainSegmentImpact, headCoveredByPlatform } from './terrain';
import type { TerrainImpact } from './terrain';
import type { TerrainPlatform, TerrainGap } from './terrain';
import { terrainPieces, segmentWallImpact } from './terrainFeatures';
import type { TerrainPiece, BreakableWall } from './terrainFeatures';
import type { Landmark } from './landmarks';
import { terrainTexture, ENVIRONMENT_ASSETS } from './environmentAssets';

type SectionVisuals = {
    data: WorldSection;
    objects: GameObjects.GameObject[];
    scenery: GameObjects.Ellipse[];
    features: Map<string, GameObjects.GameObject[]>;
};

// Deterministic geometry is separate from optional terrain textures. The ground
// remains uninterrupted; platforms are forgiving, one-way landing surfaces.
export class WorldSystem {
    private sections = new Map<number, SectionVisuals>();
    private backgrounds: { sprite: GameObjects.TileSprite; factor: number }[] = [];
    private mutable = new Map<string, { hp?: number; breakUntil?: number; triggerAt?: number }>();
    private clock = 0;

    constructor(private scene: Scene, private seed: number, private groundY: number) {
        scene.events.once(Scenes.Events.SHUTDOWN, this.destroy, this);
        this.createBackgrounds();
        this.update();
    }

    private createBackgrounds(): void {
        const entries = Object.values(ENVIRONMENT_ASSETS.breadlands.backgrounds);
        for (const entry of entries) {
            if (!terrainTexture(this.scene, entry.key)) continue;
            const { width, height } = this.scene.scale;
            const sprite = this.scene.add.tileSprite(width / 2, height / 2, width, height, entry.key)
                .setScrollFactor(0).setDepth(-10 + this.backgrounds.length);
            this.backgrounds.push({ sprite, factor: entry.scrollFactor });
        }
    }

    private tile(x: number, y: number, width: number, height: number,
        key: string, colour: number, depth: number): GameObjects.GameObject {
        if (terrainTexture(this.scene, key)) {
            return this.scene.add.image(x, y, key).setDisplaySize(width, height).setDepth(depth);
        }
        return this.scene.add.rectangle(x, y, width, height, colour).setDepth(depth);
    }

    private drawPlatform(platform: TerrainPlatform): GameObjects.GameObject[] {
        const tile = WORLD.terrainTileSize;
        const top = this.groundY - platform.height;
        const count = Math.round(platform.width / tile);
        const first = platform.x - platform.width / 2;
        const result: GameObjects.GameObject[] = [];
        // Until tile artwork is supplied, draw each ledge as two large shapes,
        // not dozens of individual rectangles. Keeps streaming cost low.
        if (!['breadlands:platform-left', 'breadlands:platform-middle', 'breadlands:platform-right']
            .some(key => terrainTexture(this.scene, key))) {
            return [
                this.scene.add.rectangle(platform.x, top + 12, platform.width, 24,
                    platform.material === 'bridge' ? 0x8b6850 :
                        platform.material === 'ramp' ? 0x91876a : 0x95734f).setDepth(3),
                this.scene.add.rectangle(platform.x, top + 1.5, platform.width, 3,
                    platform.material === 'bridge' ? 0xc6a77a : 0x86b35b).setDepth(4)
            ];
        }
        // Narrow ledge body; full height is not solid, so players can jump through
        // its underside and land on the top surface.
        for (let i = 0; i < count; i++) {
            const x = first + tile * (i + 0.5);
            const key = i === 0 ? 'breadlands:platform-left' :
                i === count - 1 ? 'breadlands:platform-right' : 'breadlands:platform-middle';
            // Full-size art tiles are never squashed to placeholder ledge height.
            result.push(terrainTexture(this.scene, key) ?
                this.tile(x, top + tile / 2, tile, tile, key, 0x95734f, 3) :
                this.tile(x, top + 12, tile, 24, key, 0x95734f, 3));
            result.push(this.scene.add.rectangle(x, top + 1.5, tile, 3, 0x86b35b).setDepth(4));
        }
        return result;
    }

    // Landmarks create visual rhythm without changing combat collision. Later
    // artwork can replace each composition through the environment manifest.
    private drawLandmark(landmark: Landmark): GameObjects.GameObject[] {
        const x = landmark.x, y = this.groundY, scale = landmark.scale;
        const key = `breadlands:${landmark.kind}`;
        const sizes: Record<Landmark['kind'], [number, number]> = {
            arch: [160, 172], watchtower: [110, 226], ruins: [172, 112],
            fence: [190, 70], boulders: [145, 80], sign: [70, 100]
        };
        if (terrainTexture(this.scene, key)) {
            const [width, height] = sizes[landmark.kind];
            return [this.scene.add.image(x, y, key).setOrigin(0.5, 1)
                .setDisplaySize(width * scale, height * scale).setFlipX(landmark.flip).setDepth(0)];
        }
        const result: GameObjects.GameObject[] = [];
        const rect = (dx: number, dy: number, w: number, h: number, colour: number) => {
            result.push(this.scene.add.rectangle(x + dx * scale, y + dy * scale,
                w * scale, h * scale, colour).setDepth(0));
        };
        const oval = (dx: number, dy: number, w: number, h: number, colour: number) => {
            result.push(this.scene.add.ellipse(x + dx * scale, y + dy * scale,
                w * scale, h * scale, colour).setDepth(0));
        };
        switch (landmark.kind) {
            case 'arch':
                rect(-56, -72, 24, 144, 0x827e73); rect(56, -72, 24, 144, 0x827e73);
                rect(0, -148, 144, 20, 0xaaa190);
                rect(0, -158, 165, 10, 0x6c8771);
                break;
            case 'watchtower':
                rect(-36, -94, 16, 188, 0x75634c); rect(36, -94, 16, 188, 0x75634c);
                rect(0, -172, 118, 18, 0x986e48);
                rect(0, -205, 98, 12, 0x6c8771);
                rect(-48, -190, 12, 36, 0x6d4d30); rect(48, -190, 12, 36, 0x6d4d30);
                break;
            case 'ruins':
                rect(-60, -42, 36, 84, 0x918f83);
                rect(60, -55, 34, 110, 0xaaa697);
                rect(-25, -90, 120, 16, 0xa5a195);
                rect(33, -17, 86, 32, 0x7e8b71);
                break;
            case 'fence':
                rect(0, -28, 190, 10, 0xa57d54);
                rect(0, -55, 190, 8, 0xc4a074);
                for (const dx of [-78, -26, 26, 78]) rect(dx, -38, 13, 76, 0x78583b);
                break;
            case 'boulders':
                oval(-38, -25, 78, 52, 0x81877f);
                oval(30, -34, 94, 66, 0xa2a59a);
                oval(6, -8, 55, 26, 0x697b68);
                break;
            case 'sign':
                rect(0, -44, 11, 88, 0x7c5334);
                rect(8, -77, 75, 33, 0xc99d64);
                rect(11, -77, 55, 5, 0x765135);
                break;
        }
        return result;
    }

    private drawSection(data: WorldSection): SectionVisuals {
        const objects: GameObjects.GameObject[] = [];
        // Irregular soft distant hills replace the former repeating rectangle
        // columns. These are scenery only: no terrain collisions.
        const scenery = data.sceneryXs.map(x => {
            const variation = (Math.imul(Math.floor(x / BALANCE.scenery.spacing) + 1, 1103515245)
                ^ data.seed) >>> 0;
            const width = 170 + (variation % 120);
            const height = 110 + ((variation >>> 8) % 100);
            const colour = variation & 1 ? 0x8fa6a2 : 0x9ab1a3;
            return this.scene.add.ellipse(x, this.groundY - height / 2 + 10,
                width, height, colour, 0.3).setDepth(0).setScrollFactor(1);
        });
        objects.push(...scenery);
        const height = this.scene.scale.height;
        const tile = WORLD.terrainTileSize;
        // Physical holes remove both the ground-top strip and fill artwork.
        // Draw the remaining horizontal solid ranges, separated by real pits.
        const ranges: { start: number; end: number }[] = [];
        let cursor = data.startX;
        for (const gap of data.gaps) {
            if (gap.start > cursor) ranges.push({ start: cursor, end: gap.start });
            cursor = Math.max(cursor, gap.end);
        }
        if (cursor < data.endX) ranges.push({ start: cursor, end: data.endX });
        for (const range of ranges) {
            const width = range.end - range.start, centre = (range.start + range.end) / 2;
            objects.push(this.scene.add.rectangle(centre,
                this.groundY + (height - this.groundY) / 2,
                width, height - this.groundY, 0x65865b).setDepth(1));
            if (!terrainTexture(this.scene, 'breadlands:ground-top')) {
                objects.push(this.scene.add.rectangle(centre, this.groundY + 5,
                    width, 10, 0x425b3c).setDepth(2));
            } else {
                // Tile art may extend over the hole if simply placed by centre;
                // clip boundary tiles to exact ranges with a small placeholder.
                for (let x = range.start; x < range.end; x += tile) {
                    const w = Math.min(tile, range.end - x);
                    if (w < tile) objects.push(this.scene.add.rectangle(x + w / 2,
                        this.groundY + 5, w, 10, 0x425b3c).setDepth(2));
                    else objects.push(this.tile(x + tile / 2, this.groundY + tile / 2,
                        tile, tile, 'breadlands:ground-top', 0x52744a, 2));
                }
            }
            if (terrainTexture(this.scene, 'breadlands:ground-fill')) {
                for (let x = range.start; x < range.end; x += tile) {
                    const w = Math.min(tile, range.end - x);
                    for (let y = this.groundY + tile * 1.5; y < height + tile / 2; y += tile) {
                        if (w < tile) objects.push(this.scene.add.rectangle(x + w / 2,
                            y, w, tile, 0x65865b).setDepth(1));
                        else objects.push(this.tile(x + tile / 2, y, tile, tile,
                            'breadlands:ground-fill', 0x65865b, 1));
                    }
                }
            }
        }
        const features = new Map<string, GameObjects.GameObject[]>();
        for (const piece of terrainPieces(data.platforms, data.index)) {
            const objectsForPiece = this.drawPlatform(piece);
            features.set(piece.id, objectsForPiece);
            objects.push(...objectsForPiece);
        }
        for (const wall of data.walls) {
            const blocks: GameObjects.GameObject[] = [
                this.scene.add.rectangle(wall.x, this.groundY - wall.height / 2,
                    wall.width, wall.height, 0x857b6c).setDepth(5),
                this.scene.add.rectangle(wall.x, this.groundY - wall.height / 2,
                    5, wall.height - 12, 0x40372e).setDepth(6),
                this.scene.add.rectangle(wall.x, this.groundY - 26,
                    wall.width - 8, 5, 0xbab0a0).setDepth(6)
            ];
            features.set(wall.id, blocks);
            objects.push(...blocks);
        }
        for (const landmark of data.landmarks) objects.push(...this.drawLandmark(landmark));
        return { data, objects, scenery, features };
    }

    private platformsNear(x: number): TerrainPlatform[] {
        const index = Math.floor(x / WORLD.sectionLength);
        const result: TerrainPlatform[] = [];
        for (const i of [index - 1, index, index + 1]) {
            if (i < 0) continue;
            const data = this.sections.get(i)?.data ?? generateSection(i, this.seed);
            result.push(...terrainPieces(data.platforms, i).filter(p => this.piecePresent(p)));
        }
        return result;
    }

    private wallsNear(x: number): BreakableWall[] {
        const index = Math.floor(x / WORLD.sectionLength);
        const walls: BreakableWall[] = [];
        for (const i of [index - 1, index, index + 1]) {
            if (i < 0) continue;
            const data = this.sections.get(i)?.data ?? generateSection(i, this.seed);
            walls.push(...data.walls.filter(w => this.wallPresent(w)));
        }
        return walls;
    }

    private wallPresent(wall: BreakableWall): boolean {
        return (this.mutable.get(wall.id)?.hp ?? wall.hp) > 0;
    }

    private piecePresent(piece: TerrainPiece): boolean {
        const state = this.mutable.get(piece.id);
        return piece.feature === 'bridge' ? (state?.hp ?? 2) > 0 :
            piece.feature === 'crumble' ? state?.breakUntil === undefined ||
                this.clock >= state.breakUntil : true;
    }

    // Called with simulation dt: all warning and respawn clocks pause naturally.
    advance(dt: number, playerX: number, foot: number): void {
        this.clock += dt;
        const section = Math.floor(playerX / WORLD.sectionLength);
        if (section < 0) return;
        const data = this.sections.get(section)?.data ?? generateSection(section, this.seed);
        for (const piece of terrainPieces(data.platforms, section)) {
            if (piece.feature !== 'crumble') continue;
            const state = this.mutable.get(piece.id) ?? {};
            // Once triggered, the warning countdown continues even if the
            // player jumps away. No delayed surprise collapse on returning.
            if (state.triggerAt !== undefined && this.clock - state.triggerAt >= 0.8) {
                state.breakUntil = state.triggerAt + 4.8;
                state.triggerAt = undefined;
            }
            if (state.breakUntil !== undefined && this.clock >= state.breakUntil) {
                this.mutable.delete(piece.id);
                // If the hero is standing at the regeneration point, arm it
                // again on the following step rather than instantly breaking.
                continue;
            }
            if (state.breakUntil !== undefined) {
                this.mutable.set(piece.id, state);
                continue;
            }
            if (Math.abs(playerX - piece.x) <= piece.width / 2 - 4 &&
                Math.abs(foot - (this.groundY - piece.height)) <= 3) {
                if (state.triggerAt === undefined) state.triggerAt = this.clock;
                this.mutable.set(piece.id, state);
            }
        }
    }

    // Terrain determines whether a fireball/strike reaches its target first.
    terrainImpact(x0: number, y0: number, x1: number, y1: number): TerrainImpact | undefined {
        const mid = (x0 + x1) / 2;
        const surface = terrainSegmentImpact(this.platformsNear(mid),
            this.groundY, x0, y0, x1, y1, this.gapsNear(mid));
        let nearest = surface;
        for (const wall of this.wallsNear(mid)) {
            const t = segmentWallImpact(x0, y0, x1, y1, wall, this.groundY);
            if (t !== undefined && (!nearest || t < nearest.t))
                nearest = { t, x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
        }
        return nearest;
    }

    // Candy's magic passes freely through elevated one-way platforms,
    // including bridge planks. The actual ground and solid walls block it.
    // Other projectiles (e.g. enemy fire) retain their existing collisions.
    projectileImpact(x0: number, y0: number, x1: number, y1: number): TerrainImpact | undefined {
        const mid = (x0 + x1) / 2;
        let nearest = terrainSegmentImpact([], this.groundY,
            x0, y0, x1, y1, this.gapsNear(mid));
        for (const wall of this.wallsNear(mid)) {
            const t = segmentWallImpact(x0, y0, x1, y1, wall, this.groundY);
            if (t !== undefined && (!nearest || t < nearest.t))
                nearest = { t, x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t };
        }
        return nearest;
    }

    // A wall is genuinely solid, but its destruction immediately opens a route.
    resolvePlayerMovement(from: number, to: number, playerY: number): number {
        if (Math.abs(playerY - (this.groundY - BALANCE.player.groundOffset)) > 80)
            return to;
        for (const wall of this.wallsNear((from + to) / 2)) {
            const edge = wall.width / 2 + 23;
            if (to > from && from <= wall.x - edge && to >= wall.x - edge)
                to = Math.min(to, wall.x - edge);
            else if (to < from && from >= wall.x + edge && to <= wall.x + edge)
                to = Math.max(to, wall.x + edge);
        }
        return to;
    }

    private damagePiece(id: string, baseHp: number, damage: number): number {
        const hp = this.mutable.get(id)?.hp ?? baseHp;
        const dealt = Math.min(hp, damage);
        if (dealt > 0) this.mutable.set(id, { hp: hp - dealt });
        return dealt;
    }

    // Called only after a projectile hits solid terrain; prevents shooting
    // through stone while permitting breakable bridge boards and wall damage.
    damageAtImpact(x: number, y: number, damage: number): number {
        for (const wall of this.wallsNear(x)) {
            if (Math.abs(wall.x - x) <= wall.width / 2 + 2 &&
                y >= this.groundY - wall.height - 2 && y <= this.groundY + 2)
                return this.damagePiece(wall.id, wall.hp, damage);
        }
        const index = Math.floor(x / WORLD.sectionLength);
        for (const i of [index - 1, index, index + 1]) {
            if (i < 0) continue;
            const data = this.sections.get(i)?.data ?? generateSection(i, this.seed);
            for (const piece of terrainPieces(data.platforms, i)) {
                if (piece.feature !== 'bridge' || !this.piecePresent(piece)) continue;
                const top = this.groundY - piece.height;
                if (Math.abs(x - piece.x) <= piece.width / 2 + 2 &&
                    y >= top - 2 && y <= top + 26)
                    return this.damagePiece(piece.id, 2, damage);
            }
        }
        return 0;
    }

    // One swing damages the closest destructible in the attack direction,
    // preserving the sword's existing attack range/cooldown.
    strikeTerrain(x: number, y: number, direction: -1 | 1,
        range: number, damage: number): { x: number; y: number; amount: number } | undefined {
        const candidates: { x: number; y: number; id: string; hp: number; dist: number }[] = [];
        for (const wall of this.wallsNear(x + direction * range / 2)) {
            const dist = (wall.x - x) * direction;
            if (dist > -wall.width / 2 && dist <= range + wall.width / 2 &&
                Math.abs(y - (this.groundY - wall.height / 2)) < 78)
                candidates.push({ x: wall.x, y: this.groundY - wall.height / 2,
                    id: wall.id, hp: wall.hp, dist });
        }
        for (const i of [Math.floor(x / WORLD.sectionLength),
            Math.floor((x + direction * range) / WORLD.sectionLength)]) {
            if (i < 0) continue;
            const data = this.sections.get(i)?.data ?? generateSection(i, this.seed);
            for (const piece of terrainPieces(data.platforms, i)) {
                if (piece.feature !== 'bridge' || !this.piecePresent(piece)) continue;
                const dist = (piece.x - x) * direction;
                if (dist < -piece.width / 2 || dist > range + piece.width / 2 ||
                    Math.abs(y - (this.groundY - piece.height + 12)) > 72) continue;
                candidates.push({ x: piece.x, y: this.groundY - piece.height,
                    id: piece.id, hp: 2, dist });
            }
        }
        candidates.sort((a, b) => a.dist - b.dist);
        const target = candidates[0];
        if (!target) return undefined;
        const amount = this.damagePiece(target.id, target.hp, damage);
        return amount > 0 ? { x: target.x, y: target.y, amount } : undefined;
    }

    enemyHeadExposed(x: number, enemyBodyY: number): boolean {
        return !headCoveredByPlatform(this.platformsNear(x), this.groundY, x, enemyBodyY);
    }

    private gapsNear(x: number): TerrainGap[] {
        const index = Math.floor(x / WORLD.sectionLength);
        const result: TerrainGap[] = [];
        for (const i of [index - 1, index, index + 1]) {
            if (i < 0) continue;
            const data = this.sections.get(i)?.data ?? generateSection(i, this.seed);
            result.push(...data.gaps);
        }
        return result;
    }

    landingY(x: number, previousFoot: number, nextFoot: number): number | undefined {
        return landingSurfaceY(this.platformsNear(x), this.groundY, x, previousFoot, nextFoot,
            this.gapsNear(x));
    }

    standingY(x: number, currentFoot: number): number | undefined {
        return standingSurfaceY(this.platformsNear(x), this.groundY, x, currentFoot,
            this.gapsNear(x));
    }

    update(): void {
        const camera = this.scene.cameras.main;
        for (const layer of this.backgrounds) layer.sprite.tilePositionX = camera.scrollX * layer.factor;
        const prepare = sectionWindow(camera.scrollX, camera.width, WORLD.preparationViewports);
        const retain = sectionWindow(camera.scrollX, camera.width, WORLD.cleanupViewports);
        for (const [index, section] of this.sections) {
            if (index < retain.first || index > retain.last) {
                section.objects.forEach(object => object.destroy());
                this.sections.delete(index);
            }
        }
        for (let index = prepare.first; index <= prepare.last; index++) {
            if (this.sections.has(index)) continue;
            this.sections.set(index, this.drawSection(generateSection(index, this.seed)));
        }
        for (const section of this.sections.values()) {
            const platformById = new Map(terrainPieces(section.data.platforms, section.data.index)
                .map(piece => [piece.id, piece]));
            for (const [id, pieces] of section.features) {
                const platform = platformById.get(id);
                const wall = section.data.walls.find(w => w.id === id);
                const visible = platform ? this.piecePresent(platform) : wall ? this.wallPresent(wall) : true;
                const state = this.mutable.get(id);
                const alpha = platform?.feature === 'crumble' && state?.triggerAt !== undefined ?
                    0.45 : wall ? Math.max(0.35, (state?.hp ?? wall.hp) / wall.hp) : 1;
                for (const piece of pieces) {
                    if ('setVisible' in piece && typeof piece.setVisible === 'function')
                        piece.setVisible(visible);
                    if ('setAlpha' in piece && typeof piece.setAlpha === 'function')
                        piece.setAlpha(alpha);
                }
            }
            for (const block of section.scenery) {
                const visible = block.x >= camera.scrollX - BALANCE.scenery.spacing &&
                    block.x <= camera.scrollX + camera.width + BALANCE.scenery.spacing;
                if (block.visible !== visible) block.setVisible(visible);
            }
        }
    }

    destroy(): void {
        this.scene.events.off(Scenes.Events.SHUTDOWN, this.destroy, this);
        for (const section of this.sections.values()) section.objects.forEach(object => object.destroy());
        for (const layer of this.backgrounds) layer.sprite.destroy();
        this.backgrounds = [];
        this.sections.clear();
        this.mutable.clear();
    }
}
