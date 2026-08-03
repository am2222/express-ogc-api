/** biome-ignore-all lint/suspicious/noExplicitAny: <explanation> */
// biome-ignore assist/source/organizeImports: <explanation>
import type {
  Collection,
  CollectionSchema,
  Feature,
  FeatureCollection,
  FunctionMetadata,
  ProviderRequest,
  Queryable,
  QueryParams,
  UpdateFeatureParams,
} from '@/types';
import BaseProvider from './base-provider';
import type { OGCAPIConformanceItem } from '@/types/ogc-confirmance';
import { OGCAPIConformanceClass } from '@/types/ogc-confirmance';
import { FeatureValidationError } from '@/errors';

// Example implementation with extended features
export class InMemoryProvider extends BaseProvider {
  // Capability flags are now declared explicitly rather than inferred from
  // which abstract methods a subclass overrides (see "Migrating" in the
  // README). This provider genuinely implements all three:
  // `getSchema` infers a real JSON Schema from a sample feature,
  // `getFeatures`/`getQueryables` support bbox + a basic CQL2 filter, and
  // `createFeature`/`replaceFeature`/`updateFeature`/`deleteFeature` are all
  // functional below.
  public override readonly enableSchemas = true;
  public override readonly enableFiltering = true;
  public override readonly enableTransactions = true;

  private collections: Map<string, Collection>;
  private features: Map<string, Map<string, Feature>>;

  constructor() {
    super({ name: 'InMemoryProvider' });
    this.collections = new Map();
    this.features = new Map();
  }

