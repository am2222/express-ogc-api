/**
 * CRS helpers shared by `DuckDBProvider` and `DuckLakeProvider`.
 *
 * Kept in its own module so the base provider can use them without importing
 * from its own subclass.
 */

/**
 * Read the CRS out of a rendered geometry type name — `GEOMETRY('EPSG:32632')`
 * -> `EPSG:32632`.
 *
 * As of the spatial extension shipped with DuckDB 1.5, `GEOMETRY` is a
 * parameterized type, so a CRS-carrying column reports its type this way. The
 * same rendering appears in `duckdb_columns().data_type`, in `typeof(geom)`,
 * and in `DESCRIBE` output — including `DESCRIBE` over `read_parquet(...)`,
 * which is how a CRS is recovered from a file whose catalog entry has lost it.
 *
 * Returns `undefined` for a bare `GEOMETRY`. That means the type does not say
 * what the CRS is — not that the data is unprojected.
 */
export function crsFromGeometryTypeName(typeName: string): string | undefined {
    const match = /^GEOMETRY\(\s*'(.+)'\s*\)$/i.exec(typeName.trim());
    return match ? match[1] : undefined;
}

/**
 * Render a CRS identifier as an OGC CRS URI, the form OGC API - Features uses
 * in `crs`/`storageCrs`. Accepts `EPSG:25832`, a bare numeric code, `CRS84`,
 * or an existing URI (passed through unchanged). Returns `undefined` for
 * anything it does not recognise, so an unrelated column comment is never
 * mistaken for a CRS declaration.
 */
export function normalizeCrs(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    const epsg = /^(?:EPSG:)?(\d{4,6})$/i.exec(trimmed);
    if (epsg) {
        return `http://www.opengis.net/def/crs/EPSG/0/${epsg[1]}`;
    }
    if (/^(?:OGC:)?CRS84$/i.test(trimmed)) {
        return 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
    }
    return undefined;
}
