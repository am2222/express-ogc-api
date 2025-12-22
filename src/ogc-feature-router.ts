
import express, { Request, Response, NextFunction, Router, Application } from 'express';

import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
// Types
interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

interface Feature {
    type: 'Feature';
    id: string | number;
    geometry: any;
    properties: Record<string, unknown>;
    links?: Link[];
}

interface FeatureCollection {
    type: 'FeatureCollection';
    features: Feature[];
    links?: Link[];
    numberMatched?: number;
    numberReturned?: number;
    timeStamp?: string;
}

interface Collection {
    id: string;
    title?: string;
    description?: string;
    links?: Link[];
    extent?: {
        spatial?: {
            bbox: number[][];
            crs?: string;
        };
        temporal?: {
            interval: (string | null)[][];
            trs?: string;
        };
    };
    itemType?: string;
    crs?: string[];
    storageCrs?: string;
}

interface Link {
    href: string;
    rel: string;
    type?: string;
    title?: string;
}

interface QueryParams {
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

interface UpdateFeatureParams {
    feature: Feature;
    replace?: boolean;
}

interface Queryable {
    $id: string;
    type: 'object';
    title?: string;
    description?: string;
    properties: Record<string, unknown>;
    $schema: string;
}

interface FunctionMetadata {
    name: string;
    description?: string;
    returns: string;
    arguments: Array<{
        name: string;
        type: string;
        description?: string;
    }>;
}

// Abstract Backend Class
export abstract class OGCFeaturesBackend {
    // Part 1: Core - Read operations
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

    // Part 3: Filtering - Queryables
    async getQueryables(collectionId: string): Promise<Queryable> {
        return {
            $id: `queryables/${collectionId}`,
            type: 'object',
            title: `Queryables for ${collectionId}`,
            properties: {},
            $schema: 'https://json-schema.org/draft/2019-09/schema'
        };
    }

    // Part 3: Filtering - Functions (optional)
    async getFunctions(): Promise<FunctionMetadata[]> {
        return [];
    }

    // Part 4: CRUD - Create, Replace, Update and Delete
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

    // Part 5: Schemas
    async getSchema(collectionId: string): Promise<any> {
        const collection = await this.getCollection(collectionId);

        if (!collection) {
            throw new Error('Collection not found');
        }

        // Get a sample feature to infer schema
        const features = await this.getFeatures(collectionId, { limit: 1 });
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
            description: collection.description || `Features in the ${collectionId} collection`,
            properties: {

                geometry: {
                    "format": "geometry-any",
                    "x-ogc-role": "primary-geometry",

                    description: 'The geometry of the feature'
                },
                ...propertiesSchema
            }
        };
    }

    // Helper function to infer JSON Schema type from value
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
}

// Middleware Configuration
export interface OGCFeaturesConfig {
    backend: OGCFeaturesBackend;
    basePath?: string;
    title?: string;
    description?: string;
    defaultLimit?: number;
    maxLimit?: number;
    supportedCrs?: string[];
    defaultCrs?: string;
    enableTransactions?: boolean; // Part 4: CRUD
    enableFiltering?: boolean; // Part 3: CQL2
    enableCrs?: boolean; // Part 2: CRS support
    enablePropertySelection?: boolean; // Part 6
    enableSorting?: boolean; // Part 8
    enableSchemas?: boolean; // Part 5
    app?: Application; // Optional Express app instance
}

// Main Middleware Class
export class OGCFeaturesMiddleware {
    private backend: OGCFeaturesBackend;
    private basePath: string;
    private title: string;
    private description: string;
    private defaultLimit: number;
    private maxLimit: number;
    private supportedCrs: string[];
    private defaultCrs: string;
    private enableTransactions: boolean;
    private enableFiltering: boolean;
    private enableCrs: boolean;
    private enablePropertySelection: boolean;
    private enableSorting: boolean;
    private enableSchemas: boolean;
    private router: Router;
    private app?: Application;

