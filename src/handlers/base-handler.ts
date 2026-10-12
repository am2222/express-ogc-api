// biome-ignore assist/source/organizeImports: <explanation>
import type { Router, Request, Response, NextFunction } from 'express';
import type { ParsedQs } from 'qs';
import type { BaseProvider } from '@/providers/base-provider';
import type { OGCAPIConformanceItem } from '@/types/ogc-confirmance';
import type { Exception, OGCFeaturesConfig } from '@/types';

export class BaseHandler {
  provider: BaseProvider;
  requiredCoreClasses: OGCAPIConformanceItem[] = [];
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
      description: message,
    };
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

  preProviderHook(req: Request, res: Response, next: NextFunction): void {
    // Hook to run before provider methods
    this.provider.preProviderHook(req, res);
    next();
  }

  isProviderConformed(): boolean {
    if (!this.provider) {
      return false;
    }
    if (!this.requiredCoreClasses) {
      throw new Error('requiredCoreClasses is not defined in the handler');
    }
    const providerConformance = this.provider.conformanceClasses();
    return this.requiredCoreClasses.every((coreClass) =>
      providerConformance.includes(coreClass)
    );
  }

  buildUrl(
    req: Request,
    path: string,
    includeQuery: boolean = false,
    queryParams: ParsedQs = {}
  ): string {
    const protocol = req.protocol;
    const host = req.get('host');
    const basePath = this.basePath.replace(/\/+$/, '');
    const baseUrl = `${protocol}://${host}${basePath}${path}`;

    // Determine which query parameters to use
    const paramsToUse =
      Object.keys(queryParams).length > 0 ? queryParams : req.query;

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

  setupRoutes(_router: Router): void {
    throw new Error('Must implement setupRoutes in subclass');
  }

  protected negotiateContent(
    data: any,
    templateName: string
  ): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        const accept = req.get('Accept') || 'application/json'; // default to JSON

        if (accept.includes('application/json') || accept.includes('application/geo+json') || accept === '*/*') {
          res.status(200).json(data);
        } else if (accept.includes('text/html')) {
          this.renderTemplate(templateName, data)(req, res, next);
        } else {
          this.sendError(res, 406, 'Not Acceptable: Supported formats are application/json and text/html');
        }
      } catch (error) {
        next(error);
      }
    };
  }

  protected renderHtml(data: any): string {
    return `
      <html>
        <head><title>OGC API Response</title></head>
        <body>
          <h1>Response</h1>
          <pre>${JSON.stringify(data, null, 2)}</pre>
        </body>
      </html>
    `;
  }

  renderTemplate(
    templateName: string,
    data: any = {}
  ): (req: Request, res: Response, next: NextFunction) => void {
    return (_req: Request, res: Response, next: NextFunction) => {
      const siteData = {
        title: 'My Basecoat App',
        user: { name: 'Alice', role: 'Admin' },
        items: [
          { id: 1, name: 'Item One', price: 10 },
          { id: 2, name: 'Item Two', price: 20 },
          { id: 3, name: 'Item Three', price: 30 }
        ]
      };
      try {
        res.render('index', {
          ...siteData,
          pageTitle: 'Home Page'
        });
      } catch (error) {
        next(error);
      }
    };
  }

}

export default BaseHandler;
