import { BaseHandler } from '@/handlers/base-handler';
import type { ProviderRequest } from '@/types';
import type { NextFunction, Request, Response, Router } from 'express';

export class RootHandler extends BaseHandler {
  requiredCoreClasses = [];

  private async handleSchema(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { collectionId } = req.params;
      const schema = await this.provider.getSchema(req as ProviderRequest, collectionId);
      res.json(schema);
    } catch (err) {
      next(err);
    }
  }

  setupRoutes(router: Router) {
    router.get(
      '/collections/:collectionId/schema',
      this.handleSchema.bind(this)
    );
  }

  isProviderConformed(): boolean {
    return this.provider.enableSchemas;
  }
}

export default RootHandler;
