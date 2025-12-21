import { OgcApiEndpoint } from '@camptocamp/ogc-client';

// Configuration
const OGC_API_URL = 'http://localhost:3000/' // 'https://demo.ldproxy.net/zoomstack'; // Replace with your OGC API URL->'https://demo.ldproxy.net/zoomstack'; /

// Test Results Storage
type ResultType = 'success' | 'errors' | 'warnings';

const results: Record<ResultType, { message: string; data: any; timestamp: string }[]> = {
  success: [],
  errors: [],
  warnings: []
};

// Helper function to log results
function logResult(type: ResultType, message: string, data: any = null) {
  const entry = { message, data, timestamp: new Date().toISOString() };
  results[type].push(entry);
  console.log(`[${type.toUpperCase()}] ${message}`, data || '');
}

// Main test function
async function testOgcApi() {
  console.log('=== Starting OGC API Tests ===\n');
  console.log(`Testing API: ${OGC_API_URL}\n`);

  try {
    // Initialize the OGC API endpoint
    console.log('1. Initializing OGC API Endpoint...');
    const endpoint = await new OgcApiEndpoint(OGC_API_URL);
    logResult('success', 'Endpoint initialized successfully');

    // Test endpoint info
    console.log('\n2. Testing Endpoint Info...');
    const info = await endpoint.info;
    logResult('success', 'Endpoint info retrieved', {
      title: info.title,
      description: info.description,
      attribution: info.attribution
    });

    // Test collections
    console.log('\n4. Testing Collections...');
    const allCollections = await endpoint.allCollections;
    logResult('success', `Found ${allCollections.length} collections`, {
      count: allCollections.length,
      collections: allCollections.map(c => ({
        id: c.name
      }))
    });

    // Test feature collections
    console.log('\n5. Testing Feature Collections...');
    const featureCollections = await endpoint.featureCollections;
    logResult('success', `Found ${featureCollections.length} feature collections`, {
      count: featureCollections.length,
      names: featureCollections.map(c => c.name)
    });

    // Test record collections
    console.log('\n6. Testing Record Collections...');
    const recordCollections = await endpoint.recordCollections;
    logResult('success', `Found ${recordCollections.length} record collections`, {
      count: recordCollections.length,
      names: recordCollections.map(c => c.name)
    });

    // Test each collection in detail
    console.log('\n7. Testing Individual Collections...');
    for (const collection of allCollections) {
      await testCollection(endpoint, collection);
    }

    // Test if service has vector features
    console.log('\n8. Testing vector features support...');
    const hasVectorFeatures = endpoint.hasVectorFeatures;
    logResult('success', `Has vector features: ${hasVectorFeatures}`);

    // Test if service has records
    console.log('\n9. Testing records support...');
    const hasRecords = endpoint.hasRecords;
    logResult('success', `Has records: ${hasRecords}`);

  } catch (error) {
    logResult('errors', 'Fatal error during testing', {
      message: error.message,
      stack: error.stack
    });
  }

  // Print summary
  printSummary();
}

