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
  
  setupRoutes(router: Router) {
    // Landing page
    router.get('/', this.handleLandingPage.bind(this));

    // Conformance
    router.get('/conformance', this.handleConformance.bind(this));
    // OPTIONS for root
    router.options('/', this.handleOptionsRequests.bind(this));
  }
}

export default RootHandler;
