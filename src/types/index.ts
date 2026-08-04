import { OGCAPIConformanceClass } from './ogc-confirmance';
import type { Request, Response } from 'express';
import type { ParsedQs } from 'qs';
import type {
  Feature as GeoJSONFeature,
  FeatureCollection as GeoJSONFeatureCollection,
  Geometry,
} from 'geojson';
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';

/**
 * A GeoJSON feature as served by this API.
 *
 * Built on `@types/geojson` so `geometry` is a discriminated union rather than
 * `any` — narrowing on `geometry.type` gives you typed `coordinates`. `null` is
 * permitted for unlocated features (RFC 7946 §3.2) and is what Part 7's
 * `skipGeometry` produces.
 *
 * Narrows GeoJSON's optional `id` to required: OGC API - Features addresses
 * every item at `/items/{featureId}`, so a feature we serve always has one.
 */
export interface Feature
  extends GeoJSONFeature<Geometry | null, Record<string, unknown>> {
  id: string | number;
  links?: Link[];
}

export interface FeatureCollection
  extends GeoJSONFeatureCollection<Geometry | null, Record<string, unknown>> {
  features: Feature[];
  links?: Link[];
  numberMatched?: number;
  numberReturned?: number;
  timeStamp?: string;
}

interface LinkTemplate extends Link {
  uriTemplate: string;
  varBase?: string;
}

type BBox =
  | [number, number, number, number]
  | [number, number, number, number, number, number];

// Known spatial reference systems from OGC API - Features Core and potential extensions.
// The Core specification supports WGS 84 longitude/latitude (default) and WGS 84 longitude/latitude/ellipsoidal height.
// Extensions may introduce additional URIs (e.g., for other CRS like EPSG projections). This type includes the
// required values and allows for extensibility via string literals or arbitrary strings for future-proofing.
type SpatialReferenceSystem =
  | 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' // Default: WGS 84 longitude/latitude
  | 'http://www.opengis.net/def/crs/OGC/0/CRS84h' // WGS 84 longitude/latitude/ellipsoidal height
  // Example extensions (not part of Core; add as implemented):
  // | 'http://www.opengis.net/def/crs/EPSG/0/4326'    // EPSG:4326 (WGS 84 lat/long)
  // | 'http://example.com/def/crs/custom-projection'  // Custom extension URI
  | string; // Fallback for unrecognized or custom extensions

interface SpatialExtent {
  bbox: BBox[];
  crs?: SpatialReferenceSystem; // Default: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
}

// ISO 8601 date-time strings (e.g., '2011-11-11T12:22:11Z') or null for half-bounded intervals
type DateTimeString = string;

type Interval = [DateTimeString | null, DateTimeString | null];
type TemporalReferenceSystem =
  | 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian' // Default: Gregorian calendar (ISO 8601)
  // Example extensions (not part of Core; add as implemented):
  // | 'http://www.opengis.net/def/uom/ISO-8601/0/Julian'     // Hypothetical Julian calendar
  // | 'http://example.com/def/trs/custom-temporal'           // Custom extension URI
  | string; // Fallback for unrecognized or custom extensions

interface TemporalExtent {
  interval: Interval[];
  trs?: TemporalReferenceSystem; // Default: 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian'
}

interface Extent {
  spatial?: SpatialExtent;
  temporal?: TemporalExtent;
}

export interface Collection {
  id: string;
  title?: string;
  description?: string;
  links?: Link[];
  extent?: Extent;
  itemType?: string;
  crs?: string[];
  storageCrs?: string;
  linkTemplates?: LinkTemplate[];
}
export interface Collections {
  links: Link[];
  collections: Collection[];
}

export interface Link {
  href: string;
  rel: string;
  type?: string;
  hreflang?: string;
  title?: string;
  length?: number;
}

