import duckdb, { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';

// biome-ignore assist/source/organizeImports: <explanation>
import type {
    Collection,
    Feature,
    FeatureCollection,
    Queryable,
    QueryParams,
    UpdateFeatureParams,
} from '@/types';
import { OGCAPIConformanceItem, OGCAPIConformanceClass } from '@/types/ogc-confirmance';
import { BaseProvider, type ProviderDef } from '@/providers/base-provider';

export interface DuckDBProviderDef extends ProviderDef {
    database: DuckDBInstance; // Path to DuckDB database file or ':memory:'
}

export class DuckDBProvider extends BaseProvider {
    private db: DuckDBInstance | null = null;
    private collections: Map<string, Collection> = new Map();
    private database: DuckDBInstance;
    public override readonly enableSchemas = true;
    public override readonly enableFiltering = true;
    public override readonly enableTransactions = true;
    private connection: DuckDBConnection | null = null;

    constructor(providerDef: DuckDBProviderDef) {
        super(providerDef);
        this.database = providerDef.database;
    }

    async initialize(): Promise<void> {

        this.connection = await this.database.connect();
        await this.connection.run("INSTALL spatial; LOAD spatial;");
        // Discover collections from database tables
        await this.discoverCollections();
    }

    private async discoverCollections(): Promise<void> {
        if (!this.connection) throw new Error('Database not initialized');

        const reader = await this.connection.runAndReadAll(`
            SELECT table_name, table_schema 
            FROM information_schema.tables 
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            `);

        const tables = reader.getRowObjectsJS();

        for (const table of tables) {
            const collection: Collection = {
                id: table['table_name'],
                title: table['table_name'],
                description: `Collection from table ${table['table_name']}`,
                extent: await this.getTableExtent(table['table_name']),
                itemType: 'feature',
                crs: [this.defaultCrs],
            };
            this.collections.set(table['table_name'], collection);
        }
    }

    private async getTableExtent(tableName: string): Promise<any> {
        if (!this.connection) return undefined;

        try {
            // Try to find geometry column
            const geomCol = await this.connection.runAndReadAll(`
        SELECT column_name , data_type
        FROM information_schema.columns 
        WHERE table_name = ?   AND (data_type LIKE '%GEOMETRY%' 
         OR data_type LIKE '%POINT%'
         OR data_type LIKE '%POLYGON%'
         OR data_type LIKE '%LINESTRING%')
        LIMIT 1
      `, [tableName]);

      const results=geomCol.getRowObjectsJS()

            if (results.length > 0) {
                const extent = await this.connection.runAndReadAll(`
          SELECT 
            ST_XMin(ST_Extent(${results[0].column_name})) as minx,
            ST_YMin(ST_Extent(${results[0].column_name})) as miny,
            ST_XMax(ST_Extent(${results[0].column_name})) as maxx,
            ST_YMax(ST_Extent(${results[0].column_name})) as maxy
          FROM ${tableName}
        `);
                const extentRow = extent.getRowObjectsJS()[0];
                
                if (extent) {
                    return {
                        spatial: {
                            bbox: [[extentRow.minx, extentRow.miny, extentRow.maxx, extentRow.maxy]],
                            crs: this.defaultCrs,
                        },
                    };
                }
            }
        } catch (err) {
            console.warn(`Could not determine extent for ${tableName}:`, err);
        }

        return undefined;
    }

    conformanceClasses(): OGCAPIConformanceItem[] {
        return [
            OGCAPIConformanceClass.COMMON_CORE,
            OGCAPIConformanceClass.COMMON_LANDING_PAGE,
            OGCAPIConformanceClass.COMMON_JSON,
            OGCAPIConformanceClass.FEATURES_CORE,
            OGCAPIConformanceClass.FEATURES_GEOJSON,
        ];
    }

    async getCollections(): Promise<Collection[]> {
        return Array.from(this.collections.values());
    }

    async getCollection(collectionId: string): Promise<Collection | null> {
        return this.collections.get(collectionId) || null;
    }

    async getSchema(collectionId: string): Promise<Record<string, unknown>> {
        if (!this.connection) throw new Error('Database not initialized');

        const columns = await this.connection.runAndReadAll(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = ?
    `, [collectionId]);

        const properties: Record<string, any> = {};
        
        const cols = columns.getRowObjectsJS();
        for (const col of cols) {
            properties[col.column_name] = {
                type: this.mapDuckDBTypeToJSON(col.data_type),
            };
        }

        return {
            type: 'object',
            properties,
        };
    }

    private mapDuckDBTypeToJSON(duckdbType: string): string {
        const type = duckdbType.toUpperCase();
        if (type.includes('INT') || type.includes('BIGINT')) return 'integer';
        if (type.includes('DOUBLE') || type.includes('FLOAT') || type.includes('DECIMAL')) return 'number';
        if (type.includes('BOOL')) return 'boolean';
        if (type.includes('GEOMETRY')) return 'object';
        return 'string';
    }

    async getFeatures(
        collectionId: string,
        params: QueryParams
    ): Promise<FeatureCollection> {
        if (!this.connection) throw new Error('Database not initialized');

        const limit = Math.min(params.limit || this.defaultLimit, this.maxLimit);
        const offset = params.offset || 0;

        // Find geometry column
        const geomCol = await this.connection.runAndRead(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = ? AND data_type LIKE '%GEOMETRY%'
      LIMIT 1
    `, [collectionId]);

        let query = `SELECT *, `;

        if (geomCol) {
            query += `ST_AsGeoJSON(${geomCol.column_name}) as __geometry_json `;
        }

        query += `FROM ${collectionId} `;

        // Add bbox filter if provided
        if (params.bbox && geomCol) {
            const [minx, miny, maxx, maxy] = params.bbox;
            query += `WHERE ST_Intersects(${geomCol.column_name}, ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy})) `;
        }

        query += `LIMIT ${limit} OFFSET ${offset}`;

        const rows = await this.connection.runAndReadAll(query);

        const features: Feature[] = rows.map((row: any) => {
            const { __geometry_json, ...properties } = row;

            let geometry = null;
            if (__geometry_json) {
                try {
                    geometry = JSON.parse(__geometry_json);
                } catch (err) {
                    console.warn('Failed to parse geometry:', err);
                }
            }

            return {
                type: 'Feature',
                id: properties.id || properties.fid,
                geometry,
                properties,
            };
        });

        return {
            type: 'FeatureCollection',
            features,
            numberMatched: await this.getFeatureCount(collectionId, params),
            numberReturned: features.length,
        };
    }

    private async getFeatureCount(collectionId: string, params: QueryParams): Promise<number> {
        if (!this.connection) return 0;

        let query = `SELECT COUNT(*) as count FROM ${collectionId}`;

        if (params.bbox) {
            const geomCol = await this.connection.runAndReadAll(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = ? AND data_type LIKE '%GEOMETRY%'
        LIMIT 1
      `, [collectionId]);

            if (geomCol) {
                const [minx, miny, maxx, maxy] = params.bbox;
                query += ` WHERE ST_Intersects(${geomCol.column_name}, ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy}))`;
            }
        }

        const result = await this.connection.runAndReadAll(query);
        return result?.count || 0;
    }

    async getFeature(collectionId: string, featureId: string): Promise<Feature> {
        if (!this.connection) throw new Error('Database not initialized');

        const geomCol = await this.connection.runAndReadAll(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = ? AND data_type LIKE '%GEOMETRY%'
      LIMIT 1
    `, [collectionId]);

        let query = `SELECT *, `;

        if (geomCol) {
            query += `ST_AsGeoJSON(${geomCol.column_name}) as __geometry_json `;
        }

        query += `FROM ${collectionId} WHERE id = ? OR fid = ?`;

        const row = await this.connection.runAndReadAll(query, [featureId, featureId]);

        if (!row) {
            throw new Error(`Feature with ID ${featureId} not found in collection ${collectionId}`);
        }

        const { __geometry_json, ...properties } = row;

        let geometry = null;
        if (__geometry_json) {
            try {
                geometry = JSON.parse(__geometry_json);
            } catch (err) {
                console.warn('Failed to parse geometry:', err);
            }
        }

        return {
            type: 'Feature',
            id: properties.id || properties.fid,
            geometry,
            properties,
        };
    }

    async getQueryables(collectionId: string): Promise<Queryable> {
        const schema = await this.getSchema(collectionId);

        return {
            type: 'object',
            title: `Queryables for ${collectionId}`,
            properties: schema.properties as Record<string, any>,
            $id: `/collections/${collectionId}/queryables`,
            $schema: 'https://json-schema.org/draft/2019-09/schema',
        };
    }

    async createFeature(collectionId: string, feature: Feature): Promise<Feature | null> {
        if (!this.connection) throw new Error('Database not initialized');

        const columns = Object.keys(feature.properties || {});
        const values = Object.values(feature.properties || {});

        const placeholders = columns.map(() => '?').join(', ');
        const columnList = columns.join(', ');

        // Handle geometry if present
        if (feature.geometry) {
            columns.push('geometry');
            values.push(`ST_GeomFromGeoJSON('${JSON.stringify(feature.geometry)}')`);
        }

        const query = `
      INSERT INTO ${collectionId} (${columnList})
      VALUES (${placeholders})
      RETURNING *
    `;

        const result = await this.connection.runAndReadAll(query, values);

        if (result) {
            return await this.getFeature(collectionId, result.id || result.fid);
        }

        return null;
    }

    async replaceFeature(
        collectionId: string,
        featureId: string,
        feature: Feature
    ): Promise<Feature | null> {
        if (!this.connection) throw new Error('Database not initialized');

        const columns = Object.keys(feature.properties || {});
        const values = Object.values(feature.properties || {});

        const setClause = columns.map(col => `${col} = ?`).join(', ');

        const query = `
      UPDATE ${collectionId}
      SET ${setClause}
      WHERE id = ? OR fid = ?
    `;

        await this.connection.run(query, [...values, featureId, featureId]);

        return await this.getFeature(collectionId, featureId);
    }

    async updateFeature(
        collectionId: string,
        featureId: string,
        params: UpdateFeatureParams
    ): Promise<Feature | null> {
        if (!this.connection) throw new Error('Database not initialized');

        const updates = params.properties || {};
        const columns = Object.keys(updates);
        const values = Object.values(updates);

        const setClause = columns.map(col => `${col} = ?`).join(', ');

        const query = `
      UPDATE ${collectionId}
      SET ${setClause}
      WHERE id = ? OR fid = ?
    `;

        await this.connection.run(query, [...values, featureId, featureId]);

        return await this.getFeature(collectionId, featureId);
    }

    async deleteFeature(collectionId: string, featureId: string): Promise<boolean> {
        if (!this.connection) throw new Error('Database not initialized');

        const query = `DELETE FROM ${collectionId} WHERE id = ? OR fid = ?`;
        const result = await this.connection.run(query, [featureId, featureId]);

        return (result?.changes || 0) > 0;
    }

    addCollection(collection: Collection): void {
        this.collections.set(collection.id, collection);
    }

    addFeature(_collectionId: string, _feature: Feature): void {
        // This would require creating the table structure dynamically
        throw new Error('addFeature not implemented for DuckDB provider');
    }

    async close(): Promise<void> {
        if (this.connection) {
            await this.connection.close();
            this.connection = null;
        }
    }
}