/**
 * Builds a small, persistent DuckDB file for manual testing of the OGC API
 * Features server in QGIS.
 *
 * Place: Prospect Park, Brooklyn, New York City — a compact, recognisable
 * park (~2km x 2km) so the three layers overlap in one QGIS view instead of
 * being scattered across the world.
 *
 * Produces three tables under tenant prefix `demo`, so the server exposes
 * collections `points`, `lines`, `polygons` for tenant key `demo`
 * (`demo_points`, `demo_lines`, `demo_polygons`):
 *
 *   - demo_points   ~7 park landmarks (POINT)
 *   - demo_lines    3 park drives/paths (LINESTRING)
 *   - demo_polygons 3 park zones — meadows and the lake (POLYGON)
 *
 * Run with: npx tsx examples/build-demo-duckdb.ts
 */

import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'demo.duckdb');

interface PointFeature {
    id: number;
    name: string;
    category: string;
    rating: number;
    capacity: number;
    is_accessible: boolean;
    lon: number;
    lat: number;
}

interface LineFeature {
    id: number;
    name: string;
    surface: string;
    length_m: number;
    daily_users: number;
    is_paved: boolean;
    coords: [number, number][];
}

interface PolygonFeature {
    id: number;
    name: string;
    zone_type: string;
    area_ha: number;
    max_capacity: number;
    is_protected: boolean;
    coords: [number, number][];
}

const POINTS: PointFeature[] = [
    { id: 1, name: 'Grand Army Plaza Entrance', category: 'entrance', rating: 4.5, capacity: 0, is_accessible: true, lon: -73.9700, lat: 40.6733 },
    { id: 2, name: 'Picnic House', category: 'venue', rating: 4.2, capacity: 200, is_accessible: true, lon: -73.9713, lat: 40.6660 },
    { id: 3, name: 'Prospect Park Bandshell', category: 'venue', rating: 4.6, capacity: 5000, is_accessible: true, lon: -73.9738, lat: 40.6667 },
    { id: 4, name: 'Prospect Park Zoo Entrance', category: 'entrance', rating: 4.3, capacity: 0, is_accessible: true, lon: -73.9628, lat: 40.6602 },
    { id: 5, name: 'LeFrak Center at Lakeside', category: 'venue', rating: 4.4, capacity: 1000, is_accessible: true, lon: -73.9646, lat: 40.6555 },
    { id: 6, name: 'Vanderbilt Playground', category: 'playground', rating: 4.0, capacity: 150, is_accessible: false, lon: -73.9698, lat: 40.6716 },
    { id: 7, name: 'Tennis Center', category: 'sports', rating: 3.9, capacity: 100, is_accessible: true, lon: -73.9724, lat: 40.6688 }
];

const LINES: LineFeature[] = [
    {
        id: 1,
        name: 'West Drive Loop',
        surface: 'asphalt',
        length_m: 4000,
        daily_users: 3000,
        is_paved: true,
        coords: [
            [-73.9760, 40.6730],
            [-73.9770, 40.6700],
            [-73.9765, 40.6660],
            [-73.9750, 40.6610],
            [-73.9700, 40.6570]
        ]
    },
    {
        id: 2,
        name: 'East Drive Loop',
        surface: 'asphalt',
        length_m: 4200,
        daily_users: 2800,
        is_paved: true,
        coords: [
            [-73.9690, 40.6725],
            [-73.9660, 40.6690],
            [-73.9640, 40.6640],
            [-73.9630, 40.6590],
            [-73.9660, 40.6560]
        ]
    },
    {
        id: 3,
        name: 'Center Drive Connector',
        surface: 'gravel',
        length_m: 1800,
        daily_users: 900,
        is_paved: false,
        coords: [
            [-73.9750, 40.6700],
            [-73.9720, 40.6680],
            [-73.9700, 40.6650],
            [-73.9680, 40.6620]
        ]
    }
];

