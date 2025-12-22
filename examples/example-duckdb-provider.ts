
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
 * Create a cities collection/table
 */
export async function createCitiesCollection(db: DuckDBConnection): Promise<void> {


    await db.run(`
    CREATE TABLE IF NOT EXISTS cities (
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

    console.log('✓ Created cities collection');
}

/**
 * Create a parks collection/table
 */
export async function createParksCollection(db: DuckDBConnection): Promise<void> {
    await db.run(`
    CREATE TABLE IF NOT EXISTS parks (
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

    console.log('✓ Created parks collection');
}

/**
 * Create a roads collection/table
 */
export async function createRoadsCollection(db: DuckDBConnection): Promise<void> {
    await db.run(`
    CREATE TABLE IF NOT EXISTS roads (
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

    console.log('✓ Created roads collection');
}

/**
 * Insert sample city features
 */
export async function insertCityFeatures(db: DuckDBConnection): Promise<void> {
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
      INSERT INTO cities (id, name, country, population, area_km2, founded_year, is_capital, geometry)
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

    console.log(`✓ Inserted ${cities.length} city features`);
}

/**
 * Insert sample park features
 */
export async function insertParkFeatures(db: DuckDBConnection): Promise<void> {
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
      INSERT INTO parks (id, name, park_type, area_hectares, established_date, visitor_count, has_camping, geometry)
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

    console.log(`✓ Inserted ${parks.length} park features`);
}

/**
 * Insert sample road features
 */
export async function insertRoadFeatures(db: DuckDBConnection): Promise<void> {
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
      INSERT INTO roads (id, name, road_type, length_km, lanes, surface, max_speed, geometry)
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

    console.log(`✓ Inserted ${roads.length} road features`);
}

/**
 * Setup complete database with all collections and features
 */
export async function setupCompleteDatabase(dbPath: string = ':memory:'): Promise<DuckDBInstance> {
    console.log('🚀 Initializing DuckDB database...\n');

    const db = await initializeDuckDB(dbPath);
    const connection = await db.connect();


    await connection.run("INSTALL spatial; LOAD spatial;");

    console.log('📦 Creating collections...');
    await createCitiesCollection(connection);
    await createParksCollection(connection);
    await createRoadsCollection(connection);

    console.log('\n📝 Inserting features...');
    await insertCityFeatures(connection);
    await insertParkFeatures(connection);
    await insertRoadFeatures(connection);

    console.log('\n✅ Database setup complete!');
    console.log('📊 Summary:');

    const citiesCount = await connection.run('SELECT COUNT(*) as count FROM cities');
    const parksCount = await connection.run('SELECT COUNT(*) as count FROM parks');
    const roadsCount = await connection.run('SELECT COUNT(*) as count FROM roads');

    console.log(`   - Cities: ${citiesCount.rowCount}`);
    console.log(`   - Parks: ${parksCount.rowCount}`);
    console.log(`   - Roads: ${roadsCount.rowCount}`);

    return db;
}


const db = await setupCompleteDatabase().catch(console.error);

const app = express();
const port = process.env.PORT || 3001;

// Create an in-memory provider
const duck = new DuckDBProvider({database:db});
await duck.initialize()

// Create OGC API instance
const ogcAPI = new OGCAPI(duck, app, {
    basePath: '/ogc',
    title: 'World Cities OGC API',
    description: 'Example OGC API Features server with in-memory provider',
});

// Mount the OGC API router
app.use('/ogc', ogcAPI.getRouter());
app.use('/', (req, res) => {
    res.send('Welcome to the OGC API Features Example Server! Visit /ogc for the API endpoints.');
});

// Start the server
const server = app.listen(port, () => {
    console.log('🌍 OGC API Features Server Started');
    console.log('================================');
    console.log(`Server running at http://localhost:${port}`);
    console.log('');
    console.log('Available endpoints:');
    console.log(`  Landing Page:  http://localhost:${port}/ogc`);
    console.log(`  Conformance:   http://localhost:${port}/ogc/conformance`);
    console.log(`  Collections:   http://localhost:${port}/ogc/collections`);
    console.log(`  Cities:        http://localhost:${port}/ogc/collections/cities`);
    console.log(`  Features:      http://localhost:${port}/ogc/collections/cities/items`);
    console.log('');
    console.log('Press Ctrl+C to stop the server');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n🛑 SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});