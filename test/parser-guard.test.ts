import { describe, it, expect } from 'vitest';
import express from 'express';
import { OGCAPI, InMemoryProvider } from '../src/index.js';

function jsonLayerCount(app: express.Express): number {
  let router: any;
  try {
    router = (app as any).router;
  } catch {
    // Express 4 throws when accessing .router; fall back to _router
    router = (app as any)._router;
  }
  if (!router) {
    router = (app as any)._router;
  }
  const stack = router?.stack ?? [];
  return stack.filter((layer: { name?: string }) => layer?.name === 'jsonParser').length;
}

describe('JSON body-parser injection', () => {
  it('adds exactly one parser when the app has none', () => {
    const app = express();
    new OGCAPI(new InMemoryProvider(), app, {});

    expect(jsonLayerCount(app)).toBe(1);
  });

  it('does not stack parsers across repeated construction', () => {
    const app = express();
    new OGCAPI(new InMemoryProvider(), app, {});
    new OGCAPI(new InMemoryProvider(), app, {});

    expect(jsonLayerCount(app)).toBe(1);
  });

  it('does not add a parser when the app already has one', () => {
    const app = express();
    app.use(express.json());
    new OGCAPI(new InMemoryProvider(), app, {});

    expect(jsonLayerCount(app)).toBe(1);
  });
});