    constructor(config: OGCFeaturesConfig) {
        this.backend = config.backend;
        this.basePath = config.basePath || '/';
        this.title = config.title || 'OGC API - Features';
        this.description = config.description || 'OGC API - Features implementation';
        this.defaultLimit = config.defaultLimit || 10;
        this.maxLimit = config.maxLimit || 1000;
        this.supportedCrs = config.supportedCrs || ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'];
        this.defaultCrs = config.defaultCrs || 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
        this.enableTransactions = config.enableTransactions || false;
        this.enableFiltering = config.enableFiltering || false;
        this.enableCrs = config.enableCrs || false;
        this.enablePropertySelection = config.enablePropertySelection || false;
        this.enableSorting = config.enableSorting || false;
        this.enableSchemas = config.enableSchemas || false;

        this.app = config.app;  // <-- Capture app if provided

        // Example: Use app here if needed (e.g., add global JSON parser dynamically)
        if (this.app && !this.app._router?.stack.some(layer => layer.name === 'json')) {
            this.app.use(express.json({ type: ['application/json', 'application/geo+json'] }));
            console.log('Dynamically added JSON body parser to app');
        }
        this.router = Router();

        this.router.use((req: Request, res: Response, next: NextFunction) => {
            // Log all requests
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
            if (Object.keys(req.query).length > 0) {
                console.log('  Query params:', req.query);
            }
            console.log('  User-Agent:', req.get('User-Agent'));

            this.setHeaders(req, res);
            next();
        });
        this.setupRoutes();
        this.setupSwagger();
    }

    private setupSwagger(): void {
        const swaggerOptions = {
            definition: {
                openapi: '3.0.0',
                info: {
                    title: this.title,
                    version: '1.0.0',
                    description: this.description,
                },
                servers: [
                    {
                        url: this.basePath,
                        description: 'OGC API - Features Server'
                    }
                ],
                tags: [
                    { name: 'Capabilities', description: 'Service metadata and conformance' },
                    { name: 'Data', description: 'Access to data (features)' }
                ]
            },
            apis: [] // We'll define specs programmatically
        };

        const swaggerSpec = this.generateOpenAPISpec();

        // Serve OpenAPI JSON
        this.router.get('/api', (req, res) => {
            res.json(swaggerSpec);
        });

        // Serve Swagger UI (optional, for interactive docs)
        this.router.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
    }

