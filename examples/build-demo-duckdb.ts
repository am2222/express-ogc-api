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
 * (`demo_points`, `demo_lines`, `demo_polygons`). Between the three tables,
 * every column type `getSchema` now maps to a `format` for is exercised at
 * least once — `INTEGER`, `BIGINT`, `VARCHAR`, `DOUBLE`, `DECIMAL`,
 * `BOOLEAN`, `DATE`, `TIMESTAMP`, `TIME`, `UUID`, a real `ENUM`, and `BLOB`
 * — and several columns carry a `COMMENT ON COLUMN` so `description` has
 * something real to show:
 *
 *   - demo_points   ~7 park landmarks (POINT) — adds a real ENUM
 *                   (`landmark_category`), `DATE`, `TIMESTAMP`.
 *   - demo_lines    3 park drives/paths (LINESTRING) — adds a real ENUM
 *                   (`surface_kind`), `TIME`, and a `BIGINT` (one value
 *                   deliberately above `Number.MAX_SAFE_INTEGER`, to keep
 *                   the bigint-normalisation path exercised).
 *   - demo_polygons 3 park zones — meadows and the lake (POLYGON) — adds
 *                   `DECIMAL(10,2)`, `UUID`, `BLOB`.
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
    opened_on: string;
    last_inspected: string;
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
    maintenance_time: string;
    segment_code: bigint;
    coords: [number, number][];
}

interface PolygonFeature {
    id: number;
    name: string;
    zone_type: string;
    area_ha: number;
    max_capacity: number;
    is_protected: boolean;
    parcel_uuid: string;
    boundary_survey: string;
    coords: [number, number][];
}

const POINTS: PointFeature[] = [
    { id: 1, name: 'Grand Army Plaza Entrance', category: 'entrance', rating: 4.5, capacity: 0, is_accessible: true, opened_on: '1867-05-19', last_inspected: '2025-03-04 09:15:00', lon: -73.9700, lat: 40.6733 },
    { id: 2, name: 'Picnic House', category: 'venue', rating: 4.2, capacity: 200, is_accessible: true, opened_on: '1927-05-01', last_inspected: '2025-05-22 13:40:00', lon: -73.9713, lat: 40.6660 },
    { id: 3, name: 'Prospect Park Bandshell', category: 'venue', rating: 4.6, capacity: 5000, is_accessible: true, opened_on: '1939-06-15', last_inspected: '2025-06-10 10:00:00', lon: -73.9738, lat: 40.6667 },
    { id: 4, name: 'Prospect Park Zoo Entrance', category: 'entrance', rating: 4.3, capacity: 0, is_accessible: true, opened_on: '1935-05-06', last_inspected: '2025-04-18 08:30:00', lon: -73.9628, lat: 40.6602 },
    { id: 5, name: 'LeFrak Center at Lakeside', category: 'venue', rating: 4.4, capacity: 1000, is_accessible: true, opened_on: '2013-12-14', last_inspected: '2025-07-01 11:20:00', lon: -73.9646, lat: 40.6555 },
    { id: 6, name: 'Vanderbilt Playground', category: 'playground', rating: 4.0, capacity: 150, is_accessible: false, opened_on: '1970-04-01', last_inspected: '2025-02-27 15:05:00', lon: -73.9698, lat: 40.6716 },
    { id: 7, name: 'Tennis Center', category: 'sports', rating: 3.9, capacity: 100, is_accessible: true, opened_on: '1990-06-01', last_inspected: '2025-06-30 07:45:00', lon: -73.9724, lat: 40.6688 }
];

