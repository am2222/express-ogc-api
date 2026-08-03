// biome-ignore assist/source/organizeImports: <explanation>
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  OGCAPI,
  InMemoryProvider,
  DuckDBProvider,
  BaseProvider,
  OGCAPIConformanceClass,
} from '../src/index.js';
import type {
  Collection,
  CollectionSchema,
  Feature,
  FeatureCollection,
  ProviderRequest,
  Queryable,
  QueryParams,
  UpdateFeatureParams,
  OGCAPIConformanceItem,
} from '../src/index.js';

/**
 * A minimal concrete `BaseProvider` subclass that declares none of the four
 * capability flags — every one stays at `BaseProvider`'s own default of
 * `false`. This is the behavior this suite pins: under the old
 * prototype-comparison detection (comparing `Object.getPrototypeOf(this)
 * .getSchema` etc. against `BaseProvider.prototype.getSchema`), every one of
 * these flags would have come out `true`, because every method the check
 * inspected is `abstract` and therefore *must* be overridden by any concrete
 * subclass — the check could never observe "not implemented". Only explicit
 * declaration can express "not implemented"; this class demonstrates that,
 * and the tests below assert it end to end (flags, route registration, and
 * the OPTIONS `Allow` header).
 *
 * All the methods below the accessor pair are unreachable in the tests that
 * follow (nothing routes to `getSchema`, `getQueryables`, or the write
 * methods when their flags are false), but TypeScript still requires an
 * implementation because they're abstract on `BaseProvider`.
 */
class MinimalProvider extends BaseProvider {
  private readonly collections: Collection[] = [
    {
      id: 'widgets',
      title: 'Widgets',
      extent: {
        spatial: {
          bbox: [[-180, -90, 180, 90]],
          crs: this.defaultCrs,
        },
      },
    },
  ];

  conformanceClasses(): OGCAPIConformanceItem[] {
    return [
      OGCAPIConformanceClass.COMMON_CORE,
      OGCAPIConformanceClass.COMMON_LANDING_PAGE,
      OGCAPIConformanceClass.FEATURES_CORE,
    ];
  }

  addCollection(_collection: Collection): void {
    // not exercised by this suite
  }

  addFeature(_collectionId: string, _feature: Feature): void {
    // not exercised by this suite
  }

  getCollections(_req: ProviderRequest): Collection[] {
    return this.collections;
  }

  getCollection(_req: ProviderRequest, collectionId: string): Collection | null {
    return this.collections.find((c) => c.id === collectionId) ?? null;
  }

  getFeatures(
    _req: ProviderRequest,
    _collectionId: string,
    _params: QueryParams
  ): FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: [],
      numberMatched: 0,
      numberReturned: 0,
    };
  }

  getFeature(
    _req: ProviderRequest,
    _collectionId: string,
    _featureId: string
  ): Feature | null {
    return null;
  }

  getSchema(_req: ProviderRequest, _collectionId: string): CollectionSchema {
    throw new Error('MinimalProvider does not implement schemas');
  }

  getQueryables(_req: ProviderRequest, _collectionId: string): Queryable {
    throw new Error('MinimalProvider does not implement filtering');
  }

  async createFeature(
    _req: ProviderRequest,
    _collectionId: string,
    _feature: Feature
  ): Promise<Feature | null> {
    throw new Error('MinimalProvider does not implement transactions');
  }

  async replaceFeature(
    _req: ProviderRequest,
    _collectionId: string,
    _featureId: string,
    _feature: Feature
  ): Promise<Feature | null> {
    throw new Error('MinimalProvider does not implement transactions');
  }

  async updateFeature(
    _req: ProviderRequest,
    _collectionId: string,
    _featureId: string,
    _params: UpdateFeatureParams
  ): Promise<Feature | null> {
    throw new Error('MinimalProvider does not implement transactions');
  }

  async deleteFeature(
    _req: ProviderRequest,
    _collectionId: string,
    _featureId: string
  ): Promise<boolean> {
    throw new Error('MinimalProvider does not implement transactions');
  }
}