    private generateOpenAPISpec(): any {
        return {
            openapi: '3.0.0',
            info: {
                title: this.title,
                version: '1.0.0',
                description: this.description,
                contact: {
                    name: 'API Support'
                }
            },
            servers: [
                {
                    url: this.basePath || '/',
                    description: 'OGC API - Features Server'
                }
            ],
            paths: {
                '/': {
                    get: {
                        tags: ['Capabilities'],
                        summary: 'Landing page',
                        description: 'The landing page provides links to the API definition, conformance statements, and collections.',
                        responses: {
                            '200': {
                                description: 'Links to the API capabilities',
                                content: {
                                    'application/json': {
                                        schema: { $ref: '#/components/schemas/LandingPage' }
                                    }
                                }
                            }
                        }
                    }
                },
                '/conformance': {
                    get: {
                        tags: ['Capabilities'],
                        summary: 'Conformance declaration',
                        description: 'Lists the conformance classes implemented by this API',
                        responses: {
                            '200': {
                                description: 'Conformance declaration',
                                content: {
                                    'application/json': {
                                        schema: { $ref: '#/components/schemas/Conformance' }
                                    }
                                }
                            }
                        }
                    }
                },
                '/collections': {
                    get: {
                        tags: ['Capabilities'],
                        summary: 'List collections',
                        description: 'Lists all available feature collections',
                        responses: {
                            '200': {
                                description: 'List of collections',
                                content: {
                                    'application/json': {
                                        schema: { $ref: '#/components/schemas/Collections' }
                                    }
                                }
                            }
                        }
                    }
                },
                '/collections/{collectionId}': {
                    get: {
                        tags: ['Capabilities'],
                        summary: 'Collection metadata',
                        description: 'Metadata about a specific collection',
                        parameters: [
                            {
                                name: 'collectionId',
                                in: 'path',
                                required: true,
                                schema: { type: 'string' },
                                description: 'Collection identifier'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'Collection metadata',
                                content: {
                                    'application/json': {
                                        schema: { $ref: '#/components/schemas/Collection' }
                                    }
                                }
                            },
                            '404': {
                                description: 'Collection not found'
                            }
                        }
                    }
                },
                '/collections/{collectionId}/items': {
                    get: {
                        tags: ['Data'],
                        summary: 'Get features',
                        description: 'Fetch features from a collection',
                        parameters: [
                            {
                                name: 'collectionId',
                                in: 'path',
                                required: true,
                                schema: { type: 'string' },
                                description: 'Collection identifier'
                            },
                            {
                                name: 'limit',
                                in: 'query',
                                schema: { type: 'integer', minimum: 1, maximum: this.maxLimit, default: this.defaultLimit },
                                description: 'Maximum number of features to return'
                            },
                            {
                                name: 'offset',
                                in: 'query',
                                schema: { type: 'integer', minimum: 0, default: 0 },
                                description: 'Number of features to skip'
                            },
                            {
                                name: 'bbox',
                                in: 'query',
                                schema: { type: 'string' },
                                description: 'Bounding box (minX,minY,maxX,maxY)',
                                example: '-180,-90,180,90'
                            },
                            {
                                name: 'datetime',
                                in: 'query',
                                schema: { type: 'string' },
                                description: 'Temporal filter (RFC 3339)',
                                example: '2023-01-01T00:00:00Z/..'
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'GeoJSON FeatureCollection',
                                content: {
                                    'application/geo+json': {
                                        schema: { $ref: '#/components/schemas/FeatureCollection' }
                                    }
                                }
                            }
                        }
                    }
                },
                '/collections/{collectionId}/items/{featureId}': {
                    get: {
                        tags: ['Data'],
                        summary: 'Get a feature',
                        description: 'Fetch a single feature by ID',
                        parameters: [
                            {
                                name: 'collectionId',
                                in: 'path',
                                required: true,
                                schema: { type: 'string' }
                            },
                            {
                                name: 'featureId',
                                in: 'path',
                                required: true,
                                schema: { type: 'string' }
                            }
                        ],
                        responses: {
                            '200': {
                                description: 'GeoJSON Feature',
                                content: {
                                    'application/geo+json': {
                                        schema: { $ref: '#/components/schemas/Feature' }
                                    }
                                }
                            },
                            '404': {
                                description: 'Feature not found'
                            }
                        }
                    }
                }
            },
            components: {
                schemas: {
                    LandingPage: {
                        type: 'object',
                        properties: {
                            title: { type: 'string' },
                            description: { type: 'string' },
                            links: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Link' }
                            }
                        }
                    },
                    Conformance: {
                        type: 'object',
                        properties: {
                            conformsTo: {
                                type: 'array',
                                items: { type: 'string' }
                            }
                        }
                    },
                    Collections: {
                        type: 'object',
                        properties: {
                            links: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Link' }
                            },
                            collections: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Collection' }
                            }
                        }
                    },
                    Collection: {
                        type: 'object',
                        required: ['id', 'links'],
                        properties: {
                            id: { type: 'string' },
                            title: { type: 'string' },
                            description: { type: 'string' },
                            links: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Link' }
                            },
                            extent: {
                                type: 'object',
                                properties: {
                                    spatial: {
                                        type: 'object',
                                        properties: {
                                            bbox: {
                                                type: 'array',
                                                items: {
                                                    type: 'array',
                                                    minItems: 4,
                                                    maxItems: 6,
                                                    items: { type: 'number' }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    FeatureCollection: {
                        type: 'object',
                        required: ['type', 'features'],
                        properties: {
                            type: { type: 'string', enum: ['FeatureCollection'] },
                            features: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Feature' }
                            },
                            links: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Link' }
                            },
                            numberMatched: { type: 'integer' },
                            numberReturned: { type: 'integer' },
                            timeStamp: { type: 'string', format: 'date-time' }
                        }
                    },
                    Feature: {
                        type: 'object',
                        required: ['type', 'geometry', 'properties'],
                        properties: {
                            type: { type: 'string', enum: ['Feature'] },
                            id: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                            geometry: { type: 'object' },
                            properties: { type: 'object' }
                        }
                    },
                    Link: {
                        type: 'object',
                        required: ['href', 'rel'],
                        properties: {
                            href: { type: 'string', format: 'uri' },
                            rel: { type: 'string' },
                            type: { type: 'string' },
                            title: { type: 'string' }
                        }
                    }
                }
            }
        };
    }

    private setupRoutes(): void {
        // Landing page
        this.router.get('/', this.handleLandingPage.bind(this));

        // Conformance
        this.router.get('/conformance', this.handleConformance.bind(this));

        // Collections
        this.router.get('/collections', this.handleCollections.bind(this));
        this.router.get('/collections/:collectionId', this.handleCollection.bind(this));

        // Features - GET
        this.router.get('/collections/:collectionId/items', this.handleFeatures.bind(this));
        this.router.get('/collections/:collectionId/items/:featureId', this.handleFeature.bind(this));

        // Part 3: Filtering - Queryables
        if (this.enableFiltering) {
            this.router.get('/collections/:collectionId/queryables', this.handleQueryables.bind(this));
            this.router.get('/functions', this.handleFunctions.bind(this));
        }

        // Part 4: CRUD operations
        if (this.enableTransactions) {
            this.router.post('/collections/:collectionId/items', this.handleCreateFeature.bind(this));
            this.router.put('/collections/:collectionId/items/:featureId', this.handleReplaceFeature.bind(this));
            this.router.patch('/collections/:collectionId/items/:featureId', this.handleUpdateFeature.bind(this));
            this.router.delete('/collections/:collectionId/items/:featureId', this.handleDeleteFeature.bind(this));
            // Fix: Explicit OPTIONS handler for items endpoint to comply with OGC API Part 4
            this.router.options('/collections/:collectionId/items', this.handleOptionsItems.bind(this));
        }

        // Part 5: Schemas
        if (this.enableSchemas) {
            this.router.get('/collections/:collectionId/schema', this.handleSchema.bind(this));
        }
    }

    private handleOptionsItems(req: Request, res: Response): void {
        // OGC API Part 4 compliance: Return 200 OK with Allow header listing supported methods
        res.status(200);
        const allowMethods = ['GET', 'HEAD', 'OPTIONS'];
        if (this.enableTransactions) {
            allowMethods.push('POST', 'PUT', 'PATCH', 'DELETE');
        }
        res.set('Allow', allowMethods.join(', '));
        res.send(); // Empty body
    }

    private setHeaders(req: Request, res: Response): void {

        const requestedFormat = (req.query.f as string)?.toLowerCase();

        if (requestedFormat === 'json' || requestedFormat === 'geo+json') {
            res.setHeader('Content-Type', 'application/geo+json');  // Or 'application/json' if not GeoJSON-specific
        } else {
            // Default fallback for OGC API
            res.setHeader('Content-Type', 'application/geo+json');
        }

        // Note: Allow header is now set dynamically in specific handlers (e.g., OPTIONS) for accuracy
        // Global fallback only if not OPTIONS or specific path
        if (req.method !== 'OPTIONS') {
            res.setHeader('Allow', 'GET, HEAD, OPTIONS');
        }
    }
    private buildUrl(req: Request, path: string, includeQuery: boolean = false, queryParams: Record<string, any> = {}): string {
        const protocol = req.protocol;
        const host = req.get('host');
        const basePath = this.basePath.replace(/\/+$/, '');
        const baseUrl = `${protocol}://${host}${basePath}${path}`;

        // Determine which query parameters to use
        const paramsToUse = Object.keys(queryParams).length > 0 ? queryParams : req.query;

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

    private getConformanceClasses(): string[] {
        const classes = [
            'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
            'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
            'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
            "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
            "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json",
            "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page",
            "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/oas30",
            "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections",

        ];

        if (this.enableCrs) {
            classes.push(
                'http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs'
            );
        }

        if (this.enableFiltering) {
            classes.push(
                'http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter',
                'http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/features-filter',
                'http://www.opengis.net/spec/cql2/1.0/conf/cql2-text',
                'http://www.opengis.net/spec/cql2/1.0/conf/cql2-json',
                'http://www.opengis.net/spec/cql2/1.0/conf/basic-cql2',
                'http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/queryables'
            );
        }

        if (this.enableTransactions) {
            classes.push(
                'http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete',
                'http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/update'
            );
        }

        if (this.enableSchemas) {
            classes.push(
                'http://www.opengis.net/spec/ogcapi-features-5/1.0/conf/schemas'
            );
        }

        if (this.enablePropertySelection) {
            classes.push(
                'http://www.opengis.net/spec/ogcapi-features-6/1.0/conf/property-selection'
            );
        }

        if (this.enableSorting) {
            classes.push(
                'http://www.opengis.net/spec/ogcapi-features-8/1.0/conf/sorting'
            );
        }

        return classes;
    }

    private async handleLandingPage(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const links: Link[] = [
                {
                    href: this.buildUrl(req, '/'),
                    rel: 'self',
                    type: 'application/json',
                    title: 'This document'
                },
                {
                    href: this.buildUrl(req, '/conformance'),
                    rel: 'conformance',
                    type: 'application/json',
                    title: 'Conformance declaration'
                },
                {
                    href: this.buildUrl(req, '/collections'),
                    rel: 'data',
                    type: 'application/json',
                    title: 'Collections'
                },
                {
                    href: this.buildUrl(req, '/api'),
                    rel: 'service-desc',
                    type: 'application/vnd.oai.openapi+json;version=3.0',
                    title: 'API definition'
                },
                {
                    href: 'https://docs.ogc.org/is/17-069r4/17-069r4.html',
                    rel: 'service-doc',
                    type: 'text/html',
                    title: 'API documentation'
                }
            ];

            if (this.enableFiltering) {
                links.push({
                    href: this.buildUrl(req, '/functions'),
                    rel: 'http://www.opengis.net/def/rel/ogc/1.0/functions',
                    type: 'application/json',
                    title: 'Functions'
                });
            }

            const landingPage = {
                title: this.title,
                description: this.description,
                links
            };

            res.json(landingPage);
        } catch (err) {
            next(err);
        }
    }

    private async handleConformance(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const conformance = {
                conformsTo: this.getConformanceClasses()
            };
            res.json(conformance);
        } catch (err) {
            next(err);
        }
    }

    private async handleCollections(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const collections = await this.backend.getCollections();

            const response = {
                links: [
                    {
                        href: this.buildUrl(req, '/collections'),
                        rel: 'self',
                        type: 'application/json',
                        title: 'This document'
                    }
                ],
                collections: collections.map(c => {
                    const links: Link[] = [
                        {
                            href: this.buildUrl(req, `/collections/${c.id}`),
                            rel: 'self',
                            type: 'application/json',
                            title: c.title || c.id
                        },
                        {
                            href: this.buildUrl(req, `/collections/${c.id}/items`),
                            rel: 'items',
                            type: 'application/geo+json',
                            title: 'Items'
                        }
                    ];

                    if (this.enableFiltering) {
                        links.push({
                            href: this.buildUrl(req, `/collections/${c.id}/queryables`),
                            rel: 'http://www.opengis.net/def/rel/ogc/1.0/queryables',
                            type: 'application/schema+json',
                            title: 'Queryables'
                        });
                    }

                    if (this.enableSchemas) {
                        links.push({
                            href: this.buildUrl(req, `/collections/${c.id}/schema`),
                            rel: 'http://www.opengis.net/def/rel/ogc/1.0/schema',
                            type: 'application/schema+json',
                            title: 'Schema'
                        });
                    }

                    return {
                        ...c,
                        links: [...links, ...(c.links || [])],
                        crs: this.enableCrs ? (c.crs || this.supportedCrs) : undefined,
                        storageCrs: this.enableCrs ? c.storageCrs : undefined
                    };
                })
            };

            res.json(response);
        } catch (err) {
            next(err);
        }
    }

