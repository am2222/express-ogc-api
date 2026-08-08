/**
 * Serves a DuckLake catalog as a read/write OGC API - Features endpoint,
 * scoped to one `{company}_{user}_{project}` tenant per request.
 *
 * Run:
 *   npx tsx examples/serve-ducklake.ts
 *
 * Reads from `.env` in the repo root:
 *   DATALAKE_POSTGRES_CONNECTION_STRING = <postgres connstr for the catalog>
 *   DATALAKE_S3_PATH                    = s3://bucket/
 *   DATALAKE_CATALOG                    = <name, used only as the ATTACH alias>
 *
 * Then, with a tenant triple in the path:
 *   curl localhost:3006/xcompany/xuser/xproject/collections
 *   curl localhost:3006/xcompany/xuser/xproject/collections/chambers/items?limit=2
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { OGCAPI, DuckLakeProvider, attachDuckLake, refreshS3Secret } from '../src/index.ts';

/**
 * Hand-rolled `.env` reader: the file uses `KEY = value` with spaces around
 * the separator, and the Postgres connection string contains `=` signs of its
 * own, so only the first `=` may be treated as the separator.
 */
function readEnvFile(path: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i === -1) continue;
        env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return env;
}

/**
 * Resolve S3 credentials. DuckDB's own `PROVIDER credential_chain` was
 * observed to fail with `InvalidToken` against S3 when the ambient
 * credentials come from an AWS SSO session, so the explicit triple is
 * resolved out here and handed to DuckDB instead: standard env vars first,
 * then the AWS CLI (which understands the SSO cache).
 */
function resolveS3Credentials(region: string) {
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        return {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.AWS_SESSION_TOKEN,
            region,
        };
    }
    const creds = JSON.parse(
        execFileSync('aws', ['configure', 'export-credentials', '--format', 'process'], {
            encoding: 'utf8',
        })
    );
    return {
        accessKeyId: creds.AccessKeyId as string,
        secretAccessKey: creds.SecretAccessKey as string,
        sessionToken: creds.SessionToken as string | undefined,
        region,
    };
}

const env = readEnvFile(new URL('../.env', import.meta.url).pathname);
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const ALIAS = 'lake';

const app = express();

// One instance for the process. DuckDB's ATTACH is instance-wide, so the lake
// is attached once on a setup connection and every per-request connection
// inherits it — no Postgres handshake or S3 secret per request.
const instance = await DuckDBInstance.create(':memory:');
const setup = await instance.connect();
await attachDuckLake(setup, {
    catalogConnectionString: env.DATALAKE_POSTGRES_CONNECTION_STRING!,
    dataPath: env.DATALAKE_S3_PATH!,
    alias: ALIAS,
    s3: resolveS3Credentials(REGION),
});
console.log(`✓ attached ${env.DATALAKE_CATALOG} as ${ALIAS} (${env.DATALAKE_S3_PATH})`);

/**
 * Short-lived SSO/STS credentials expire while the process runs, and an
 * expired secret only surfaces on the first S3 read (ATTACH touches Postgres
 * only). Re-register periodically so long-running servers keep working.
 */
setInterval(
    () => {
        refreshS3Secret(setup, resolveS3Credentials(REGION)).catch((err) =>
            console.warn('S3 credential refresh failed:', err)
        );
    },
    30 * 60 * 1000
).unref();

/**
 * Per-request connection, pointed at the lake, plus the tenant triple taken
 * from the URL path. `USE <alias>.main` is what scopes the provider's
 * metadata lookups to the lake catalog.
 */
async function withLakeConnection(req: Request, res: Response, next: NextFunction) {
    let conn: DuckDBConnection | undefined;
    try {
        conn = await instance.connect();
        await conn.run('LOAD spatial;');
        await conn.run(`USE ${ALIAS}.main`);

        res.locals.db = conn;
        res.locals.tenant = {
            company: req.params.company,
            user: req.params.user,
            project: req.params.project,
        };

        res.on('finish', () => conn?.disconnectSync());
        next();
    } catch (err) {
        conn?.disconnectSync();
        next(err);
    }
}

const provider = new DuckLakeProvider({
    name: env.DATALAKE_CATALOG ?? 'ducklake',
    // The lake records no CRS (DuckLake flattens GEOMETRY('EPSG:...') and drops
    // ST_SetCRS), so declare it here or per column with
    // `COMMENT ON COLUMN <table>.geometry IS 'EPSG:25832'`.
    defaultStorageCrs: process.env.DATALAKE_STORAGE_CRS,
});

const ogc = new OGCAPI(provider, app, {
    title: 'DuckLake OGC API - Features',
    description: 'Read/write access to a DuckLake catalog, scoped per project',
});

app.use('/:company/:user/:project', withLakeConnection, ogc.getRouter());

const port = Number(process.env.PORT ?? 3006);
app.listen(port, () => {
    console.log(`\nListening on http://localhost:${port}`);
    console.log(`Try: curl http://localhost:${port}/xcompany/xuser/xproject/collections`);
});
