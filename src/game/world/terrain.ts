import { WORLD } from '../config/world';

export interface TerrainPlatform {
    id: string;
    x: number;
    width: number;
    height: number; // Top elevation from baseline ground.
    material?: 'stone' | 'bridge' | 'ramp';
}

// Twelve reusable spatial archetypes from the level-planning concept sheet.
// All coordinates are local to one 2560px section. Platforms are one-way
// landing geometry; styling/tiles can be swapped without changing traversal.
// Platform slots 1 and 3 remain valid for elevated chests and Pyromancers.
export const TERRAIN_LAYOUTS = [
    'flat-beginner', 'gentle-steps', 'broken-bridge', 'cave-shelves',
    'tower-approach', 'ruined-arches', 'combat-arena', 'alternating-pits',
    'long-ramp', 'dense-cluster', 'split-routes', 'castle-approach'
] as const;
export type TerrainLayoutKind = typeof TERRAIN_LAYOUTS[number];
export type TerrainGap = { start: number; end: number };

// [centre x, top elevation, platform width, material]. Staircases and ramps
// use connected/overlapping steps; bridges cross short, genuinely open pits.
type PlatformPlan = readonly [number, number, number, 'stone' | 'bridge' | 'ramp'];
type LayoutPlan = { platforms: readonly PlatformPlan[]; gaps?: readonly (readonly [number, number])[] };
const PLANS: Record<TerrainLayoutKind, LayoutPlan> = {
    'flat-beginner': { platforms: [
        [440, 48, 240, 'stone'], [744, 80, 240, 'stone'],
        [1460, 48, 240, 'stone'], [1760, 80, 240, 'stone']
    ] },
    'gentle-steps': { platforms: [
        [420, 48, 264, 'stone'], [710, 80, 264, 'stone'],
        [1100, 64, 264, 'stone'], [1410, 96, 264, 'stone'],
        [1780, 112, 288, 'stone'], [2090, 128, 280, 'stone']
    ] },
    'broken-bridge': { platforms: [
        [420, 56, 256, 'stone'], [730, 88, 256, 'stone'],
        [1060, 80, 192, 'bridge'], [1350, 96, 192, 'bridge'],
        [1670, 64, 256, 'stone'], [1950, 96, 256, 'stone']
    ], gaps: [[954, 1062], [1496, 1612]] },
    'cave-shelves': { platforms: [
        [420, 56, 256, 'stone'], [700, 88, 240, 'stone'],
        [1020, 128, 272, 'stone'], [1340, 88, 240, 'stone'],
        [1650, 128, 272, 'stone'], [1950, 88, 256, 'stone']
    ] },
    'tower-approach': { platforms: [
        [410, 48, 256, 'stone'], [680, 88, 240, 'stone'],
        [970, 128, 240, 'bridge'], [1230, 160, 224, 'bridge'],
        [1520, 112, 256, 'stone'], [1800, 160, 256, 'bridge'],
        [2090, 192, 256, 'stone']
    ] },
    'ruined-arches': { platforms: [
        [430, 56, 288, 'stone'], [740, 88, 224, 'stone'],
        [1050, 56, 288, 'bridge'], [1370, 88, 256, 'stone'],
        [1700, 64, 288, 'bridge'], [2030, 96, 256, 'stone']
    ] },
    'combat-arena': { platforms: [
        [440, 48, 320, 'stone'], [760, 96, 272, 'stone'],
        [1100, 144, 320, 'stone'], [1420, 80, 272, 'stone'],
        [1750, 128, 320, 'stone'], [2070, 72, 272, 'stone']
    ] },
    'alternating-pits': { platforms: [
        [420, 48, 256, 'stone'], [730, 80, 256, 'stone'],
        [1040, 64, 208, 'bridge'], [1340, 96, 256, 'stone'],
        [1660, 80, 208, 'bridge'], [1970, 112, 256, 'stone']
    ], gaps: [[985, 1093], [1608, 1716]] },
    'long-ramp': { platforms: [
        [440, 40, 320, 'ramp'], [740, 64, 320, 'ramp'],
        [1040, 88, 320, 'ramp'], [1340, 112, 320, 'ramp'],
        [1640, 136, 320, 'ramp'], [1940, 160, 320, 'ramp']
    ] },
    'dense-cluster': { platforms: [
        [380, 48, 240, 'stone'], [650, 88, 224, 'stone'],
        [930, 56, 224, 'stone'], [1190, 112, 224, 'stone'],
        [1450, 72, 224, 'stone'], [1710, 144, 224, 'stone'],
        [1950, 96, 224, 'stone'], [2210, 128, 224, 'stone']
    ] },
    'split-routes': { platforms: [
        [440, 56, 304, 'stone'], [760, 96, 304, 'stone'],
        [1070, 144, 304, 'bridge'], [1380, 176, 288, 'bridge'],
        [1700, 144, 304, 'bridge'], [2030, 96, 304, 'stone']
    ] },
    'castle-approach': { platforms: [
        [440, 48, 288, 'stone'], [760, 88, 288, 'bridge'],
        [1080, 128, 256, 'stone'], [1400, 88, 288, 'bridge'],
        [1700, 144, 272, 'stone'], [2010, 176, 320, 'stone']
    ] }
};