    private async handleCollection(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId } = req.params;
            const collection = await this.backend.getCollection(collectionId);

            if (!collection) {
                res.status(404).json({ error: 'Collection not found' });
                return;
            }

            const links: Link[] = [
                {
                    href: this.buildUrl(req, `/collections/${collectionId}`),
                    rel: 'self',
                    type: 'application/json',
                    title: collection.title || collectionId
                },
                {
                    href: this.buildUrl(req, `/collections/${collectionId}/items`),
                    rel: 'items',
                    type: 'application/geo+json',
                    title: 'Items'
                }
            ];

            if (this.enableFiltering) {
                links.push({
                    href: this.buildUrl(req, `/collections/${collectionId}/queryables`),
                    rel: 'http://www.opengis.net/def/rel/ogc/1.0/queryables',
                    type: 'application/schema+json',
                    title: 'Queryables'
                });
            }

            if (this.enableSchemas) {
                links.push({
                    href: this.buildUrl(req, `/collections/${collectionId}/schema`),
                    rel: 'http://www.opengis.net/def/rel/ogc/1.0/schema',
                    type: 'application/schema+json',
                    title: 'Schema'
                });
            }

            const response = {
                ...collection,
                links: [...links, ...(collection.links || [])],
                crs: this.enableCrs ? (collection.crs || this.supportedCrs) : undefined,
                storageCrs: this.enableCrs ? collection.storageCrs : undefined
            };

