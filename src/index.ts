/** biome-ignore-all assist/source/organizeImports: <explanation> */
import express, { Router } from 'express';
import type { Application } from 'express';
import RootHandler from '@/handlers/root';
import CRUDHandler from '@/handlers/items-curd';
import SchemaHandler from '@/handlers/schema';
import type { BaseProvider } from '@/providers/base-provider';

import type { OGCFeaturesConfig } from '@/types';
import CollectionHandler from '@/handlers/collections';

export class OGCAPI {
  router: Router;
  options: OGCFeaturesConfig = {};
  provider: BaseProvider<any, any>;
  app: Application;

  constructor(provider: BaseProvider<any, any>, app: Application, options: OGCFeaturesConfig = {}) {
    this.provider = provider;
    this.options = options;
    this.app = app;

    if (!provider) {
      throw new Error('Provider is required to initialize OGCAPI');
    }

    this.router = Router({ mergeParams: true });
    this.setup();
  }

  private hasJsonParser(): boolean {
    // Express 5 exposes `app.router`; Express 4 exposes the private `_router`,
    // which is undefined until the first middleware is registered.
    let router: any;
    try {
      router = (this.app as any).router;
    } catch {
      // Express 4 throws when accessing .router; fall back to _router
      router = (this.app as any)._router;
    }
    if (!router) {
      router = (this.app as any)._router;
    }
    if (!router?.stack) {
      return false;
    }
    return router.stack.some(
      (layer: { name?: string }) => layer?.name === 'jsonParser'
    );
  }

  setup() {
    if (this.app && !this.hasJsonParser()) {
      this.app.use(
        express.json({ type: ['application/json', 'application/geo+json'] })
      );
    }

    const root = new RootHandler(this.provider, this.options);

    if (!root.isProviderConformed()) {
      throw new Error(
        'Provider does not conform to required core classes for RootHandler'
      );
    }
    root.setupRoutes(this.router);

    const collectionHandler = new CollectionHandler(
      this.provider,
      this.options
    );

    if (collectionHandler.isProviderConformed()) {
      collectionHandler.setupRoutes(this.router);
    }

    const schemaHandler = new SchemaHandler(this.provider, this.options);

    if (schemaHandler.isProviderConformed()) {
      schemaHandler.setupRoutes(this.router);
    }
    const crudHandler = new CRUDHandler(this.provider, this.options);

    if (crudHandler.isProviderConformed()) {
      crudHandler.setupRoutes(this.router);
    }
  }

  getRouter() {
    return this.router;
  }

}

export default OGCAPI;
export { InMemoryProvider } from '@/providers/in-memory-provider';
export { BaseProvider } from '@/providers/base-provider';
export type { OGCFeaturesConfig, Feature, ProviderRequest, QueryParams, Collection, FeatureCollection, Queryable, UpdateFeatureParams } from '@/types';
export { OGCAPIConformanceClass } from '@/types/ogc-confirmance';
export type { OGCAPIConformanceItem } from '@/types/ogc-confirmance';
export { DuckDBProvider } from '@/providers/duck-db-provider';
export type { DuckDBProviderDef, DuckDBLocals } from '@/providers/duck-db-provider';

export { FeatureValidationError } from '@/errors';
export type { FeatureValidationErrorStatus, FeatureValidationErrorOptions } from '@/errors';

// CQL2 -> SQL translation. Usable standalone, with any provider.
export { Cql2ToSql, duckdbPatches, SUPPORTED_OPS, Cql2Error } from '@/cql2';
export type {
  Cql2ToSqlOptions,
  Cql2ErrorCode,
  FilterLang,
  Sql,
  SqlPatch,
} from '@/cql2';
