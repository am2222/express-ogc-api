import { OGCAPIConformanceClass } from "./ogc-confirmance";


export interface Feature {
  type: 'Feature';
  id: string | number;
  geometry: any;
  properties: Record<string, unknown>;
  links?: Link[];
}

export interface FeatureCollection {
  type: 'FeatureCollection';
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

type BBox = [number, number, number, number] | [number, number, number, number, number, number];

// Known spatial reference systems from OGC API - Features Core and potential extensions.
// The Core specification supports WGS 84 longitude/latitude (default) and WGS 84 longitude/latitude/ellipsoidal height.
// Extensions may introduce additional URIs (e.g., for other CRS like EPSG projections). This type includes the
// required values and allows for extensibility via string literals or arbitrary strings for future-proofing.
type SpatialReferenceSystem =
  | 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'  // Default: WGS 84 longitude/latitude
  | 'http://www.opengis.net/def/crs/OGC/0/CRS84h'   // WGS 84 longitude/latitude/ellipsoidal height
  // Example extensions (not part of Core; add as implemented):
  // | 'http://www.opengis.net/def/crs/EPSG/0/4326'    // EPSG:4326 (WGS 84 lat/long)
  // | 'http://example.com/def/crs/custom-projection'  // Custom extension URI
  | string;  // Fallback for unrecognized or custom extensions

interface SpatialExtent {
  bbox: BBox[];
  crs?: SpatialReferenceSystem;  // Default: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'
}

// ISO 8601 date-time strings (e.g., '2011-11-11T12:22:11Z') or null for half-bounded intervals
type DateTimeString = string;

type Interval = [DateTimeString | null, DateTimeString | null];
type TemporalReferenceSystem =
  | 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian'  // Default: Gregorian calendar (ISO 8601)
  // Example extensions (not part of Core; add as implemented):
  // | 'http://www.opengis.net/def/uom/ISO-8601/0/Julian'     // Hypothetical Julian calendar
  // | 'http://example.com/def/trs/custom-temporal'           // Custom extension URI
  | string;  // Fallback for unrecognized or custom extensions

interface TemporalExtent {
  interval: Interval[];
  trs?: TemporalReferenceSystem;  // Default: 'http://www.opengis.net/def/uom/ISO-8601/0/Gregorian'
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

export interface Queryable {
  $id: string;
  type: 'object';
  title?: string;
  description?: string;
  properties: Record<string, unknown>;
  $schema: string;
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

export type OGCAPIConformanceClassType = (typeof OGCAPIConformanceClass)[keyof typeof OGCAPIConformanceClass];

export interface ConformsTo {
  conformsTo: OGCAPIConformanceClassType[];
}
// Configuration export interface
export interface OGCFeaturesConfig {
  basePath?: string; title?: string; description?: string
}

export interface LandingPage {
    title?: string;
    description?: string;
    links: Link[];
}
