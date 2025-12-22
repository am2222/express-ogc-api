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
  provider: BaseProvider;
  app: Application;

  constructor(provider: BaseProvider, app:Application, options: OGCFeaturesConfig = {}) {
    this.router = Router();
    this.provider = provider;
    this.options = options;
    this.app = app;

    if (!provider) {
      throw new Error('Provider is required to initialize OGCAPI');
    }

    this.router = Router();
    this.setup();
  }

  setup() {

    if (this.app && !this.app._router?.stack.some((layer: { name: string; }) => layer?.name === 'json')) {
      this.app.use(express.json({ type: ['application/json', 'application/geo+json'] }));
      console.log('Dynamically added JSON body parser to app');
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
export type { OGCFeaturesConfig } from '@/types';
export { OGCAPIConformanceClass } from '@/types/ogc-confirmance';
