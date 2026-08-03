
import express from 'express';
import { OGCAPI, DuckDBProvider } from '../src/index.ts';
import duckdb, { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';

console.log(duckdb.version());

console.log(duckdb.configurationOptionDescriptions());

/**
 * Initialize DuckDB with spatial extension
 */
export async function initializeDuckDB(dbPath: string = ':memory:'): Promise<DuckDBInstance> {
    const db = await DuckDBInstance.create(dbPath);

    return db;
}

/**
 * Create a cities collection/table for the given tenant prefix.
 * Tenant `db1`'s cities live in table `db1_cities`.
 */
export async function createCitiesCollection(
    db: DuckDBConnection,
    prefix: string
): Promise<void> {
    await db.run(`
    CREATE TABLE IF NOT EXISTS ${prefix}_cities (
      id INTEGER PRIMARY KEY,
      name VARCHAR,
      country VARCHAR,
      population INTEGER,
      area_km2 DOUBLE,
      founded_year INTEGER,
      is_capital BOOLEAN,
      geometry GEOMETRY
    );
  `);

    console.log(`✓ Created ${prefix}_cities`);
}

/**
 * Create a parks collection/table for the given tenant prefix.
 */
export async function createParksCollection(
    db: DuckDBConnection,
    prefix: string
): Promise<void> {
    await db.run(`
    CREATE TABLE IF NOT EXISTS ${prefix}_parks (
      id INTEGER PRIMARY KEY,
      name VARCHAR,
      park_type VARCHAR,
      area_hectares DOUBLE,
      established_date DATE,
      visitor_count INTEGER,
      has_camping BOOLEAN,
      geometry GEOMETRY
    );
  `);

    console.log(`✓ Created ${prefix}_parks`);
}

/**
 * Create a roads collection/table for the given tenant prefix.
 */
export async function createRoadsCollection(
    db: DuckDBConnection,
    prefix: string
): Promise<void> {
    await db.run(`
    CREATE TABLE IF NOT EXISTS ${prefix}_roads (
      id INTEGER PRIMARY KEY,
      name VARCHAR,
      road_type VARCHAR,
      length_km DOUBLE,
      lanes INTEGER,
      surface VARCHAR,
      max_speed INTEGER,
      geometry GEOMETRY
    );
  `);

    console.log(`✓ Created ${prefix}_roads`);
}

/**
 * Insert sample city features into the given tenant's table.
 */
export async function insertCityFeatures(db: DuckDBConnection, prefix: string): Promise<void> {
    const cities = [
        {
            id: 1,
            name: 'New York',
            country: 'USA',
            population: 8336817,
            area_km2: 783.8,
            founded_year: 1624,
            is_capital: false,
            lon: -74.006,
            lat: 40.7128
        },
        {
            id: 2,
            name: 'London',
            country: 'UK',
            population: 8982000,
            area_km2: 1572,
            founded_year: 43,
            is_capital: true,
            lon: -0.1276,
            lat: 51.5074
        },
        {
            id: 3,
            name: 'Tokyo',
            country: 'Japan',
            population: 13960000,
            area_km2: 2194,
            founded_year: 1457,
            is_capital: true,
            lon: 139.6917,
            lat: 35.6895
        },
        {
            id: 4,
            name: 'Paris',
            country: 'France',
            population: 2165423,
            area_km2: 105.4,
            founded_year: 250,
            is_capital: true,
            lon: 2.3522,
            lat: 48.8566
        },
        {
            id: 5,
            name: 'Sydney',
            country: 'Australia',
            population: 5312163,
            area_km2: 12368,
            founded_year: 1788,
            is_capital: false,
            lon: 151.2093,
            lat: -33.8688
        }
    ];

    for (const city of cities) {
        await db.run(`
      INSERT INTO ${prefix}_cities (id, name, country, population, area_km2, founded_year, is_capital, geometry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ST_Point(?, ?))
    `, [
            city.id,
            city.name,
            city.country,
            city.population,
            city.area_km2,
            city.founded_year,
            city.is_capital,
            city.lon,
            city.lat
        ]);
    }

    console.log(`✓ Inserted ${cities.length} city features into ${prefix}_cities`);
}

/**
 * Insert sample park features into the given tenant's table.
 */
export async function insertParkFeatures(db: DuckDBConnection, prefix: string): Promise<void> {
    const parks = [
        {
            id: 1,
            name: 'Central Park',
            park_type: 'Urban Park',
            area_hectares: 341,
            established_date: '1857-07-21',
            visitor_count: 42000000,
            has_camping: false,
            // Simplified polygon for Central Park
            coords: [
                [-73.9812, 40.7681],
                [-73.9581, 40.7681],
                [-73.9581, 40.7649],
                [-73.9812, 40.7649],
                [-73.9812, 40.7681]
            ]
        },
        {
            id: 2,
            name: 'Yellowstone National Park',
            park_type: 'National Park',
            area_hectares: 898317,
            established_date: '1872-03-01',
            visitor_count: 4860000,
            has_camping: true,
            coords: [
                [-111.1, 45.0],
                [-109.8, 45.0],
                [-109.8, 44.1],
                [-111.1, 44.1],
                [-111.1, 45.0]
            ]
        },
        {
            id: 3,
            name: 'Hyde Park',
            park_type: 'Royal Park',
            area_hectares: 142,
            established_date: '1637-01-01',
            visitor_count: 8000000,
            has_camping: false,
            coords: [
                [-0.1719, 51.5074],
                [-0.1625, 51.5074],
                [-0.1625, 51.5020],
                [-0.1719, 51.5020],
                [-0.1719, 51.5074]
            ]
        }
    ];

    for (const park of parks) {
        const coordString = park.coords.map(c => `${c[0]} ${c[1]}`).join(', ');
        await db.run(`
      INSERT INTO ${prefix}_parks (id, name, park_type, area_hectares, established_date, visitor_count, has_camping, geometry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ST_GeomFromText('POLYGON((${coordString}))'))
    `, [
            park.id,
            park.name,
            park.park_type,
            park.area_hectares,
            park.established_date,
            park.visitor_count,
            park.has_camping
        ]);
    }

    console.log(`✓ Inserted ${parks.length} park features into ${prefix}_parks`);
}

/**
 * Insert sample road features into the given tenant's table.
 */
export async function insertRoadFeatures(db: DuckDBConnection, prefix: string): Promise<void> {
    const roads = [
        {
            id: 1,
            name: 'Broadway',
            road_type: 'Avenue',
            length_km: 33,
            lanes: 4,
            surface: 'Asphalt',
            max_speed: 40,
            coords: [
                [-73.9912, 40.7589],
                [-73.9850, 40.7650],
                [-73.9800, 40.7700]
            ]
        },
        {
            id: 2,
            name: 'Route 66',
            road_type: 'Highway',
            length_km: 3940,
            lanes: 2,
            surface: 'Asphalt',
            max_speed: 120,
            coords: [
                [-87.6298, 41.8781],
                [-90.1994, 38.6270],
                [-94.5786, 39.0997],
                [-118.2437, 34.0522]
            ]
        },
        {
            id: 3,
            name: 'Oxford Street',
            road_type: 'Street',
            length_km: 2.4,
            lanes: 4,
            surface: 'Asphalt',
            max_speed: 30,
            coords: [
                [-0.1700, 51.5155],
                [-0.1500, 51.5145],
                [-0.1400, 51.5140]
            ]
        },
        {
            id: 4,
            name: 'Pacific Coast Highway',
            road_type: 'Highway',
            length_km: 1055,
            lanes: 4,
            surface: 'Asphalt',
            max_speed: 105,
            coords: [
                [-117.1611, 32.7157],
                [-118.4912, 34.0195],
                [-119.6982, 34.4208],
                [-121.8863, 36.6002]
            ]
        }
    ];

    for (const road of roads) {
        const coordString = road.coords.map(c => `${c[0]} ${c[1]}`).join(', ');
        await db.run(`
      INSERT INTO ${prefix}_roads (id, name, road_type, length_km, lanes, surface, max_speed, geometry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ST_GeomFromText('LINESTRING(${coordString})'))
    `, [
            road.id,
            road.name,
            road.road_type,
            road.length_km,
            road.lanes,
            road.surface,
            road.max_speed
        ]);
    }

    console.log(`✓ Inserted ${roads.length} road features into ${prefix}_roads`);
}

/**
 * Set up a single in-memory database seeded for two tenants, `db1` and
 * `db2`. Tenants are table-name prefixes, not separate databases: tenant
 * `db1`'s cities live in table `db1_cities`. The application owns connection
 * setup (including loading the `spatial` extension) and hands a live
 * `DuckDBConnection` — not a `DuckDBInstance` — to the request middleware
 * below, because the provider no longer owns a database of its own.
 */
export async function setupDatabase(): Promise<DuckDBConnection> {
    console.log('🚀 Initializing DuckDB database...\n');

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    await connection.run('INSTALL spatial; LOAD spatial;');

    for (const prefix of ['db1', 'db2']) {
        console.log(`📦 Creating collections for tenant "${prefix}"...`);
        await createCitiesCollection(connection, prefix);
        await createParksCollection(connection, prefix);
        await createRoadsCollection(connection, prefix);

        console.log(`📝 Inserting features for tenant "${prefix}"...`);
        await insertCityFeatures(connection, prefix);
        await insertParkFeatures(connection, prefix);
        await insertRoadFeatures(connection, prefix);
    }

    console.log('\n✅ Database setup complete!');

    return connection;
}

const db = await setupDatabase();

const app = express();
const port = process.env.PORT || 3001;

// The set of tenants this deployment knows about. In a real app this might
// come from a config store or a lookup against another database.
const KNOWN_TENANTS = new Set(['db1', 'db2']);

// The provider is constructed with nothing but a name — it holds no
// database, and there is no `initialize()` to call anymore.
const duck = new DuckDBProvider({ name: 'DuckDBProvider' });

// Create OGC API instance. `basePath` is omitted: generated links follow
// the mount path (`req.baseUrl`), which is what makes a parametrized mount
// like `/root/:dbid` work without hardcoding a tenant into the config.
const ogcAPI = new OGCAPI(duck, app, {
    title: 'World Cities OGC API',
    description: 'Example OGC API Features server, one table prefix per tenant',
});

// Plain Express middleware — this is what replaced the old provider hooks.
// It validates the tenant and puts the connection and the key where the
// provider looks for them. The provider never learns your URL structure.
app.use('/root/:dbid', (req, res, next) => {
    if (!KNOWN_TENANTS.has(req.params.dbid)) {
        res.status(404).json({ code: '404', description: `Unknown database ${req.params.dbid}` });
        return;
    }
    res.locals.db = db;
    res.locals.key = req.params.dbid;
    next();
});

// Mount the OGC API router under the parametrized tenant path. Collection
// ids stay unprefixed — `/root/db1/collections/cities` reads the
// `db1_cities` table, so the prefix never appears in a URL.
app.use('/root/:dbid', ogcAPI.getRouter());

app.use('/', (_req, res) => {
    res.send('OGC API Features example. Try /root/db1 or /root/db2.');
});

// Start the server
const server = app.listen(port, () => {
    console.log('🌍 OGC API Features Server Started');
    console.log('================================');
    console.log(`Server running at http://localhost:${port}`);
    console.log('');
    console.log('Available endpoints (tenant db1, same shape for db2):');
    console.log(`  Landing Page:  http://localhost:${port}/root/db1`);
    console.log(`  Conformance:   http://localhost:${port}/root/db1/conformance`);
    console.log(`  Collections:   http://localhost:${port}/root/db1/collections`);
    console.log(`  Cities:        http://localhost:${port}/root/db1/collections/cities`);
    console.log(`  Features:      http://localhost:${port}/root/db1/collections/cities/items`);
    console.log('');
    console.log('Press Ctrl+C to stop the server');
});

// Graceful shutdown — disconnect the single shared connection.
function shutdown(signal: string) {
    console.log(`\n🛑 ${signal} received: closing HTTP server`);
    server.close(() => {
        db.disconnectSync();
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));