export interface QueryParams {
  limit?: number;
  offset?: number;
  bbox?: BBox;
  bboxCrs?: string;
  datetime?: string;
  properties?: string[];
  crs?: string;
  filter?: string;
  filterLang?: 'cql2-text' | 'cql2-json';
  filterCrs?: string;
  sortby?: string;
  skipGeometry?: boolean;
  maxAllowableOffset?: number;
}

export interface UpdateFeatureParams {
  feature: Feature;
  replace?: boolean;
}

/**
 * The queryables schema for a collection (Part 3).
 *
 * Extends `JSONSchema7` so nested property schemas are typed instead of
 * `unknown`; `$id`, `$schema`, `type` and `properties` are narrowed to required
 * because OGC API - Features mandates all four on this resource.
 */
export interface Queryable extends JSONSchema7 {
  $id: string;
  type: 'object';
  properties: Record<string, JSONSchema7Definition>;
  $schema: string;
}

/**
 * The schema of one property within a `CollectionSchema` (Part 5). Covers the
 * keywords the two bundled providers actually emit — plain JSON Schema
 * keywords (`type`, `format`, `title`, `enum`, `maxLength`, `contentEncoding`,
 * `description`, `readOnly`) plus the two `x-ogc-*` extensions QGIS's OGC API
 * - Features provider parses (`x-ogc-role`, `x-ogc-propertySeq`). QGIS's
 * schema parser also reads plain `readOnly` — set `true` on a property the
 * server assigns and the client must never supply (e.g. a sequence-backed
 * identifier column; see `DuckDBProvider.getSchema`). The index signature
 * keeps this open to any other JSON Schema keyword a provider wants to add,
 * since JSON Schema itself is not a closed vocabulary.
 */
export interface CollectionSchemaProperty {
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  maxLength?: number;
  contentEncoding?: string;
  readOnly?: boolean;
  'x-ogc-role'?: string;
  'x-ogc-propertySeq'?: number;
  [key: string]: unknown;
}

/**
 * The schema a provider's `getSchema` returns (Part 5 "Schemas" resource): a
 * JSON Schema object describing a collection's item properties. Named
 * keywords are typed for the ones this library actually populates; the index
 * signature leaves room for `$id`, vendor extensions, or anything else a
 * provider wants to add, since JSON Schema is intentionally open — this type
 * constrains and documents the shape without trying to close it off.
 */
export interface CollectionSchema {
  $schema?: string;
  type?: string;
  properties?: Record<string, CollectionSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface FunctionMetadata {
  name: string;
  description?: string;
  returns: string;
  arguments: Array<{
    name: string;
    type: string;
    description?: string;
  }>;
}

// https://github.com/opengeospatial/ogcapi-features/tree/master/core/openapi/schemas
export interface Exception {
  code: string;
  description?: string;
}

export type OGCAPIConformanceClassType =
  (typeof OGCAPIConformanceClass)[keyof typeof OGCAPIConformanceClass];

export interface ConformsTo {
  conformsTo: OGCAPIConformanceClassType[];
}
// Configuration export interface
export interface OGCFeaturesConfig {
  /**
   * Optional public prefix override for generated links. Leave unset to follow
   * the mount path (`req.baseUrl`), which is required when mounting at a
   * parametrized path such as `/root/:dbid`.
   */
  basePath?: string;
  title?: string;
  description?: string;
}

export interface LandingPage {
  title?: string;
  description?: string;
  links: Link[];
}

/**
 * The Express request as seen by a provider.
 *
 * `res` is declared non-optional: Express assigns the `req.res` back-reference
 * during dispatch, so it is always present inside a handler-invoked provider
 * method. Use `req.res.locals` to read whatever your middleware attached.
 */
export type ProviderRequest<
  TParams extends Record<string, string> = Record<string, string>,
  TLocals extends Record<string, any> = Record<string, any>,
> = Request<TParams, any, any, ParsedQs, TLocals> & {
  res: Response<any, TLocals>;
};
