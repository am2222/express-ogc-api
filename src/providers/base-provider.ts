// biome-ignore assist/source/organizeImports: <explanation>
import type {
  Collection,
  Feature,
  FeatureCollection,
  ProviderRequest,
  Queryable,
  QueryParams,
  UpdateFeatureParams,
} from '@/types';
import type { OGCAPIConformanceItem } from '@/types/ogc-confirmance';

export interface ProviderDef {
  name: string;
}

export abstract class BaseProvider<
  TParams extends Record<string, string> = Record<string, string>,
  TLocals extends Record<string, any> = Record<string, any>,
> {
  public name: string;

  public readonly enableSchemas: boolean = false;
  public readonly enableFiltering: boolean = false;
  public readonly enableCrs: boolean = false;

  public readonly supportedCrs: string[] = [
    'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
  ];

  public readonly defaultCrs: string =
    'http://www.opengis.net/def/crs/OGC/1.3/CRS84';

  public readonly defaultTimeFormat: string = 'date-time';

  public readonly defaultNumberFormat: string = 'float';

  public readonly defaultIntegerFormat: string = 'int32';

  public readonly defaultIdFormat: string = 'string';

  public readonly enableTransactions: boolean = false;
  public readonly defaultLimit: number = 100;

  public readonly maxLimit: number = 1000;
  public readonly defaultOffset: number = 10;

  constructor(providerDef: ProviderDef) {
    if (this.constructor === BaseProvider) {
      throw new TypeError('BaseProvider is abstract; use a concrete subclass');
    }
    this.name = providerDef.name;

    //check if getSchema is implemented in subclass
    const proto = Object.getPrototypeOf(this);
    if (
      proto.getSchema &&
      proto.getSchema !== BaseProvider.prototype.getSchema
    ) {
      this.enableSchemas = true;
    } else {
      this.enableSchemas = false;
    }

    //check if crs handling is implemented in subclass
    if (
      proto.getFeatures &&
      proto.getFeatures !== BaseProvider.prototype.getFeatures
    ) {
      this.enableFiltering = true;
    } else {
      this.enableFiltering = false;
    }

    // check if transactions are enabled
    if (
      proto.createFeature &&
      proto.createFeature !== BaseProvider.prototype.createFeature &&
      proto.updateFeature &&
      proto.updateFeature !== BaseProvider.prototype.updateFeature &&
      proto.deleteFeature &&
      proto.deleteFeature !== BaseProvider.prototype.deleteFeature
    ) {
      this.enableTransactions = true;
    } else {
      this.enableTransactions = false;
    }
  }

  abstract getSchema(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string
  ): Promise<Record<string, unknown>> | Record<string, unknown>;

  abstract createFeature(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string,
    feature: Feature
  ): Promise<Feature | null>;

  abstract replaceFeature(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string,
    featureId: string,
    feature: Feature
  ): Promise<Feature | null>;

  abstract updateFeature(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string,
    featureId: string,
    params: UpdateFeatureParams
  ): Promise<Feature | null>;

  abstract deleteFeature(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string,
    featureId: string
  ): Promise<boolean>;

  abstract conformanceClasses(): OGCAPIConformanceItem[];

  abstract getCollections(
    req: ProviderRequest<TParams, TLocals>
  ): Promise<Collection[]> | Collection[];

  abstract getCollection(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string
  ): Promise<Collection | null> | Collection | null;

  abstract getFeatures(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string,
    params: QueryParams
  ): Promise<FeatureCollection> | FeatureCollection;

  abstract getFeature(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string,
    featureId: string
  ): Promise<Feature | null> | Feature | null;

  abstract getQueryables(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string
  ): Promise<Queryable> | Queryable;

  // Abstract methods for collection management
  abstract addCollection(collection: Collection): void;
  abstract addFeature(collectionId: string, feature: Feature): void;

}

export default BaseProvider;