// The introduction is always gentle. Every subsequent section follows a
// deterministic 12-layout rotation; the seed changes local positions slightly.
export function terrainLayoutKind(index: number): TerrainLayoutKind {
    return TERRAIN_LAYOUTS[((index % TERRAIN_LAYOUTS.length) + TERRAIN_LAYOUTS.length) %
        TERRAIN_LAYOUTS.length];
}
export function generateTerrainGaps(index: number, _roll: number): TerrainGap[] {
    const source = PLANS[terrainLayoutKind(index)].gaps ?? [];
    // Keep pit geometry stable across generation, collisions and rendering.
    return source.map(([start, end]) => ({
        start: index * WORLD.sectionLength + start,
        end: index * WORLD.sectionLength + end
    }));
}
export function groundExists(x: number, gaps: readonly TerrainGap[]): boolean {
    return !gaps.some(gap => x > gap.start && x < gap.end);
}
export function generatePlatforms(index: number, seed: number, roll: number): TerrainPlatform[] {
    const start = index * WORLD.sectionLength;
    const plan = PLANS[terrainLayoutKind(index)].platforms;
    return plan.map(([offset, elevation, width, material], slot) => {
        // Tiny deterministic offsets prevent the 12 archetypes looking stamped.
        // First layout stays exact for the introductory encounter.
        const jitter = index === 0 ? 0 : (((roll >>> ((slot % 4) * 7)) & 3) - 1) * 8;
        return {
            id: `${seed >>> 0}:${index}:platform:${slot}`,
            x: start + offset + jitter,
            width, height: elevation, material
        };
    });
}

export function platformTop(groundY: number, platform: TerrainPlatform): number {
    return groundY - platform.height;
}

function covers(platform: TerrainPlatform, playerX: number): boolean {
    // Bridge sections have 6px of deliberate overlap between adjacent
    // boards. Using the general 4px inset on *each* board leaves a 2px
    // unsupported seam, causing a running player to drop between intact
    // planks. Preserve a small overlap in the actual collision bounds.
    const inset = platform.material === 'bridge' ? 2 : 4;
    return Math.abs(playerX - platform.x) <= platform.width / 2 - inset;
}

export function landingSurfaceY(platforms: readonly TerrainPlatform[], groundY: number,
    playerX: number, previousFoot: number, nextFoot: number,
    gaps: readonly TerrainGap[] = []): number | undefined {
    if (nextFoot < previousFoot) return undefined;
    let hit: number | undefined;
    for (const platform of platforms) {
        const top = platformTop(groundY, platform);
        if (covers(platform, playerX) && previousFoot <= top + 1 && nextFoot >= top &&
            (hit === undefined || top < hit)) hit = top;
    }
    if (groundExists(playerX, gaps) && previousFoot <= groundY + 1 && nextFoot >= groundY &&
        (hit === undefined || groundY < hit)) hit = groundY;
    return hit;
}

export function standingSurfaceY(platforms: readonly TerrainPlatform[], groundY: number,
    playerX: number, currentFoot: number,
    gaps: readonly TerrainGap[] = []): number | undefined {
    for (const platform of platforms) {
        const top = platformTop(groundY, platform);
        if (covers(platform, playerX) && Math.abs(currentFoot - top) < 2) return top;
    }
    return groundExists(playerX, gaps) && Math.abs(currentFoot - groundY) < 2 ? groundY : undefined;
}


// Solid collision for projectiles: an elevated ledge occupies its rendered
// 24px-thick slab, while the continuous ground extends below groundY.
// Returns first hit along a movement segment (t in [0, 1]), avoiding tunnelling.
export type TerrainImpact = { x: number; y: number; t: number };
export function terrainSegmentImpact(platforms: readonly TerrainPlatform[], groundY: number,
    x0: number, y0: number, x1: number, y1: number,
    gaps: readonly TerrainGap[] = []): TerrainImpact | undefined {
    const dx = x1 - x0, dy = y1 - y0;
    let closest = Infinity;
    const slab = (minX: number, maxX: number, minY: number, maxY: number): void => {
        let enter = 0, leave = 1;
        for (const [position, delta, min, max] of [
            [x0, dx, minX, maxX], [y0, dy, minY, maxY]
        ]) {
            if (Math.abs(delta) < 1e-9) {
                if (position < min || position > max) return;
            } else {
                const a = (min - position) / delta, b = (max - position) / delta;
                enter = Math.max(enter, Math.min(a, b));
                leave = Math.min(leave, Math.max(a, b));
                if (enter > leave) return;
            }
        }
        closest = Math.min(closest, enter);
    };
    for (const platform of platforms) {
        const top = platformTop(groundY, platform);
        slab(platform.x - platform.width / 2, platform.x + platform.width / 2,
            top, top + 24);
    }
    // Ground is solid even for horizontal shots that begin slightly below it.
    // Avoid treating open gaps as solid ground: each section contributes
    // separate slabs on either side of the pit intervals.
    const minX = Math.min(x0, x1) - 1, maxX = Math.max(x0, x1) + 1;
    const relevant = gaps.filter(gap => gap.end > minX && gap.start < maxX)
        .sort((a, b) => a.start - b.start);
    let cursor = minX;
    for (const gap of relevant) {
        if (gap.start > cursor) slab(cursor, gap.start, groundY, Infinity);
        cursor = Math.max(cursor, gap.end);
    }
    if (cursor < maxX) slab(cursor, maxX, groundY, Infinity);
    return Number.isFinite(closest) ? {
        x: x0 + dx * closest, y: y0 + dy * closest, t: closest
    } : undefined;
}

export function headCoveredByPlatform(platforms: readonly TerrainPlatform[],
    groundY: number, x: number, enemyBodyY: number): boolean {
    return platforms.some(platform => covers(platform, x) &&
        platformTop(groundY, platform) < enemyBodyY);
}
