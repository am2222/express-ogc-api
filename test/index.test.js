import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { ogcApiMiddleware } from '../dist/index.js';

describe('OGC API Middleware', () => {
  let app;
  let server;
  const port = 3001;
  const baseUrl = `http://localhost:${port}`;

  before((done) => {
    app = express();
    app.use(
      ogcApiMiddleware({
        basePath: '/ogc',
        title: 'Test API',
        description: 'Test Description',
      })
    );
    server = app.listen(port, done);
  });

  after(() => {
    server.close();
  });

  it('should return landing page', async () => {
    const response = await fetch(`${baseUrl}/ogc`);
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.title, 'Test API');
    assert.strictEqual(data.description, 'Test Description');
    assert(Array.isArray(data.links));
  });

  it('should return conformance declaration', async () => {
    const response = await fetch(`${baseUrl}/ogc/conformance`);
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert(Array.isArray(data.conformsTo));
    assert(data.conformsTo.length > 0);
  });

  it('should return API definition', async () => {
    const response = await fetch(`${baseUrl}/ogc/api`);
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.openapi, '3.0.3');
    assert.strictEqual(data.info.title, 'Test API');
  });

  it('should set CORS headers', async () => {
    const response = await fetch(`${baseUrl}/ogc`);

    assert.strictEqual(
      response.headers.get('access-control-allow-origin'),
      '*'
    );
  });
});