// Test individual collection
async function testCollection(endpoint, collection) {
  console.log(`\n  Testing collection: ${collection.name}`);
  
  try {
    const collectionInfo = await endpoint.getCollectionInfo(collection.name);
    // Log collection details
    logResult('success', `Collection details: ${collection.name}`, {
      id: collection.id,
      title: collection.title,
      description: collection.description,
      itemType: collection.itemType,
      extent: collection.extent,
      crs: collection.crs,
      storageCrs: collection.storageCrs
    });

    // Test getting items URL
    console.log(`    - Generating items URL...`);
    try {
      const itemsUrl = await endpoint.getCollectionItemsUrl(collection.id, {
        limit: 10
      });
      logResult('success', `Items URL generated for ${collection.id}`, {
        url: itemsUrl
      });

      // Fetch items directly
      console.log(`    - Fetching items...`);
      const response = await fetch(itemsUrl);
      const items = await response.json();
      
      logResult('success', `Items retrieved from ${collection.id}`, {
        count: items.features?.length || items.length || 0,
        numberMatched: items.numberMatched,
        numberReturned: items.numberReturned
      });

      // Test spatial query if collection has spatial extent
      if (collection.extent?.spatial?.bbox) {
        console.log(`    - Testing spatial query...`);
        const bbox = collection.extent.spatial.bbox[0];
        if (bbox && bbox.length >= 4) {
          const spatialUrl = await endpoint.getCollectionItemsUrl(collection.id, {
            bbox: bbox,
            limit: 5
          });
          logResult('success', `Spatial query URL for ${collection.id}`, {
            bbox: bbox,
            url: spatialUrl
          });
        }
      }

      // Test temporal query if collection has temporal extent
      if (collection.extent?.temporal?.interval) {
        console.log(`    - Testing temporal query...`);
        const temporal = collection.extent.temporal.interval[0];
        if (temporal && (temporal[0] || temporal[1])) {
          try {
            const temporalUrl = endpoint.getCollectionItemsUrl(collection.id, {
              datetime: temporal[0] || temporal[1],
              limit: 5
            });
            logResult('success', `Temporal query URL for ${collection.id}`, {
              datetime: temporal,
              url: temporalUrl
            });
          } catch (err) {
            logResult('warnings', `Temporal query failed for ${collection.id}`, {
              error: err.message
            });
          }
        }
      }

      // Test getting a single item URL if items exist
      if (items.features && items.features.length > 0) {
        console.log(`    - Testing single item URL generation...`);
        const firstItemId = items.features[0].id;
        try {
          const itemUrl = endpoint.getCollectionItemUrl(collection.id, firstItemId);
          logResult('success', `Single item URL generated for ${collection.id}`, {
            itemId: firstItemId,
            url: itemUrl
          });
        } catch (err) {
          logResult('warnings', `Could not generate item URL for ${collection.id}`, {
            itemId: firstItemId,
            error: err.message
          });
        }
      }

      // Test bulk download URLs
      console.log(`    - Testing bulk download URLs...`);
      try {
        const formats = ['json', 'geojson', 'csv'];
        const bulkUrls = {};
        for (const format of formats) {
          try {
            const bulkUrl = endpoint.getCollectionItemsUrl(collection.id, {
              outputFormat: format
            });
            bulkUrls[format] = bulkUrl;
          } catch (err) {
            // Format might not be supported
          }
        }
        if (Object.keys(bulkUrls).length > 0) {
          logResult('success', `Bulk download URLs for ${collection.id}`, bulkUrls);
        }
      } catch (err) {
        logResult('warnings', `Could not generate bulk URLs for ${collection.id}`, {
          error: err.message
        });
      }

    } catch (err) {
      logResult('warnings', `Could not fetch items from ${collection.id}`, {
        error: err.message
      });
    }

  } catch (error) {
    logResult('errors', `Error testing collection ${collection.id}`, {
      message: error.message
    });
  }
}

// Print test summary
function printSummary() {
  console.log('\n\n=== Test Summary ===');
  console.log(`✓ Successes: ${results.success.length}`);
  console.log(`⚠ Warnings: ${results.warnings.length}`);
  console.log(`✗ Errors: ${results.errors.length}`);

  if (results.errors.length > 0) {
    console.log('\n=== Errors ===');
    results.errors.forEach((err, idx) => {
      console.log(`${idx + 1}. ${err.message}`);
      if (err.data) console.log('   ', JSON.stringify(err.data, null, 2));
    });
  }

  if (results.warnings.length > 0) {
    console.log('\n=== Warnings ===');
    results.warnings.forEach((warn, idx) => {
      console.log(`${idx + 1}. ${warn.message}`);
    });
  }

  console.log('\n=== Test Statistics ===');
  console.log(`Total tests: ${results.success.length + results.warnings.length + results.errors.length}`);
  console.log(`Success rate: ${((results.success.length / (results.success.length + results.errors.length)) * 100).toFixed(2)}%`);

  console.log('\n=== Full Results ===');
  console.log(JSON.stringify(results, null, 2));
}

// Run tests
testOgcApi().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});