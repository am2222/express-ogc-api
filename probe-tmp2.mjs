import { DuckDBInstance } from '@duckdb/node-api';

const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
await db.run('INSTALL spatial; LOAD spatial;');

console.log('--- single type with nulls ---');
await db.run(`CREATE TABLE single_with_null (id INTEGER, geom GEOMETRY); INSERT INTO single_with_null VALUES (1, ST_Point(1,2)), (2, NULL);`);
const s = await db.runAndReadAll(`SELECT DISTINCT ST_GeometryType(geom) as t FROM single_with_null`);
console.log(s.getRowObjectsJS());

console.log('--- all null ---');
await db.run(`CREATE TABLE all_null (id INTEGER, geom GEOMETRY); INSERT INTO all_null VALUES (1, NULL);`);
const an = await db.runAndReadAll(`SELECT DISTINCT ST_GeometryType(geom) as t FROM all_null`);
console.log(an.getRowObjectsJS());

console.log('--- geometry types possible values enumeration ---');
await db.run(`CREATE TABLE geom_variety (id INTEGER, geom GEOMETRY);
INSERT INTO geom_variety VALUES
 (1, ST_Point(0,0)),
 (2, ST_GeomFromText('MULTIPOINT(0 0, 1 1)')),
 (3, ST_GeomFromText('MULTILINESTRING((0 0, 1 1))')),
 (4, ST_GeomFromText('MULTIPOLYGON(((0 0,1 0,1 1,0 0)))')),
 (5, ST_GeomFromText('GEOMETRYCOLLECTION(POINT(0 0))')),
 (6, ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))'));
`);
const gv = await db.runAndReadAll(`SELECT id, ST_GeometryType(geom) as t FROM geom_variety ORDER BY id`);
console.log(gv.getRowObjectsJS());

db.disconnectSync();
