import { DuckDBInstance } from '@duckdb/node-api';

const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
await db.run('INSTALL spatial; LOAD spatial;');

await db.run(`
  CREATE TABLE t (
    id INTEGER PRIMARY KEY,
    name VARCHAR,
    ts TIMESTAMP,
    tstz TIMESTAMP WITH TIME ZONE,
    tm TIME,
    dt DATE,
    u UUID,
    b BLOB,
    geom GEOMETRY
  );
  COMMENT ON COLUMN t.name IS 'The name of the thing';
  INSERT INTO t VALUES (1, 'foo', now(), now(), '12:30:45', '2020-01-01', gen_random_uuid(), 'hello'::BLOB, ST_Point(1,2));
`);

const r = await db.runAndReadAll(`SELECT * FROM duckdb_columns() WHERE table_name='t'`);
console.log(JSON.stringify(r.getRowObjectsJS(), (k,v) => typeof v === 'bigint' ? v.toString() : v, 2));

console.log('--- columns of duckdb_columns() ---');
const cols = await db.runAndReadAll(`DESCRIBE SELECT * FROM duckdb_columns()`);
console.log(JSON.stringify(cols.getRowObjectsJS(), null, 2));

console.log('--- geometry type null table ---');
await db.run(`CREATE TABLE empty_geom (id INTEGER, geom GEOMETRY);`);
const g = await db.runAndReadAll(`SELECT DISTINCT ST_GeometryType(geom) as t FROM empty_geom`);
console.log(g.getRowObjectsJS());

console.log('--- mixed geom ---');
await db.run(`CREATE TABLE mixed_geom (id INTEGER, geom GEOMETRY); INSERT INTO mixed_geom VALUES (1, ST_Point(1,2)), (2, ST_GeomFromText('LINESTRING(0 0, 1 1)'));`);
const m = await db.runAndReadAll(`SELECT DISTINCT ST_GeometryType(geom) as t FROM mixed_geom`);
console.log(m.getRowObjectsJS());

console.log('--- row values ---');
const rows = await db.runAndReadAll(`SELECT id, name, ts, tstz, tm, dt, u, b, geom FROM t`);
const objs = rows.getRowObjectsJS();
for (const o of objs) {
  for (const k in o) {
    console.log(k, typeof o[k], o[k] instanceof Date ? 'DATE_OBJ' : '', o[k]);
  }
}
db.disconnectSync();

console.log('--- single type with nulls ---');
await db.run(`CREATE TABLE single_with_null (id INTEGER, geom GEOMETRY); INSERT INTO single_with_null VALUES (1, ST_Point(1,2)), (2, NULL);`);
const s = await db.runAndReadAll(`SELECT DISTINCT ST_GeometryType(geom) as t FROM single_with_null`);
console.log(s.getRowObjectsJS());

console.log('--- all null ---');
await db.run(`CREATE TABLE all_null (id INTEGER, geom GEOMETRY); INSERT INTO all_null VALUES (1, NULL);`);
const an = await db.runAndReadAll(`SELECT DISTINCT ST_GeometryType(geom) as t FROM all_null`);
console.log(an.getRowObjectsJS());

console.log('--- current_schema/current_database duckdb_columns filter ---');
const filt = await db.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = current_schema() AND table_name = 't'`);
console.log(filt.getRowObjectsJS());

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
