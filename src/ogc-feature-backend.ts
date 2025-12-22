
import type { Feature, FeatureCollection } from 'geojson';
import type { Collection } from './types/collection.js';
import type { QueryParams } from './types/query-params.js';
import type { Queryable } from './types/queryable.js';
import type { FunctionMetadata } from './types/function-metadata.js';
import type { UpdateFeatureParams } from './types/update-feature-params.js';

export abstract class OGCFeaturesBackend {
  abstract getCollections(): Promise<Collection[]>;
  abstract getCollection(collectionId: string): Promise<Collection | null>;
  abstract getFeatures(
    collectionId: string,
    params: QueryParams
  ): Promise<FeatureCollection>;
  abstract getFeature(
    collectionId: string,
    featureId: string
  ): Promise<Feature | null>;

  async getQueryables(collectionId: string): Promise<Queryable> {
    return {
      $id: `queryables/${collectionId}`,
      type: 'object',
      title: `Queryables for ${collectionId}`,
      properties: {},
      $schema: 'https://json-schema.org/draft/2019-09/schema'
    };
  }

  async getFunctions(): Promise<FunctionMetadata[]> {
    return [];
  }

  async createFeature(
    collectionId: string,
    feature: Feature
  ): Promise<Feature | null> {
    throw new Error('Create operation not supported');
  }

  async replaceFeature(
    collectionId: string,
    featureId: string,
    feature: Feature
  ): Promise<Feature | null> {
    throw new Error('Replace operation not supported');
  }

  async updateFeature(
    collectionId: string,
    featureId: string,
    params: UpdateFeatureParams
  ): Promise<Feature | null> {
    throw new Error('Update operation not supported');
  }

  async deleteFeature(
    collectionId: string,
    featureId: string
  ): Promise<boolean> {
    throw new Error('Delete operation not supported');
  }

  async getSchema(collectionId: string): Promise<any> {
    const collection = await this.getCollection(collectionId);

    if (!collection) {
      throw new Error('Collection not found');
    }

    const features = await this.getFeatures(collectionId, { limit: 1 });
    const sampleFeature = features.features[0];

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
      description: collection.description || `Features in the ${collectionId} collection`,
      properties: {
        geometry: {
          format: 'geometry-any',
          'x-ogc-role': 'primary-geometry',
          description: 'The geometry of the feature'
        },
        ...propertiesSchema
      }
    };
  }

  inferPropertyType(value: any): any {
    if (value === null) {
      return { type: 'null' };
    }

    const jsType = typeof value;

    switch (jsType) {
      case 'string':
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
}