  inferPropertyType(value: any): any {
    if (value === null) {
      return { type: 'null' };
    }

    const jsType = typeof value;

    switch (jsType) {
      case 'string':
        // Check if it's a date
        if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
          return { type: 'string', format: 'date' };
        }
        return { type: 'string' };

      case 'number':
        return Number.isInteger(value)
          ? { type: 'integer' }
          : { type: 'number' };

      case 'boolean':
        return { type: 'boolean' };

      case 'object':
        if (Array.isArray(value)) {
          return { type: 'array' };
        }
        return { type: 'object' };

      default:
        return { type: 'string' };
    }
  }

  async getSchema(
    req: ProviderRequest,
    collectionId: string
  ): Promise<CollectionSchema> {
    const collection = await this.getCollection(req, collectionId);

    if (!collection) {
      throw new Error('Collection not found');
    }

    // Get a sample feature to infer schema
    const features = await this.getFeatures(req, collectionId, { limit: 1 });
    const sampleFeature = features.features[0];

    // Build properties schema from sample feature. `x-ogc-propertySeq` and
    // `title` mirror what `DuckDBProvider.getSchema` emits: the geometry
    // stub below is always sequence 0 (it's the primary geometry, declared
    // first), and every inferred property gets the next sequence in the
    // sample feature's own key order — that order is the closest thing an
    // in-memory feature has to a "declared" column order — plus a title
    // derived the same simple way (see `titleFromColumnName`).
    const propertiesSchema: Record<string, any> = {};

    if (sampleFeature?.properties) {
      Object.entries(sampleFeature.properties).forEach(([key, value], index) => {
        propertiesSchema[key] = {
          ...this.inferPropertyType(value),
          title: this.titleFromColumnName(key),
          'x-ogc-propertySeq': index + 1,
        };
      });
    }

    return {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $id: collectionId,
      type: 'object',
      title: collection.title || collectionId,
      description:
        collection.description || `Features in the ${collectionId} collection`,
      properties: {
        geometry: {
          format: 'geometry-any',
          'x-ogc-role': 'primary-geometry',
          title: 'Geometry',
          'x-ogc-propertySeq': 0,
          description: 'The geometry of the feature',
        },
        ...propertiesSchema,
      },
    };
  }

  conformanceClasses(): OGCAPIConformanceItem[] {
    return [
      OGCAPIConformanceClass.COMMON_CORE,
      OGCAPIConformanceClass.COMMON_LANDING_PAGE,
      OGCAPIConformanceClass.COMMON_JSON,
      OGCAPIConformanceClass.FEATURES_CORE,
      OGCAPIConformanceClass.FEATURES_GEOJSON,
      ...this.schemaConformanceClasses(),
    ];
  }

  addCollection(collection: Collection): void {
    this.collections.set(collection.id, collection);
    this.features.set(collection.id, new Map());
  }

  addFeature(collectionId: string, feature: Feature): void {
    const collectionFeatures = this.features.get(collectionId);
    if (collectionFeatures) {
      collectionFeatures.set(String(feature.id), feature);
    }
  }

  async getCollections(_req: ProviderRequest): Promise<Collection[]> {
    return Array.from(this.collections.values());
  }

  async getCollection(
    _req: ProviderRequest,
    collectionId: string
  ): Promise<Collection | null> {
    return this.collections.get(collectionId) || null;
  }

  async getFeatures(
    _req: ProviderRequest,
    collectionId: string,
    params: QueryParams
  ): Promise<FeatureCollection> {
    const collectionFeatures = this.features.get(collectionId);
    if (!collectionFeatures) {
      return {
        type: 'FeatureCollection',
        features: [],
        numberMatched: 0,
        numberReturned: 0,
      };
    }

    let features = Array.from(collectionFeatures.values());

    // Apply bbox filter
    if (params.bbox) {
      features = features.filter((f) => {
        if (f.geometry?.type === 'Point') {
          const [x, y] = f.geometry.coordinates;
          return (
            x >= (params.bbox?.[0] ?? -Infinity) &&
            x <= (params.bbox?.[2] ?? Infinity) &&
            y >= (params.bbox?.[1] ?? -Infinity) &&
            y <= (params.bbox?.[3] ?? Infinity)
          );
        }
        return true;
      });
    }

    // Part 3: Apply CQL2 filter (basic implementation).
    //
    // Previously gated on `params.filterLang` too, which meant a caller that
    // set `filter` without also setting `filterLang` (the query-param
    // handler always sets both, defaulting `filterLang` to 'cql2-text', but
    // a direct `getFeatures` caller need not) had its filter silently
    // skipped entirely — the same unfiltered-200 shape this fix closes
    // elsewhere. `filterLang` isn't actually used by `applyFilter` below, so
    // there's nothing lost by not requiring it here.
    if (params.filter) {
      features = this.applyFilter(features, params.filter, params.filterLang ?? 'cql2-text');
    }

    // Part 8: Apply sorting
    if (params.sortby) {
      features = this.applySorting(features, params.sortby);
    }

    const numberMatched = features.length;
    const offset = params.offset || 0;
    const limit = params.limit || 10;

    features = features.slice(offset, offset + limit);

    // Part 6: Property selection
    if (params.properties) {
      features = features.map((f) =>
        this.selectProperties(f, params.properties!)
      );
    }

    // Part 7: Skip geometry
    if (params.skipGeometry) {
      features = features.map((f) => ({ ...f, geometry: null }));
    }

    return {
      type: 'FeatureCollection',
      features,
      numberMatched,
      numberReturned: features.length,
    };
  }

  async getFeature(
    _req: ProviderRequest,
    collectionId: string,
    featureId: string
  ): Promise<Feature | null> {
    const collectionFeatures = this.features.get(collectionId);
    return collectionFeatures?.get(featureId) ?? null;
  }

  // Part 3: Filtering support
  async getQueryables(
    _req: ProviderRequest,
    collectionId: string
  ): Promise<Queryable> {
    const collection = this.collections.get(collectionId);
    if (!collection) {
      throw new Error('Collection not found');
    }

    // Sample queryables - customize based on your data
    return {
      $id: `queryables/${collectionId}`,
      type: 'object',
      title: `Queryables for ${collectionId}`,
      description: 'Properties that can be used in filter expressions',
      properties: {
        id: { type: 'string', title: 'Feature ID' },
        geometry: { $ref: 'https://geojson.org/schema/Geometry.json' },
        // Add more properties based on your schema
      },
      $schema: 'https://json-schema.org/draft/2019-09/schema',
    };
  }

  async getFunctions(): Promise<FunctionMetadata[]> {
    return [
      {
        name: 'lower',
        description: 'Converts string to lowercase',
        returns: 'string',
        arguments: [{ name: 'value', type: 'string' }],
      },
      {
        name: 'upper',
        description: 'Converts string to uppercase',
        returns: 'string',
        arguments: [{ name: 'value', type: 'string' }],
      },
    ];
  }

  // Part 4: CRUD operations
  async createFeature(
    _req: ProviderRequest,
    collectionId: string,
    feature: Feature
  ): Promise<Feature | null> {
    const collectionFeatures = this.features.get(collectionId);
    if (!collectionFeatures) {
      return null;
    }

    // Generate ID if not provided
    if (!feature.id) {
      feature.id = `feature_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    collectionFeatures.set(String(feature.id), feature);
    return feature;
  }

  async replaceFeature(
    _req: ProviderRequest,
    collectionId: string,
    featureId: string,
    feature: Feature
  ): Promise<Feature | null> {
    const collectionFeatures = this.features.get(collectionId);
    if (!collectionFeatures || !collectionFeatures.has(featureId)) {
      return null;
    }

    feature.id = featureId;
    collectionFeatures.set(featureId, feature);
    return feature;
  }

  async updateFeature(
    _req: ProviderRequest,
    collectionId: string,
    featureId: string,
    params: UpdateFeatureParams
  ): Promise<Feature | null> {
    const collectionFeatures = this.features.get(collectionId);
    const existing = collectionFeatures?.get(featureId);

    if (!existing || !collectionFeatures) {
      return null;
    }

    const updated = {
      ...existing,
      properties: { ...existing.properties, ...params.feature.properties },
      geometry: params.feature.geometry || existing.geometry,
    };

    collectionFeatures.set(featureId, updated);
    return updated;
  }

  async deleteFeature(
    _req: ProviderRequest,
    collectionId: string,
    featureId: string
  ): Promise<boolean> {
    const collectionFeatures = this.features.get(collectionId);
    if (!collectionFeatures) {
      return false;
    }
    return collectionFeatures.delete(featureId);
  }

  // Helper methods for filtering and sorting

  /**
   * A minimal, regex-based CQL2 evaluator for this in-memory reference
   * provider — not a real CQL2 parser. It honours exactly two shapes, each
   * matched against the *entire* filter string: a quoted-string equality
   * (`name = 'value'`) and a numeric comparison (`population > 1000000`).
   *
   * `Cql2ToSql` (see `src/cql2/`) is not used here: it emits SQL, and this
   * provider has no SQL engine to run it against — a real in-memory CQL2
   * evaluator is a separate, larger piece of work than this fix.
   *
   * Anything this cannot confidently evaluate — an expression the regexes
   * don't match, or one that only partially matches — throws
   * `FeatureValidationError` (→ 400) rather than falling through to
   * `return features` unfiltered. A filter is very often an access
   * restriction; silently ignoring one and returning every feature with a
   * 200 is the over-exposure this whole fix exists to close, and this
   * provider must not reproduce it just because its evaluator is small.
   */
  private applyFilter(
    features: Feature[],
    filter: string,
    _filterLang: string
  ): Feature[] {
    const trimmed = filter.trim();

    // Simple property equality example: name = 'value'
    const equalityMatch = /^(\w+)\s*=\s*'([^']*)'$/.exec(trimmed);
    if (equalityMatch) {
      const [, prop, value] = equalityMatch;
      return features.filter((f) => f.properties[prop as string] === value);
    }

    // Simple comparison: population > 1000000
    const comparisonMatch = /^(\w+)\s*(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?)$/.exec(trimmed);
    if (comparisonMatch) {
      const [, prop, op, value] = comparisonMatch;
      const numValue = parseFloat(value as string);
      return features.filter((f) => {
        const propValue = f.properties[prop as string];
        if (typeof propValue !== 'number') return false;
        switch (op) {
          case '>':
            return propValue > numValue;
          case '<':
            return propValue < numValue;
          case '>=':
            return propValue >= numValue;
          case '<=':
            return propValue <= numValue;
          case '=':
            return propValue === numValue;
          default:
            return false;
        }
      });
    }

    throw new FeatureValidationError(
      `InMemoryProvider cannot evaluate this filter expression: ${filter}`,
      { status: 400 }
    );
  }

  private applySorting(features: Feature[], sortby: string): Feature[] {
    // Parse sortby: +property or -property
    const sorts = sortby.split(',').map((s) => {
      const desc = s.startsWith('-');
      const prop = s.replace(/^[+-]/, '');
      return { prop, desc };
    });

    return features.sort((a, b) => {
      for (const { prop, desc } of sorts) {
        const aVal: any = a.properties[prop];
        const bVal: any = b.properties[prop];

        let cmp = 0;
        if (aVal < bVal) cmp = -1;
        else if (aVal > bVal) cmp = 1;

        if (cmp !== 0) {
          return desc ? -cmp : cmp;
        }
      }
      return 0;
    });
  }

  private selectProperties(feature: Feature, properties: string[]): Feature {
    const selected: Record<string, any> = {};
    for (const prop of properties) {
      if (feature.properties.hasOwnProperty(prop)) {
        selected[prop] = feature.properties[prop];
      }
    }
    return { ...feature, properties: selected };
  }
}
