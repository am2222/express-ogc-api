import { BaseHandler } from '@/handlers/base-handler';
import { OGCAPIConformanceClass } from '@/types/ogc-confirmance';

import type { LandingPage, Link, OGCFeaturesConfig } from '@/types';
import type BaseProvider from '@/providers/base-provider';
import type { NextFunction, Request, Response, Router } from 'express';

export class RootHandler extends BaseHandler {
  requiredCoreClasses = [
    OGCAPIConformanceClass.COMMON_CORE,
    OGCAPIConformanceClass.COMMON_LANDING_PAGE,
  ];
  title: string = 'OGC API Features';
  description: string = 'OGC API Features Landing Page';

  constructor(provider: BaseProvider, options: OGCFeaturesConfig = {}) {
    super(provider, options);
    if (options.title) {
      this.title = options.title;
    }
    if (options.description) {
      this.description = options.description;
    }
  }

  private handleLandingPage(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    try {
      const links: Link[] = [
        {
          href: this.buildUrl(req, '/'),
          rel: 'self',
          type: 'application/json',
          title: 'This document',
        },
        {
          href: this.buildUrl(req, '/conformance'),
          rel: 'conformance',
          type: 'application/json',
          title: 'Conformance declaration',
        },
        {
          href: this.buildUrl(req, '/collections'),
          rel: 'data',
          type: 'application/json',
          title: 'Collections',
        },
        {
          href: this.buildUrl(req, '/api'),
          rel: 'service-desc',
          type: 'application/vnd.oai.openapi+json;version=3.0',
          title: 'API definition'
        },
        {
          href: 'https://docs.ogc.org/is/17-069r4/17-069r4.html',
          rel: 'service-doc',
          type: 'text/html',
          title: 'API documentation',
        },
      ];

      const landingPage: LandingPage = {
        title: this.title,
        description: this.description,
        links,
      };

      res.status(200).json(landingPage);
    } catch (error) {
      next(error);
    }
  }

  private handleConformance(
    _req: Request,
    res: Response,
    next: NextFunction
  ): void {
    try {
      const conformance = {
        conformsTo: this.provider?.conformanceClasses() || [],
      };
      res.status(200).json(conformance);
    } catch (error) {
      next(error);
    }
  }

  private handleOptionsRequests(_req: Request, res: Response): void {
    // OGC API Part 4 compliance: Return 200 OK with Allow header listing supported methods
    res.status(200);
    const allowMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (this.provider.enableTransactions) {
      allowMethods.push('POST', 'PUT', 'PATCH', 'DELETE');
    }
    res.set('Allow', allowMethods.join(', '));
    res.send();
  }
  
