import { InMemoryProvider } from '../../src/index.js';
import type { ProviderRequest } from '../../src/index.js';
import type { Collection, Feature, FeatureCollection, QueryParams } from '../../src/types/index.js';

export interface RecordedCall {
  method: string;
  params: Record<string, string>;
  baseUrl: string;
  locals: Record<string, unknown>;
}

/** InMemoryProvider that records the request handed to each call. */
export class RecordingProvider extends InMemoryProvider {
  calls: RecordedCall[] = [];

  private record(method: string, req: ProviderRequest): void {
    this.calls.push({
      method,
      params: { ...req.params },
      baseUrl: req.baseUrl,
      locals: { ...req.res.locals },
    });
  }

  /** Every recorded call for one method, oldest first. */
  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  override async getCollections(req: ProviderRequest): Promise<Collection[]> {
    this.record('getCollections', req);
    return super.getCollections(req);
  }

  override async getCollection(
    req: ProviderRequest,
    collectionId: string
  ): Promise<Collection | null> {
    this.record('getCollection', req);
    return super.getCollection(req, collectionId);
  }

  override async getFeatures(
    req: ProviderRequest,
    collectionId: string,
    params: QueryParams
  ): Promise<FeatureCollection> {
    this.record('getFeatures', req);
    return super.getFeatures(req, collectionId, params);
  }

  override getFeature(
    req: ProviderRequest,
    collectionId: string,
    featureId: string
  ): Feature | Promise<Feature> | null {
    this.record('getFeature', req);
    return super.getFeature(req, collectionId, featureId);
  }

  override async getSchema(
    req: ProviderRequest,
    collectionId: string
  ): Promise<Record<string, unknown>> {
    this.record('getSchema', req);
    return super.getSchema(req, collectionId);
  }
}
