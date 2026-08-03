import { BaseHandler } from '@/handlers/base-handler';
import { OGCAPIConformanceClass } from '@/types/ogc-confirmance';

import type { FeatureCollection, Link, ProviderRequest, QueryParams } from '@/types';
import type { NextFunction, Request, Response, Router } from 'express';

export class ItemsCURDHandler extends BaseHandler {
  requiredCoreClasses = [
    OGCAPIConformanceClass.COMMON_CORE,
    OGCAPIConformanceClass.COMMON_LANDING_PAGE,
    OGCAPIConformanceClass.FEATURES_CORE,
  ];

  private parseQueryParams(req: Request): QueryParams {
    const params: QueryParams = {};

    // Limit
    if (req.query.limit) {
      params.limit = Math.min(
        parseInt(req.query.limit as string, 10) || this.provider.defaultLimit,
        this.provider.maxLimit
      );
    } else {
      params.limit = this.provider.defaultLimit;
    }

    // Offset
    if (req.query.offset) {
      params.offset =
        parseInt(req.query.offset as string, this.provider.defaultOffset) || 0;
    }

    // Bounding box (Part 1)
    if (req.query.bbox) {
      const bbox = (req.query.bbox as string).split(',').map(Number);
      if (bbox.length === 4 || bbox.length === 6) {
        params.bbox =
          bbox.length === 4
            ? (bbox as [number, number, number, number])
            : (bbox as [number, number, number, number, number, number]);
      }
    }

    // Part 2: CRS support
    if (this.provider.enableCrs) {
      if (req.query['bbox-crs']) {
        params.bboxCrs = req.query['bbox-crs'] as string;
      }
      if (req.query.crs) {
        params.crs = req.query.crs as string;
      }
    }

    // Datetime (Part 1)
    if (req.query.datetime) {
      params.datetime = req.query.datetime as string;
    }

    // Part 3: Filtering
    if (this.provider.enableFiltering) {
      if (req.query.filter) {
        params.filter = req.query.filter as string;
        params.filterLang = (req.query['filter-lang'] as any) || 'cql2-text';
      }
      if (req.query['filter-crs']) {
        params.filterCrs = req.query['filter-crs'] as string;
      }
    }

    // Part 6: Property Selection
    if (req.query.properties) {
      params.properties = (req.query.properties as string).split(',');
    }

    // Part 7: Geometry Simplification
    if (req.query['skip-geometry']) {
      params.skipGeometry = req.query['skip-geometry'] === 'true';
    }
    if (req.query['max-allawable-offset']) {
      params.maxAllowableOffset = parseFloat(
        req.query['max-allawable-offset'] as string
      );
    }

    // Part 8: Sorting
    if (req.query.sortby) {
      params.sortby = req.query.sortby as string;
    }

    return params;
  }

  private async handleFeatures(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId } = req.params;
      const params = this.parseQueryParams(req);

      const featureCollection = await this.provider.getFeatures(
        req as ProviderRequest,
        collectionId,
        params
      );

      const offset = params.offset || 0;
      const limit = params.limit || this.provider.defaultLimit;
      const currentQuery = req.query;
      const selfUrl = this.buildUrl(
        req,
        `/collections/${collectionId}/items`,
        true,
        currentQuery
      );

      const links: Link[] = [
        {
          href: selfUrl,
          rel: 'self',
          type: 'application/geo+json',
          title: 'This document',
        },
      ];

      // Add next link if there are more features
      if (
        featureCollection.numberMatched &&
        offset + limit < featureCollection.numberMatched
      ) {
        const nextQuery = { ...req.query, offset: (offset + limit).toString() };
        const nextHref = this.buildUrl(
          req,
          `/collections/${collectionId}/items`,
          true,
          nextQuery
        );

        links.push({
          href: nextHref,
          rel: 'next',
          type: 'application/geo+json',
          title: 'Next page',
        });
      }

      // Add prev link if not on first page
      if (offset > 0) {
        const prevOffset = Math.max(0, offset - limit);
        const prevQuery = { ...req.query, offset: prevOffset.toString() };
        const prevHref = this.buildUrl(
          req,
          `/collections/${collectionId}/items`,
          true,
          prevQuery
        );
        links.push({
          href: prevHref,
          rel: 'prev',
          type: 'application/geo+json',
          title: 'Previous page',
        });
      }

