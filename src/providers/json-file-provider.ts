import BaseProvider from './base.js';
import fs from 'fs'; // Node.js fs for dynamic file ops (use sync for simplicity; async in prod)

export class JSONFileProvider extends BaseProvider {
  constructor(providerDef) {
    super(providerDef);
    this.dataPath = providerDef.data;
    this.loadData();
  }

  loadData() {
    try {
      const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
      this.features = data; // Assume { type: 'FeatureCollection', features: [...] }
    } catch (err) {
      throw new Error(`Failed to load data from ${this.dataPath}: ${err.message}`);
    }
  }

  getFields() {
    if (this.features?.features?.length > 0) {
      return Object.keys(this.features.features[0].properties || {});
    }
    return [];
  }

  query(params) {
    let filtered = [...(this.features?.features || [])];
    // Basic filtering (extend for bbox, datetime, etc.)
    if (params.bbox) {
      // Implement bbox filter logic here
    }
    if (params.limit) {
      filtered = filtered.slice(0, parseInt(params.limit));
    }
    return { type: 'FeatureCollection', features: filtered };
  }

  get(identifier) {
    return this.features?.features?.find(f => f.id === identifier) || null;
  }

  create(newFeature) {
    newFeature.id = Date.now().toString();
    this.features.features.push(newFeature);
    this.persistData();
    return newFeature;
  }

  update(identifier, updatedFeature) {
    const index = this.features.features.findIndex(f => f.id === identifier);
    if (index !== -1) {
      this.features.features[index] = { ...updatedFeature, id: identifier };
      this.persistData();
      return this.features.features[index];
    }
    return null;
  }

  delete(identifier) {
    const index = this.features.features.findIndex(f => f.id === identifier);
    if (index !== -1) {
      this.features.features.splice(index, 1);
      this.persistData();
      return true;
    }
    return false;
  }

  persistData() {
    fs.writeFileSync(this.dataPath, JSON.stringify(this.features, null, 2));
  }

  
}

export default JSONFileProvider;