  private generateOpenAPISpec(req: Request): any {
    return {
      openapi: '3.0.0',
      info: {
        title: this.title,
        version: '1.0.0',
        description: this.description,
        contact: {
          name: 'API Support'
        }
      },
      servers: [
        {
          url: this.resolvePrefix(req) || '/',
          description: 'OGC API - Features Server'
        }
      ],
      paths: {
        '/': {
          get: {
            tags: ['Capabilities'],
            summary: 'Landing page',
            description: 'The landing page provides links to the API definition, conformance statements, and collections.',
            responses: {
              '200': {
                description: 'Links to the API capabilities',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/LandingPage' }
                  }
                }
              }
            }
          }
        },
        '/conformance': {
          get: {
            tags: ['Capabilities'],
            summary: 'Conformance declaration',
            description: 'Lists the conformance classes implemented by this API',
            responses: {
              '200': {
                description: 'Conformance declaration',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Conformance' }
                  }
                }
              }
            }
          }
        },
        '/collections': {
          get: {
            tags: ['Capabilities'],
            summary: 'List collections',
            description: 'Lists all available feature collections',
            responses: {
              '200': {
                description: 'List of collections',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Collections' }
                  }
                }
              }
            }
          }
        },
        '/collections/{collectionId}': {
          get: {
            tags: ['Capabilities'],
            summary: 'Collection metadata',
            description: 'Metadata about a specific collection',
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description: 'Collection identifier'
              }
            ],
            responses: {
              '200': {
                description: 'Collection metadata',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Collection' }
                  }
                }
              },
              '404': {
                description: 'Collection not found'
              }
            }
          }
        },
        '/collections/{collectionId}/items': {
          get: {
            tags: ['Data'],
            summary: 'Get features',
            description: 'Fetch features from a collection',
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description: 'Collection identifier'
              },
              {
                name: 'limit',
                in: 'query',
                schema: { type: 'integer', minimum: 1, maximum: this.provider.maxLimit, default: this.provider.defaultLimit },
                description: 'Maximum number of features to return'
              },
              {
                name: 'offset',
                in: 'query',
                schema: { type: 'integer', minimum: 0, default: 0 },
                description: 'Number of features to skip'
              },
              {
                name: 'bbox',
                in: 'query',
                schema: { type: 'string' },
                description: 'Bounding box (minX,minY,maxX,maxY)',
                example: '-180,-90,180,90'
              },
              {
                name: 'datetime',
                in: 'query',
                schema: { type: 'string' },
                description: 'Temporal filter (RFC 3339)',
                example: '2023-01-01T00:00:00Z/..'
              }
            ],
            responses: {
              '200': {
                description: 'GeoJSON FeatureCollection',
                content: {
                  'application/geo+json': {
                    schema: { $ref: '#/components/schemas/FeatureCollection' }
                  }
                }
              }
            }
          }
        },
        '/collections/{collectionId}/items/{featureId}': {
          get: {
            tags: ['Data'],
            summary: 'Get a feature',
            description: 'Fetch a single feature by ID',
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' }
              },
              {
                name: 'featureId',
                in: 'path',
                required: true,
                schema: { type: 'string' }
              }
            ],
            responses: {
              '200': {
                description: 'GeoJSON Feature',
                content: {
                  'application/geo+json': {
                    schema: { $ref: '#/components/schemas/Feature' }
                  }
                }
              },
              '404': {
                description: 'Feature not found'
              }
            }
          }
        }
      },
      components: {
        schemas: {
          LandingPage: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              links: {
                type: 'array',
                items: { $ref: '#/components/schemas/Link' }
              }
            }
          },
          Conformance: {
            type: 'object',
            properties: {
              conformsTo: {
                type: 'array',
                items: { type: 'string' }
              }
            }
          },
          Collections: {
            type: 'object',
            properties: {
              links: {
                type: 'array',
                items: { $ref: '#/components/schemas/Link' }
              },
              collections: {
                type: 'array',
                items: { $ref: '#/components/schemas/Collection' }
              }
            }
          },
          Collection: {
            type: 'object',
            required: ['id', 'links'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              links: {
                type: 'array',
                items: { $ref: '#/components/schemas/Link' }
              },
              extent: {
                type: 'object',
                properties: {
                  spatial: {
                    type: 'object',
                    properties: {
                      bbox: {
                        type: 'array',
                        items: {
                          type: 'array',
                          minItems: 4,
                          maxItems: 6,
                          items: { type: 'number' }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          FeatureCollection: {
            type: 'object',
            required: ['type', 'features'],
            properties: {
              type: { type: 'string', enum: ['FeatureCollection'] },
              features: {
                type: 'array',
                items: { $ref: '#/components/schemas/Feature' }
              },
              links: {
                type: 'array',
                items: { $ref: '#/components/schemas/Link' }
              },
              numberMatched: { type: 'integer' },
              numberReturned: { type: 'integer' },
              timeStamp: { type: 'string', format: 'date-time' }
            }
          },
          Feature: {
            type: 'object',
            required: ['type', 'geometry', 'properties'],
            properties: {
              type: { type: 'string', enum: ['Feature'] },
              id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              geometry: { type: 'object' },
              properties: { type: 'object' }
            }
          },
          Link: {
            type: 'object',
            required: ['href', 'rel'],
            properties: {
              href: { type: 'string', format: 'uri' },
              rel: { type: 'string' },
              type: { type: 'string' },
              title: { type: 'string' }
            }
          }
        }
      }
    };
  }
  setupRoutes(router: Router) {
    // Landing page
    router.get('/', this.handleLandingPage.bind(this));

    // Conformance
    router.get('/conformance', this.handleConformance.bind(this));
    // OPTIONS for root
    // A bare '*' string is rejected by path-to-regexp v8 (Express 5) at route
    // registration time — i.e. inside the OGCAPI constructor. A RegExp is
    // accepted by both path-to-regexp v6 (Express 4) and v8 (Express 5).
    router.options(/.*/, this.handleOptionsRequests.bind(this));

    // Serve OpenAPI JSON, rebuilt per request so it reflects the mount path
    router.get('/api', (req, res) => {
      res.json(this.generateOpenAPISpec(req));
    });
  }
}

export default RootHandler;
