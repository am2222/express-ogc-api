import type { Request, Response, NextFunction } from 'express';

/**
 * Configuration options for the OGC API middleware
 */
export interface OgcApiOptions {
  /**
   * Base path for the OGC API endpoints
   * @default '/ogc'
   */
  basePath?: string;

  /**
   * Enable CORS headers
   * Note: When enabled, sets Access-Control-Allow-Origin to '*'
   * For production use with credentials, configure CORS middleware separately
   * @default true
   */
  cors?: boolean;

  /**
   * API title for the landing page
   * @default 'OGC API'
   */
  title?: string;

  /**
   * API description
   * @default 'OGC API implementation'
   */
  description?: string;

  /**
   * Custom conformance classes
   */
  conformsTo?: string[];
}

/**
 * Default OGC API conformance classes
 */
const DEFAULT_CONFORMS_TO = [
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page',
  'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json',
];

/**
 * Creates an Express middleware for OGC API standards
 *
 * @param options - Configuration options for the middleware
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { ogcApiMiddleware } from 'express-ogc-api';
 *
 * const app = express();
 * app.use(ogcApiMiddleware({
 *   basePath: '/ogc',
 *   title: 'My OGC API',
 *   cors: true
 * }));
 * ```
 */
export function ogcApiMiddleware(options: OgcApiOptions = {}) {
  const {
    basePath = '/ogc',
    cors = true,
    title = 'OGC API',
    description = 'OGC API implementation',
    conformsTo = DEFAULT_CONFORMS_TO,
  } = options;

  // Normalize base path to ensure it starts with '/' and doesn't end with '/'
  const normalizedBasePath = basePath.startsWith('/')
    ? basePath.replace(/\/$/, '')
    : `/${basePath}`.replace(/\/$/, '');

  return (req: Request, res: Response, next: NextFunction): void => {
    // Add CORS headers if enabled
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    // Handle landing page
    if (req.path === normalizedBasePath || req.path === `${normalizedBasePath}/`) {
      res.json({
        title,
        description,
        links: [
          {
            href: `${normalizedBasePath}/`,
            rel: 'self',
            type: 'application/json',
            title: 'This document',
          },
          {
            href: `${normalizedBasePath}/conformance`,
            rel: 'conformance',
            type: 'application/json',
            title: 'Conformance declaration',
          },
          {
            href: `${normalizedBasePath}/api`,
            rel: 'service-desc',
            type: 'application/vnd.oai.openapi+json;version=3.0',
            title: 'API definition',
          },
        ],
      });
      return;
    }

    // Handle conformance endpoint
    if (req.path === `${normalizedBasePath}/conformance`) {
      res.json({
        conformsTo,
      });
      return;
    }

    // Handle API definition endpoint
    if (req.path === `${normalizedBasePath}/api`) {
      res.json({
        openapi: '3.0.3',
        info: {
          title,
          description,
          version: '1.0.0',
        },
        paths: {
          [`${normalizedBasePath}/`]: {
            get: {
              summary: 'Landing page',
              description: 'The landing page provides links to start exploring the API',
              responses: {
                '200': {
                  description: 'Links to the API capabilities',
                },
              },
            },
          },
          [`${normalizedBasePath}/conformance`]: {
            get: {
              summary: 'Conformance declaration',
              description: 'Information about the standards this API conforms to',
              responses: {
                '200': {
                  description: 'Conformance classes',
                },
              },
            },
          },
          [`${normalizedBasePath}/api`]: {
            get: {
              summary: 'API definition',
              description: 'This document',
              responses: {
                '200': {
                  description: 'The OpenAPI definition',
                },
              },
            },
          },
        },
      });
      return;
    }

    // Continue to next middleware
    next();
  };
}

export default ogcApiMiddleware;
