/** biome-ignore-all assist/source/organizeImports: <explanation> */
import express, { Router } from 'express';
import type { Application } from 'express';
import RootHandler from '@/handlers/root';
import CRUDHandler from '@/handlers/items-curd';
import SchemaHandler from '@/handlers/schema';
import type { BaseProvider } from '@/providers/base-provider';
import nunjucks from 'nunjucks';

import type { OGCFeaturesConfig } from '@/types';
import CollectionHandler from '@/handlers/collections';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

export class OGCAPI {
  router: Router;
  options: OGCFeaturesConfig = {};
  provider: BaseProvider;
  app: Application;

  constructor(provider: BaseProvider, app: Application, options: OGCFeaturesConfig = {}) {
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

    this.provider.setupProviderHooks(this.router);
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

  setViews() {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const viewsDirectory = path.join(__dirname, 'views');
    this.app.set('views', viewsDirectory);

    this.app.set('view engine', 'njk');  // .njk extension for Nunjucks files

    // Configure Nunjucks (with Express integration)
    nunjucks.configure(viewsDirectory, {
      autoescape: true,
      express: this.app,
    });
  }

}

export default OGCAPI;
export { InMemoryProvider } from '@/providers/in-memory-provider';
export { BaseProvider } from '@/providers/base-provider';
export type { OGCFeaturesConfig, Feature } from '@/types';
export { OGCAPIConformanceClass } from '@/types/ogc-confirmance';
export { DuckDBProvider } from '@/providers/duck-db-provider';
export type { DuckDBProviderDef } from '@/providers/duck-db-provider';
