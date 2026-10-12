# Changelog

## [1.6.0](https://github.com/am2222/express-ogc-api/compare/express-ogc-api-v1.5.0...express-ogc-api-v1.6.0) (2026-10-12)


### Features

* **provider:** add caching for numberMatched and improve metadata memoization ([d13f9c9](https://github.com/am2222/express-ogc-api/commit/d13f9c90427154e52d899a6777365cd215931631))

## [1.5.0](https://github.com/am2222/express-ogc-api/compare/express-ogc-api-v1.4.0...express-ogc-api-v1.5.0) (2026-10-12)


### Features

* **provider:** implement geometryWriteExpression for precise storage ([a7c11d3](https://github.com/am2222/express-ogc-api/commit/a7c11d3d636270e6079dd1e4b6a74c8b05e0c271))

## [1.4.0](https://github.com/am2222/express-ogc-api/compare/express-ogc-api-v1.3.0...express-ogc-api-v1.4.0) (2026-10-10)


### Features

* **provider:** add metadata caching for DuckLakeProvider ([772f071](https://github.com/am2222/express-ogc-api/commit/772f071c017bd4752cf99ade237d75bc0ff0b010))

## [1.3.0](https://github.com/am2222/express-ogc-api/compare/express-ogc-api-v1.2.0...express-ogc-api-v1.3.0) (2026-08-08)


### Features

* update DuckLakeProvider documentation to clarify CRS handling in geometry types ([c333be5](https://github.com/am2222/express-ogc-api/commit/c333be51bbd5b5db75fd4af16a71670036523aaa))

## [1.2.0](https://github.com/am2222/express-ogc-api/compare/express-ogc-api-v1.1.0...express-ogc-api-v1.2.0) (2026-08-04)


### Features

* optimize DuckDB spatial extension loading by installing once in global setup ([34759c5](https://github.com/am2222/express-ogc-api/commit/34759c54a177455ab283caa3bb784a065491fb29))
* optimize DuckDB spatial extension loading by installing once in… ([33a18cf](https://github.com/am2222/express-ogc-api/commit/33a18cffbd405dd80b25c4d669dced11e579e85b))

## [1.1.0](https://github.com/am2222/express-ogc-api/compare/express-ogc-api-v1.0.0...express-ogc-api-v1.1.0) (2026-08-04)


### Features

* add DuckDBProvider tests for collection discovery, feature CRUD, and schema generation ([e27d4c6](https://github.com/am2222/express-ogc-api/commit/e27d4c6c5afd1b4bc2e95cd1230c3f71f382c496))
* enhance DuckDBProvider to provide detailed error messages for invalid enum values ([49b1553](https://github.com/am2222/express-ogc-api/commit/49b1553961f5b9469c4c07cc0613fd62f983a051))
* enhance DuckDBProvider to support readOnly metadata for id columns with defaults ([65d57a5](https://github.com/am2222/express-ogc-api/commit/65d57a5bcd49d821aa903704f13c662615209cc3))
* enhance DuckDBProvider with schema and validation improvements ([d1f0085](https://github.com/am2222/express-ogc-api/commit/d1f0085cac48191ef2f25c7e80cd65f98f031f7c))
* enhance OGC API with improved request handling, type safety, and new features ([3952c2c](https://github.com/am2222/express-ogc-api/commit/3952c2c71a8a4de99dbf066646a96963155943bc))
* implement sequence-backed IDs for demo tables and enhance QGIS compatibility in DuckDBProvider ([9b11870](https://github.com/am2222/express-ogc-api/commit/9b11870cf9cdc358b20bdd23d55a71ca78f066bc))


### Code Refactoring

* enhance provider interfaces and request handling for improved type safety ([7f09a7c](https://github.com/am2222/express-ogc-api/commit/7f09a7c573cf4a287dcddfb39230829dd8270b3e))
