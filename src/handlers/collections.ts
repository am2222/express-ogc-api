
import { BaseHandler } from '@/handlers/base-handler';
import { OGCAPIConformanceClass } from '@/types/ogc-confirmance';

import type { Collections, LandingPage, Link, OGCFeaturesConfig } from "@/types";
import type { NextFunction, Request, Response, Router } from "express";

export class CollectionHandler extends BaseHandler {
    requiredCoreClasses = [
        OGCAPIConformanceClass.COMMON_CORE,
        OGCAPIConformanceClass.COMMON_LANDING_PAGE,
        OGCAPIConformanceClass.FEATURES_CORE
    ];


    private async handleCollections(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const collections = await this.provider.getCollections();

            const response: Collections = {
                links: [
                    {
                        href: this.buildUrl(req, '/collections'),
                        rel: 'self',
                        type: 'application/json',
                        title: 'This document'
                    }
                ],
                collections: collections.map(c => {
                    const links: Link[] = [
                        {
                            href: this.buildUrl(req, `/collections/${c.id}`),
                            rel: 'self',
                            type: 'application/json',
                            title: c.title || c.id
                        },
                        {
                            href: this.buildUrl(req, `/collections/${c.id}/items`),
                            rel: 'items',
                            type: 'application/geo+json',
                            title: 'Items'
                        }
                    ];

                    if (this.provider.enableFiltering) {
                        links.push({
                            href: this.buildUrl(req, `/collections/${c.id}/queryables`),
                            rel: 'http://www.opengis.net/def/rel/ogc/1.0/queryables',
                            type: 'application/schema+json',
                            title: 'Queryables'
                        });
                    }

                    if (this.provider.enableSchemas) {
                        links.push({
                            href: this.buildUrl(req, `/collections/${c.id}/schema`),
                            rel: 'http://www.opengis.net/def/rel/ogc/1.0/schema',
                            type: 'application/schema+json',
                            title: 'Schema'
                        });
                    }

                    return {
                        ...c,
                        links: [...links, ...(c.links || [])],
                        crs: this.provider.enableCrs ? (c.crs || this.provider.supportedCrs) : undefined,
                        storageCrs: this.provider.enableCrs ? c.storageCrs : undefined
                    };
                })
            };

            res.json(response);
        } catch (err) {
            next(err);
        }
    }

    private async handleCollection(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId } = req.params;
            const collection = await this.provider.getCollection(collectionId);

            if (!collection) {
                this.sendError(res, 404, 'Collection not found');
                return;
            }

            const links: Link[] = [
                {
                    href: this.buildUrl(req, `/collections/${collectionId}`),
                    rel: 'self',
                    type: 'application/json',
                    title: collection.title || collectionId
                },
                {
                    href: this.buildUrl(req, `/collections/${collectionId}/items`),
                    rel: 'items',
                    type: 'application/geo+json',
                    title: 'Items'
                }
            ];

            if (this.provider.enableFiltering) {
                links.push({
                    href: this.buildUrl(req, `/collections/${collectionId}/queryables`),
                    rel: 'http://www.opengis.net/def/rel/ogc/1.0/queryables',
                    type: 'application/schema+json',
                    title: 'Queryables'
                });
            }

            if (this.provider.enableSchemas) {
                links.push({
                    href: this.buildUrl(req, `/collections/${collectionId}/schema`),
                    rel: 'http://www.opengis.net/def/rel/ogc/1.0/schema',
                    type: 'application/schema+json',
                    title: 'Schema'
                });
            }

            const response = {
                ...collection,
                links: [...links, ...(collection.links || [])],
                crs: this.provider.enableCrs ? (collection.crs || this.provider.supportedCrs) : undefined,
                storageCrs: this.provider.enableCrs ? collection.storageCrs : undefined
            };

            res.json(response);
        } catch (err) {
            next(err);
        }
    }


    setupRoutes(router: Router) {
        router.get('/collections', this.handleCollections.bind(this));
        router.get('/collections/:collectionId', this.handleCollection.bind(this));
    }
}

export default CollectionHandler;