const POLYGONS: PolygonFeature[] = [
    {
        id: 1,
        name: 'Long Meadow',
        zone_type: 'meadow',
        area_ha: 36.4,
        max_capacity: 5000,
        is_protected: true,
        coords: [
            [-73.9760, 40.6720],
            [-73.9740, 40.6720],
            [-73.9740, 40.6650],
            [-73.9760, 40.6650],
            [-73.9760, 40.6720]
        ]
    },
    {
        id: 2,
        name: 'Prospect Lake',
        zone_type: 'water',
        area_ha: 24.3,
        max_capacity: 0,
        is_protected: true,
        coords: [
            [-73.9680, 40.6600],
            [-73.9630, 40.6600],
            [-73.9630, 40.6560],
            [-73.9680, 40.6560],
            [-73.9680, 40.6600]
        ]
    },
    {
        id: 3,
        name: 'The Nethermead',
        zone_type: 'meadow',
        area_ha: 20.2,
        max_capacity: 3000,
        is_protected: false,
        coords: [
            [-73.9700, 40.6660],
            [-73.9660, 40.6660],
            [-73.9660, 40.6630],
            [-73.9700, 40.6630],
            [-73.9700, 40.6660]
        ]
    }
];

async function main() {
    if (existsSync(DB_PATH)) {
        unlinkSync(DB_PATH);
        console.log(`Removed stale ${DB_PATH}`);
    }

    const instance = await DuckDBInstance.create(DB_PATH);
    const db = await instance.connect();
    await db.run('INSTALL spatial; LOAD spatial;');

    // --- demo_points ---------------------------------------------------
    await db.run(`
        CREATE TABLE demo_points (
            id INTEGER PRIMARY KEY,
            name VARCHAR,
            category VARCHAR,
            rating DOUBLE,
            capacity INTEGER,
            is_accessible BOOLEAN,
            geometry GEOMETRY
        );
    `);

    for (const p of POINTS) {
        await db.run(`
            INSERT INTO demo_points (id, name, category, rating, capacity, is_accessible, geometry)
            VALUES (?, ?, ?, ?, ?, ?, ST_Point(?, ?))
        `, [p.id, p.name, p.category, p.rating, p.capacity, p.is_accessible, p.lon, p.lat]);
    }

    // --- demo_lines ------------------------------------------------------
    await db.run(`
        CREATE TABLE demo_lines (
            id INTEGER PRIMARY KEY,
            name VARCHAR,
            surface VARCHAR,
            length_m DOUBLE,
            daily_users INTEGER,
            is_paved BOOLEAN,
            geometry GEOMETRY
        );
    `);

    for (const l of LINES) {
        const coordString = l.coords.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
        await db.run(`
            INSERT INTO demo_lines (id, name, surface, length_m, daily_users, is_paved, geometry)
            VALUES (?, ?, ?, ?, ?, ?, ST_GeomFromText('LINESTRING(${coordString})'))
        `, [l.id, l.name, l.surface, l.length_m, l.daily_users, l.is_paved]);
    }

    // --- demo_polygons -----------------------------------------------
    await db.run(`
        CREATE TABLE demo_polygons (
            id INTEGER PRIMARY KEY,
            name VARCHAR,
            zone_type VARCHAR,
            area_ha DOUBLE,
            max_capacity INTEGER,
            is_protected BOOLEAN,
            geometry GEOMETRY
        );
    `);

    for (const poly of POLYGONS) {
        const coordString = poly.coords.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
        await db.run(`
            INSERT INTO demo_polygons (id, name, zone_type, area_ha, max_capacity, is_protected, geometry)
            VALUES (?, ?, ?, ?, ?, ?, ST_GeomFromText('POLYGON((${coordString}))'))
        `, [poly.id, poly.name, poly.zone_type, poly.area_ha, poly.max_capacity, poly.is_protected]);
    }

    // --- summary -----------------------------------------------------
    console.log(`\nBuilt ${DB_PATH}\n`);

    const tables: { table: string; geomType: string }[] = [
        { table: 'demo_points', geomType: 'Point' },
        { table: 'demo_lines', geomType: 'LineString' },
        { table: 'demo_polygons', geomType: 'Polygon' }
    ];

    for (const { table, geomType } of tables) {
        const reader = await db.runAndReadAll(`SELECT count(*) AS count FROM ${table}`);
        const count = reader.getRowObjectsJS()[0]?.count;
        console.log(`  ${table.padEnd(14)} rows: ${count}  geometry: ${geomType}`);
    }

    db.disconnectSync();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
