// biome-ignore assist/source/organizeImports: <explanation>
import type { Request, Response, NextFunction } from 'express';
import type { Router } from 'express';

import type { BaseProvider } from '@/providers/base-provider';
import type { OGCAPIConformanceItem } from '@/types/ogc-confirmance';
import type { Exception, OGCFeaturesConfig } from '@/types';

export class BaseHandler {
  provider: BaseProvider;
  requiredCoreClasses: OGCAPIConformanceItem[] = []
  basePath: string = '/';
  options: OGCFeaturesConfig = {};


  constructor(provider: BaseProvider, options: OGCFeaturesConfig = {}) {
    this.provider = provider;
    this.options = options;
    if (options.basePath) {
      this.basePath = options.basePath;
    }
  }

  sendError(res: Response, statusCode: number, message: string): void {
    const exception: Exception = {
      code: statusCode.toString(),
      description: message
    }
    res.status(statusCode).json(exception);
  }

  validateRequest(req: Request, res: Response, next: NextFunction): void {
    // Common middleware: auth, content-type, etc.
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    next();
  }

  isProviderConformed(): boolean {
    if (!this.provider) {
      return false;
    }
    if (!this.requiredCoreClasses || this.requiredCoreClasses.length === 0) {
      throw new Error('requiredCoreClasses is not defined in the handler');
    }
    const providerConformance = this.provider.conformanceClasses();
    return this.requiredCoreClasses.every((coreClass) =>
      providerConformance.includes(coreClass)
    );
  }

  buildUrl(req: Request, path: string, includeQuery: boolean = false, queryParams: Record<string, string | number | boolean> = {}): string {
    const protocol = req.protocol;
    const host = req.get('host');
    const basePath = this.basePath.replace(/\/+$/, '');
    const baseUrl = `${protocol}://${host}${basePath}${path}`;

    // Determine which query parameters to use
    const paramsToUse = Object.keys(queryParams).length > 0 ? queryParams : req.query;

    // If includeQuery is true, append query parameters
    if (includeQuery && Object.keys(paramsToUse).length > 0) {
      const params = new URLSearchParams();
      Object.entries(paramsToUse).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          params.append(key, value.toString());
        }
      });
      const queryString = params.toString();
      return queryString ? `${baseUrl}?${queryString}` : baseUrl;
    }

    return baseUrl;
  }


  setupRoutes(router: Router): void {
    throw new Error('Must implement setupRoutes in subclass');
  };
}

export default BaseHandler;