      const response: FeatureCollection = {
        ...featureCollection,
        links,
        timeStamp: new Date().toISOString(),
      };

      res.json(response);
    } catch (err) {
      next(err);
    }
  }

  private async handleFeature(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId, featureId } = req.params;
      const collection = await this.provider.getCollection(
        req as ProviderRequest,
        collectionId
      );

      if (!collection) {
        this.sendError(res, 404, 'Collection not found');
        return;
      }

      const feature = await this.provider.getFeature(
        req as ProviderRequest,
        collectionId,
        featureId
      );

      if (!feature) {
        this.sendError(res, 404, 'Feature not found');
        return;
      }

      res.json(feature);
    } catch (err) {
      next(err);
    }
  }

  // Part 3: Filtering endpoints
  private async handleQueryables(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId } = req.params;
      const collection = await this.provider.getCollection(
        req as ProviderRequest,
        collectionId
      );
      if (!collection) {
        this.sendError(res, 404, 'Collection not found');
        return;
      }
      const queryables = await this.provider.getQueryables(
        req as ProviderRequest,
        collectionId
      );
      res.json(queryables);
    } catch (err) {
      next(err);
    }
  }

  // Part 4: CRUD operations
  private async handleCreateFeature(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId } = req.params;
      const collection = await this.provider.getCollection(
        req as ProviderRequest,
        collectionId
      );
      if (!collection) {
        this.sendError(res, 404, 'Collection not found');
        return;
      }
      const feature = req.body;

      const created = await this.provider.createFeature(
        req as ProviderRequest,
        collectionId,
        feature
      );

      if (!created) {
        this.sendError(res, 500, 'Failed to create feature');
        return;
      }

      res
        .status(201)
        .location(
          this.buildUrl(req, `/collections/${collectionId}/items/${created.id}`)
        )
        .json(created);
    } catch (err) {
      next(err);
    }
  }

  private async handleReplaceFeature(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId, featureId } = req.params;
      const feature = req.body;

      const replaced = await this.provider.replaceFeature(
        req as ProviderRequest,
        collectionId,
        featureId,
        feature
      );

      if (!replaced) {
        this.sendError(res, 404, 'Feature not found');
        return;
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  private async handleUpdateFeature(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId, featureId } = req.params;
      const updates = req.body;

      const updated = await this.provider.updateFeature(
        req as ProviderRequest,
        collectionId,
        featureId,
        { feature: updates }
      );

      if (!updated) {
        this.sendError(res, 404, 'Feature not found');
        return;
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  private async handleDeleteFeature(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId, featureId } = req.params;

      const deleted = await this.provider.deleteFeature(
        req as ProviderRequest,
        collectionId,
        featureId
      );

      if (!deleted) {
        this.sendError(res, 404, 'Feature not found');
        return;
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }


  setupRoutes(router: Router) {
    // Features - GET
    router.get(
      '/collections/:collectionId/items',
      this.handleFeatures.bind(this)
    );
    router.get(
      '/collections/:collectionId/items/:featureId',
      this.handleFeature.bind(this)
    );

    // Part 3: Filtering - Queryables
    if (this.provider.enableFiltering) {
      router.get(
        '/collections/:collectionId/queryables',
        this.handleQueryables.bind(this)
      );
      // router.get('/functions', this.handleFunctions.bind(this));
    }

    // Part 4: CRUD operations
    if (this.provider.enableTransactions) {
      router.post(
        '/collections/:collectionId/items',
        this.handleCreateFeature.bind(this)
      );
      router.put(
        '/collections/:collectionId/items/:featureId',
        this.handleReplaceFeature.bind(this)
      );
      router.patch(
        '/collections/:collectionId/items/:featureId',
        this.handleUpdateFeature.bind(this)
      );
      router.delete(
        '/collections/:collectionId/items/:featureId',
        this.handleDeleteFeature.bind(this)
      );

    }
  }
}

export default ItemsCURDHandler;
