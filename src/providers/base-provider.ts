// biome-ignore assist/source/organizeImports: <explanation>
import type {
  Collection,
  CollectionSchema,
  Feature,
  FeatureCollection,
  ProviderRequest,
  Queryable,
  QueryParams,
  UpdateFeatureParams,
} from '@/types';
import { OGCAPIConformanceClass, type OGCAPIConformanceItem } from '@/types/ogc-confirmance';

export interface ProviderDef {
  name: string;
}

export abstract class BaseProvider<
  TParams extends Record<string, string> = Record<string, string>,
  TLocals extends Record<string, any> = Record<string, any>,
> {
  public name: string;

  /**
   * Declares that this provider's `getSchema` is genuinely implemented.
   * Setting this to `true` activates `GET /collections/{id}/schema` (see
   * `SchemaHandler.isProviderConformed`) and folds the Part 5 "Schemas"
   * conformance class into `conformanceClasses()` (via
   * `schemaConformanceClasses()`). Must be declared explicitly by every
   * concrete subclass that supports it — see "Migrating" in the README for
   * why this can no longer be detected automatically.
   */
  public readonly enableSchemas: boolean = false;

  /**
   * Declares that this provider's `getFeatures`/`getQueryables` genuinely
   * support filtering. Setting this to `true` activates
   * `GET /collections/{id}/queryables` and makes the `filter` and
   * `filter-lang` query parameters live in `ItemsCURDHandler.parseQueryParams`
   * (otherwise they are silently ignored). Must be declared explicitly by
   * every concrete subclass that supports it.
   */
  public readonly enableFiltering: boolean = false;

  /**
   * Declares that this provider performs CRS transformation rather than
   * merely advertising `supportedCrs`/`defaultCrs`. Setting this to `true`
   * makes the `crs`, `bbox-crs` and `filter-crs` query parameters live in
   * `ItemsCURDHandler.parseQueryParams`, and turns on `crs`/`storageCrs` in
   * collection responses (`CollectionHandler`). Leaving it `false` when a
   * provider doesn't actually transform CRS keeps those parameters honestly
   * inert instead of accepted-but-ignored. Must be declared explicitly by
   * every concrete subclass that supports it.
   */
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

  /**
   * Declares that this provider's `createFeature`/`replaceFeature`/
   * `updateFeature`/`deleteFeature` are genuinely implemented. Setting this
   * to `true` activates the write endpoints (`POST`/`PUT`/`PATCH`/`DELETE`
   * on `/collections/{id}/items[/{featureId}]`, see
   * `ItemsCURDHandler.setupRoutes`) and advertises them in the `OPTIONS`
   * `Allow` header (`RootHandler.handleOptionsRequests`). Must be declared
   * explicitly by every concrete subclass that supports it.
   */
  public readonly enableTransactions: boolean = false;
  public readonly defaultLimit: number = 100;

  public readonly maxLimit: number = 1000;
  public readonly defaultOffset: number = 10;

  constructor(providerDef: ProviderDef) {
    if (this.constructor === BaseProvider) {
      throw new TypeError('BaseProvider is abstract; use a concrete subclass');
    }
    this.name = providerDef.name;
  }

  /**
   * The Part 5 "Schemas" conformance class to fold into a subclass's
   * `conformanceClasses()`, tied to the `enableSchemas` flag this class
   * already computes (rather than each provider hand-listing the class
   * literal and letting it drift out of sync with whether `getSchema` is
   * actually meaningfully implemented). Returns an empty array when
   * `enableSchemas` is false, so `[...classes, ...this.schemaConformanceClasses()]`
   * is always safe to spread.
   */
  protected schemaConformanceClasses(): OGCAPIConformanceItem[] {
    return this.enableSchemas ? [OGCAPIConformanceClass.FEATURES_SCHEMAS] : [];
  }

  /**
   * Derive a human-readable field alias from a column/property name for the
   * `title` schema keyword (QGIS uses this as the field's alias in its
   * attribute table). Kept deliberately simple and predictable: split on
   * `_`/`-`, capitalize the first letter of each resulting word, and join
   * with a space — no acronym handling, no camelCase splitting.
   * `founded_year` -> `Founded Year`; `id` -> `Id`.
   */
  protected titleFromColumnName(name: string): string {
    return name
      .split(/[_-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  abstract getSchema(
    req: ProviderRequest<TParams, TLocals>,
    collectionId: string
  ): Promise<CollectionSchema> | CollectionSchema;

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