const LINES: LineFeature[] = [
    {
        id: 1,
        name: 'West Drive Loop',
        surface: 'asphalt',
        length_m: 4000,
        daily_users: 3000,
        is_paved: true,
        maintenance_time: '05:30:00',
        // Deliberately above Number.MAX_SAFE_INTEGER (9007199254740991), to
        // keep DuckDBProvider's bigint-normalisation path (F1) exercised
        // against real demo data, not just the test suite.
        segment_code: 9223372036854775000n,
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
        maintenance_time: '06:15:30',
        segment_code: 987654321012n,
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
        maintenance_time: '07:00:00',
        segment_code: 555000111n,
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
        parcel_uuid: '5b1f0e0a-6b1f-4a1a-9c3e-1a2b3c4d5e01',
        boundary_survey: 'survey-doc-checksum:long-meadow-2024',
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
        parcel_uuid: '5b1f0e0a-6b1f-4a1a-9c3e-1a2b3c4d5e02',
        boundary_survey: 'survey-doc-checksum:prospect-lake-2024',
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
        parcel_uuid: '5b1f0e0a-6b1f-4a1a-9c3e-1a2b3c4d5e03',
        boundary_survey: 'survey-doc-checksum:the-nethermead-2024',
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
        CREATE TYPE landmark_category AS ENUM ('entrance', 'venue', 'playground', 'sports');
        CREATE TABLE demo_points (
            id INTEGER PRIMARY KEY,
            name VARCHAR,
            category landmark_category,
            rating DOUBLE,
            capacity INTEGER,
            is_accessible BOOLEAN,
            opened_on DATE,
            last_inspected TIMESTAMP,
            geometry GEOMETRY
        );
        COMMENT ON COLUMN demo_points.name IS 'Landmark name';
        COMMENT ON COLUMN demo_points.category IS 'Kind of landmark';
        COMMENT ON COLUMN demo_points.opened_on IS 'Date the landmark first opened to the public';
        COMMENT ON COLUMN demo_points.last_inspected IS 'Timestamp of the most recent facilities inspection';
    `);

    for (const p of POINTS) {
        await db.run(`
            INSERT INTO demo_points (id, name, category, rating, capacity, is_accessible, opened_on, last_inspected, geometry)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ST_Point(?, ?))
        `, [p.id, p.name, p.category, p.rating, p.capacity, p.is_accessible, p.opened_on, p.last_inspected, p.lon, p.lat]);
    }

    // --- demo_lines ------------------------------------------------------
    await db.run(`
        CREATE TYPE surface_kind AS ENUM ('asphalt', 'gravel', 'dirt');
        CREATE TABLE demo_lines (
            id INTEGER PRIMARY KEY,
            name VARCHAR,
            surface surface_kind,
            length_m DOUBLE,
            daily_users INTEGER,
            is_paved BOOLEAN,
            maintenance_time TIME,
            segment_code BIGINT,
            geometry GEOMETRY
        );
        COMMENT ON COLUMN demo_lines.surface IS 'Path surface material';
        COMMENT ON COLUMN demo_lines.maintenance_time IS 'Time of day the maintenance crew begins its round';
        COMMENT ON COLUMN demo_lines.segment_code IS 'Externally-assigned segment identifier from the parks-department asset system (may exceed 2^53)';
    `);

    for (const l of LINES) {
        const coordString = l.coords.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
        await db.run(`
            INSERT INTO demo_lines (id, name, surface, length_m, daily_users, is_paved, maintenance_time, segment_code, geometry)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText('LINESTRING(${coordString})'))
        `, [l.id, l.name, l.surface, l.length_m, l.daily_users, l.is_paved, l.maintenance_time, l.segment_code]);
    }

    // --- demo_polygons -----------------------------------------------
    await db.run(`
        CREATE TABLE demo_polygons (
            id INTEGER PRIMARY KEY,
            name VARCHAR,
            zone_type VARCHAR,
            area_ha DECIMAL(10,2),
            max_capacity INTEGER,
            is_protected BOOLEAN,
            parcel_uuid UUID,
            boundary_survey BLOB,
            geometry GEOMETRY
        );
        COMMENT ON COLUMN demo_polygons.zone_type IS 'Meadow, water, or other zone classification';
        COMMENT ON COLUMN demo_polygons.area_ha IS 'Area in hectares';
        COMMENT ON COLUMN demo_polygons.parcel_uuid IS 'Parcel identifier from the city GIS system';
        COMMENT ON COLUMN demo_polygons.boundary_survey IS 'Digitised boundary-survey document checksum (opaque binary)';
    `);

    for (const poly of POLYGONS) {
        const coordString = poly.coords.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
        await db.run(`
            INSERT INTO demo_polygons (id, name, zone_type, area_ha, max_capacity, is_protected, parcel_uuid, boundary_survey, geometry)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::BLOB, ST_GeomFromText('POLYGON((${coordString}))'))
        `, [poly.id, poly.name, poly.zone_type, poly.area_ha, poly.max_capacity, poly.is_protected, poly.parcel_uuid, poly.boundary_survey]);
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