            res.json(response);
        } catch (err) {
            next(err);
        }
    }

    private parseQueryParams(req: Request): QueryParams {
        const params: QueryParams = {};

        // Limit
        if (req.query.limit) {
            params.limit = Math.min(
                parseInt(req.query.limit as string, 10) || this.defaultLimit,
                this.maxLimit
            );
        } else {
            params.limit = this.defaultLimit;
        }

        // Offset
        if (req.query.offset) {
            params.offset = parseInt(req.query.offset as string, 10) || 0;
        }

        // Bounding box (Part 1)
        if (req.query.bbox) {
            const bbox = (req.query.bbox as string).split(',').map(Number);
            if (bbox.length === 4 || bbox.length === 6) {
                params.bbox = {
                    minX: bbox[0],
                    minY: bbox[1],
                    maxX: bbox[2],
                    maxY: bbox[3]
                };
            }
        }

        // Part 2: CRS support
        if (this.enableCrs) {
            if (req.query['bbox-crs']) {
                params.bboxCrs = req.query['bbox-crs'] as string;
            }
            if (req.query.crs) {
                params.crs = req.query.crs as string;
            }
        }

        // Datetime (Part 1)
        if (req.query.datetime) {
            params.datetime = req.query.datetime as string;
        }

        // Part 3: Filtering
        if (this.enableFiltering) {
            if (req.query.filter) {
                params.filter = req.query.filter as string;
                params.filterLang = (req.query['filter-lang'] as any) || 'cql2-text';
            }
            if (req.query['filter-crs']) {
                params.filterCrs = req.query['filter-crs'] as string;
            }
        }

        // Part 6: Property Selection
        if (this.enablePropertySelection && req.query.properties) {
            params.properties = (req.query.properties as string).split(',');
        }

        // Part 7: Geometry Simplification
        if (req.query['skip-geometry']) {
            params.skipGeometry = req.query['skip-geometry'] === 'true';
        }
        if (req.query['max-allawable-offset']) {
            params.maxAllowableOffset = parseFloat(req.query['max-allawable-offset'] as string);
        }

        // Part 8: Sorting
        if (this.enableSorting && req.query.sortby) {
            params.sortby = req.query.sortby as string;
        }

        return params;
    }

    private async handleFeatures(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId } = req.params;
            const params = this.parseQueryParams(req);

            const featureCollection = await this.backend.getFeatures(collectionId, params);

            const offset = params.offset || 0;
            const limit = params.limit || this.defaultLimit;
            const currentQuery = req.query;
            const selfUrl = this.buildUrl(req, `/collections/${collectionId}/items`, true, currentQuery);

            const links: Link[] = [
                {
                    href: selfUrl,
                    rel: 'self',
                    type: 'application/geo+json',
                    title: 'This document'
                }
            ];

            // Add next link if there are more features
            if (featureCollection.numberMatched && offset + limit < featureCollection.numberMatched) {
                const nextQuery = { ...req.query, offset: (offset + limit).toString() };
                const nextHref = this.buildUrl(req, `/collections/${collectionId}/items`, true, nextQuery);

                links.push({
                    href: nextHref,
                    rel: 'next',
                    type: 'application/geo+json',
                    title: 'Next page'
                });
            }

            // Add prev link if not on first page
            if (offset > 0) {
                const prevOffset = Math.max(0, offset - limit);
                const prevQuery = { ...req.query, offset: prevOffset.toString() };
                const prevHref = this.buildUrl(req, `/collections/${collectionId}/items`, true, prevQuery);
                links.push({
                    href: prevHref,
                    rel: 'prev',
                    type: 'application/geo+json',
                    title: 'Previous page'
                });
            }

            const response: FeatureCollection = {
                ...featureCollection,
                links,
                timeStamp: new Date().toISOString()
            };

            res.json(response);
        } catch (err) {
            next(err);
        }
    }

    private async handleFeature(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId, featureId } = req.params;
            const feature = await this.backend.getFeature(collectionId, featureId);

            if (!feature) {
                res.status(404).json({ error: 'Feature not found' });
                return;
            }

            res.json(feature);
        } catch (err) {
            next(err);
        }
    }

    // Part 3: Filtering endpoints
    private async handleQueryables(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId } = req.params;
            const queryables = await this.backend.getQueryables(collectionId);
            res.json(queryables);
        } catch (err) {
            next(err);
        }
    }

    private async handleFunctions(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const functions = await this.backend.getFunctions();
            res.json({ functions });
        } catch (err) {
            next(err);
        }
    }

    // Part 4: CRUD operations
    private async handleCreateFeature(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId } = req.params;
            const feature = req.body;

            const created = await this.backend.createFeature(collectionId, feature);

            if (!created) {
                res.status(400).json({ error: 'Failed to create feature' });
                return;
            }

            res.status(201)
                .location(this.buildUrl(req, `/collections/${collectionId}/items/${created.id}`))
                .json(created);
        } catch (err) {
            next(err);
        }
    }

    private async handleReplaceFeature(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId, featureId } = req.params;
            const feature = req.body;

            const replaced = await this.backend.replaceFeature(collectionId, featureId, feature);

            if (!replaced) {
                res.status(404).json({ error: 'Feature not found' });
                return;
            }

            res.status(204).send();
        } catch (err) {
            next(err);
        }
    }

    private async handleUpdateFeature(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId, featureId } = req.params;
            const updates = req.body;

            const updated = await this.backend.updateFeature(collectionId, featureId, { feature: updates });

            if (!updated) {
                res.status(404).json({ error: 'Feature not found' });
                return;
            }

            res.status(204).send();
        } catch (err) {
            next(err);
        }
    }

    private async handleDeleteFeature(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId, featureId } = req.params;

            const deleted = await this.backend.deleteFeature(collectionId, featureId);

            if (!deleted) {
                res.status(404).json({ error: 'Feature not found' });
                return;
            }

            res.status(204).send();
        } catch (err) {
            next(err);
        }
    }

    // Part 5: Schemas
    private async handleSchema(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { collectionId } = req.params;
            const schema = await this.backend.getSchema(collectionId);
            res.json(schema);
        } catch (err) {
            next(err);
        }
    }

    public getRouter(): Router {
        return this.router;
    }
}