describe('Provider capability flags are declared, not inferred', () => {
  // Pins the effective capabilities of both bundled providers so a future
  // change to `BaseProvider` (or to either provider) cannot silently drift
  // them. These are the same four values the old prototype-detection
  // happened to produce for both providers today — see the README's
  // "Migrating" section for why that detection was never actually correct.
  it('InMemoryProvider: schemas, filtering and transactions on; CRS off', () => {
    const provider = new InMemoryProvider();
    expect(provider.enableSchemas).toBe(true);
    expect(provider.enableFiltering).toBe(true);
    expect(provider.enableTransactions).toBe(true);
    expect(provider.enableCrs).toBe(false);
  });

  it('DuckDBProvider: schemas, filtering and transactions on; CRS off', () => {
    const provider = new DuckDBProvider({ name: 'DuckDBProvider' });
    expect(provider.enableSchemas).toBe(true);
    expect(provider.enableFiltering).toBe(true);
    expect(provider.enableTransactions).toBe(true);
    expect(provider.enableCrs).toBe(false);
  });

  // The behavior change: a subclass that declares nothing gets `false` for
  // all four. Under the old prototype-comparison detection this would have
  // failed — every flag but `enableCrs` would have come out `true`, because
  // `getSchema`/`getFeatures`/`createFeature`/`updateFeature`/`deleteFeature`
  // are abstract and MinimalProvider is forced by TypeScript to override
  // every one of them.
  it('a minimal subclass that declares nothing defaults every flag to false', () => {
    const provider = new MinimalProvider({ name: 'MinimalProvider' });
    expect(provider.enableSchemas).toBe(false);
    expect(provider.enableFiltering).toBe(false);
    expect(provider.enableTransactions).toBe(false);
    expect(provider.enableCrs).toBe(false);
  });

  describe('route-level consequences for a minimal provider (HTTP)', () => {
    let app: express.Express;
    let server: import('http').Server;
    let baseUrl: string;

    beforeAll(() => {
      app = express();
      const provider = new MinimalProvider({ name: 'MinimalProvider' });
      const ogcAPIRoutes = new OGCAPI(provider, app, {
        basePath: '/ogc',
        title: 'Minimal Provider API',
        description: 'Capability-flag regression coverage',
      });
      app.use('/ogc', ogcAPIRoutes.getRouter());
      server = app.listen(0);
      baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    });

    afterAll(() => {
      server?.close();
    });

    it('still registers the core read routes (sanity check that setup succeeded at all)', async () => {
      const response = await fetch(`${baseUrl}/ogc/collections/widgets/items`);
      expect(response.status).toBe(200);
    });

    it('does not register GET /collections/{id}/schema when enableSchemas is false', async () => {
      const response = await fetch(`${baseUrl}/ogc/collections/widgets/schema`);
      expect(response.status).toBe(404);
    });

    it('does not register GET /collections/{id}/queryables when enableFiltering is false', async () => {
      const response = await fetch(`${baseUrl}/ogc/collections/widgets/queryables`);
      expect(response.status).toBe(404);
    });

    it('OPTIONS Allow header omits write methods when enableTransactions is false', async () => {
      const response = await fetch(`${baseUrl}/ogc`, { method: 'OPTIONS' });
      const allow = response.headers.get('Allow');

      expect(allow).toBe('GET, HEAD, OPTIONS');
      expect(allow).not.toMatch(/POST|PUT|PATCH|DELETE/);
    });

    it('the write endpoints themselves are not registered either (POST is unhandled, not just unadvertised)', async () => {
      const response = await fetch(`${baseUrl}/ogc/collections/widgets/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'Feature', properties: {}, geometry: null }),
      });
      // Express's default behavior for an unregistered method on a path that
      // *does* have other methods registered is 404 (no route matches
      // POST); the crucial assertion is that it is not 200/201.
      expect(response.status).toBe(404);
    });
  });
});
