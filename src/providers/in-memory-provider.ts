/** biome-ignore-all lint/suspicious/noExplicitAny: <explanation> */
// biome-ignore assist/source/organizeImports: <explanation>
import type {
  Collection,
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

// Example implementation with extended features
export class InMemoryProvider extends BaseProvider {
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
  ): Promise<Record<string, unknown>> {
    const collection = await this.getCollection(req, collectionId);

    if (!collection) {
      throw new Error('Collection not found');
    }

    // Get a sample feature to infer schema
    const features = await this.getFeatures(req, collectionId, { limit: 1 });
    const sampleFeature = features.features[0];

    // Build properties schema from sample feature
    const propertiesSchema: Record<string, any> = {};

    if (sampleFeature?.properties) {
      Object.entries(sampleFeature.properties).forEach(([key, value]) => {
        propertiesSchema[key] = this.inferPropertyType(value);
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

    // Part 3: Apply CQL2 filter (basic implementation)
    if (params.filter && params.filterLang) {
      features = this.applyFilter(features, params.filter, params.filterLang);
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

  getFeature(
    _req: ProviderRequest,
    collectionId: string,
    featureId: string
  ): Feature | Promise<Feature> | null {
    const collectionFeatures = this.features.get(collectionId);
    const feature = collectionFeatures?.get(featureId) || null;
    return feature
      ? Promise.resolve(feature)
      : Promise.reject(new Error('Feature not found'));
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
  private applyFilter(
    features: Feature[],
    filter: string,
    _filterLang: string
  ): Feature[] {
    // Basic CQL2 filter implementation
    // In production, use a proper CQL2 parser
    try {
      // Simple property equality example: name = 'value'
      const equalityMatch = filter.match(/(\w+)\s*=\s*'([^']+)'/);
      if (equalityMatch) {
        const [, prop, value] = equalityMatch;
        return features.filter((f) => f.properties[prop] === value);
      }

      // Simple comparison: population > 1000000
      const comparisonMatch = filter.match(/(\w+)\s*([><=]+)\s*(\d+)/);
      if (comparisonMatch) {
        const [, prop, op, value] = comparisonMatch;
        const numValue = parseFloat(value);
        return features.filter((f) => {
          const propValue = f.properties[prop];
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
    } catch (e) {
      console.error('Filter parsing error:', e);
    }
    return features;
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
