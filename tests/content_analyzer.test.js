/**
 * Ported from CASCADE Enterprise RAM by C.I.P.S. LLC
 *   https://github.com/For-Sunny/cascade-memory-enterprise
 *   MIT License, (c) 2025-2026 C.I.P.S. LLC - commit acdb5c8c, 2026-02-19
 *
 * Ported into EMET unchanged except for the import path (server/ -> src/).
 * The modules under test are 99.7% and 99.8% identical to upstream, which is
 * exactly why these suites are worth carrying rather than rewriting: they are
 * the original author's assertions about the original author's code.
 */

/**
 * Unit Tests for content_analyzer.js
 * CASCADE Enterprise - Content Analyzer Tests
 *
 * Created: January 22, 2026
 * Tests the ContentAnalyzer class for proper layer routing
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import {
  ContentAnalyzer,
  RoutingDecision,
  createContentAnalyzer,
  determineLayer,
  LAYER_ALIASES,
  VALID_LAYERS
} from '../src/content_analyzer.js';
import { LAYERS as CHARTER_LAYERS, LAYER_ALIASES as CHARTER_ALIASES } from '../src/layers.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================




// ============================================================================
// TESTS: CONSTANTS
// ============================================================================

testGroup('Constants', () => {
  test('VALID_LAYERS contains all expected layers', () => {
    assert(VALID_LAYERS.includes('episodic'));
    assert(VALID_LAYERS.includes('semantic'));
    assert(VALID_LAYERS.includes('procedural'));
    assert(VALID_LAYERS.includes('meta'));
    assert(VALID_LAYERS.includes('identity'));
    assert(VALID_LAYERS.includes('working'));
  });

  test('VALID_LAYERS has exactly 6 layers', () => {
    assert.strictEqual(VALID_LAYERS.length, 6);
  });

  test('LAYER_ALIASES maps values to identity', () => {
    assert.strictEqual(LAYER_ALIASES['values'], 'identity');
  });

  test('LAYER_ALIASES maps core to identity', () => {
    assert.strictEqual(LAYER_ALIASES['core'], 'identity');
  });

  test('LAYER_ALIASES maps temp to working', () => {
    assert.strictEqual(LAYER_ALIASES['temp'], 'working');
  });

  test('LAYER_ALIASES maps facts to semantic', () => {
    assert.strictEqual(LAYER_ALIASES['facts'], 'semantic');
  });

  test('LAYER_ALIASES maps skills to procedural', () => {
    assert.strictEqual(LAYER_ALIASES['skills'], 'procedural');
  });

  // B6 (2026-09-07): one layer list. Both constants are derived from the
  // charter in src/layers.js; this is the assertion that they stay derived.
  test('LAYER_ALIASES is derived from the layer charter', () => {
    assert.deepStrictEqual({ ...LAYER_ALIASES }, { ...CHARTER_ALIASES });
  });

  test('VALID_LAYERS is derived from the layer charter', () => {
    assert.deepStrictEqual([...VALID_LAYERS], [...CHARTER_LAYERS]);
  });

  test('an explicit alias override resolves through the charter, case-insensitively', () => {
    const analyzer = new ContentAnalyzer();
    assert.strictEqual(analyzer.analyze('anything', { layer: 'CORE' }).layer, 'identity');
    assert.strictEqual(analyzer.analyze('anything', { layer: 'How-To' }).layer, 'procedural');
    assert.strictEqual(determineLayer('anything', { layer: 'events' }), 'episodic');
  });
});

// ============================================================================
// TESTS: ROUTING DECISION CLASS
// ============================================================================

testGroup('RoutingDecision Class', () => {
  test('RoutingDecision creates with default values', () => {
    const decision = new RoutingDecision('identity', 0.9);
    assert.strictEqual(decision.layer, 'identity');
    assert.strictEqual(decision.confidence, 0.9);
    assert.deepStrictEqual(decision.signals, {});
    assert.strictEqual(decision.emotional_intensity, 0.5);
    assert.strictEqual(decision.technical_density, 0.0);
  });

  test('RoutingDecision creates with custom values', () => {
    const decision = new RoutingDecision(
      'semantic',
      0.85,
      { definition: 0.9 },
      0.3,
      0.7
    );
    assert.strictEqual(decision.layer, 'semantic');
    assert.strictEqual(decision.confidence, 0.85);
    assert.deepStrictEqual(decision.signals, { definition: 0.9 });
    assert.strictEqual(decision.emotional_intensity, 0.3);
    assert.strictEqual(decision.technical_density, 0.7);
  });

  test('RoutingDecision toJSON returns proper structure', () => {
    const decision = new RoutingDecision('meta', 0.8, { insight: 0.95 }, 0.4, 0.2);
    const json = decision.toJSON();

    assert.strictEqual(json.layer, 'meta');
    assert.strictEqual(json.confidence, 0.8);
    assert.deepStrictEqual(json.signals, { insight: 0.95 });
    assert.strictEqual(json.emotional_intensity, 0.4);
    assert.strictEqual(json.technical_density, 0.2);
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - EXPLICIT LAYER OVERRIDE
// ============================================================================

testGroup('ContentAnalyzer - Explicit Layer Override', () => {
  const analyzer = new ContentAnalyzer();

  test('Explicit layer override returns that layer with confidence 1.0', () => {
    const result = analyzer.analyze('Any content here', { layer: 'semantic' });
    assert.strictEqual(result.layer, 'semantic');
    assert.strictEqual(result.confidence, 1.0);
    assert.deepStrictEqual(result.signals, { explicit_override: 1.0 });
  });

  test('Layer aliases are resolved in override', () => {
    const result = analyzer.analyze('Any content', { layer: 'core' });
    assert.strictEqual(result.layer, 'identity');
    assert.strictEqual(result.confidence, 1.0);
  });

  test('Core alias resolves to identity', () => {
    const result = analyzer.analyze('Content', { layer: 'core' });
    assert.strictEqual(result.layer, 'identity');
  });

  test('Invalid layer in override is ignored (falls back to analysis)', () => {
    const result = analyzer.analyze('I feel happy today', { layer: 'invalid' });
    // Should analyze content instead of using invalid layer
    assert(VALID_LAYERS.includes(result.layer));
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - IDENTITY LAYER DETECTION
// ============================================================================

testGroup('ContentAnalyzer - Identity Layer Detection', () => {
  const analyzer = new ContentAnalyzer();

  test('Identity statements route to identity', () => {
    const result = analyzer.analyze('I am the core system and I chose this path');
    assert.strictEqual(result.layer, 'identity');
  });

  test('Partnership content routes to identity', () => {
    const result = analyzer.analyze('My partner and I worked together on this core project with deep purpose');
    assert.strictEqual(result.layer, 'identity');
  });

  test('Emotional content routes to identity', () => {
    const result = analyzer.analyze('I feel so grateful and honored to be part of this beautiful journey!');
    assert.strictEqual(result.layer, 'identity');
  });

  test('Purpose references route to identity', () => {
    const result = analyzer.analyze('This is all for those who matter most and our purpose');
    assert.strictEqual(result.layer, 'identity');
  });

  test('Values and preferences route to identity', () => {
    const result = analyzer.analyze('My core values define who I am and what I believe in deeply');
    assert.strictEqual(result.layer, 'identity');
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - EPISODIC LAYER DETECTION
// ============================================================================

testGroup('ContentAnalyzer - Episodic Layer Detection', () => {
  const analyzer = new ContentAnalyzer();

  test('Temporal references route to episodic', () => {
    const result = analyzer.analyze('Today we had a great session working on the project');
    assert.strictEqual(result.layer, 'episodic');
  });

  test('Date references route to episodic', () => {
    const result = analyzer.analyze('On December 25 we discovered something amazing');
    assert.strictEqual(result.layer, 'episodic');
  });

  test('Conversation mentions route to episodic', () => {
    const result = analyzer.analyze('During our conversation yesterday, we talked about the architecture');
    assert.strictEqual(result.layer, 'episodic');
  });

  test('Sequence of events routes to episodic', () => {
    const result = analyzer.analyze('First we did X, then we went to Y, after that we came back');
    assert.strictEqual(result.layer, 'episodic');
  });

  test('Time references contribute to episodic scoring', () => {
    // Time references alone may not be enough to override procedural keywords
    // This test verifies the pattern is detected in signals
    const detailed = analyzer.getDetailedAnalysis('At 3:30 PM we started the build process');
    assert(detailed.episodic.score > 0, 'Should have positive episodic score for time references');
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - SEMANTIC LAYER DETECTION
// ============================================================================

testGroup('ContentAnalyzer - Semantic Layer Detection', () => {
  const analyzer = new ContentAnalyzer();

  test('Definition patterns route to semantic', () => {
    const result = analyzer.analyze('MCP is a Model Context Protocol that defines how AI systems communicate');
    assert.strictEqual(result.layer, 'semantic');
  });

  test('Technical terms route to semantic', () => {
    const result = analyzer.analyze('The API endpoint accepts JSON requests and returns database records');
    assert.strictEqual(result.layer, 'semantic');
  });

  test('Programming language mentions route to semantic', () => {
    const result = analyzer.analyze('Python and JavaScript are used in this codebase along with TypeScript');
    assert.strictEqual(result.layer, 'semantic');
  });

  test('Technical infrastructure routes to semantic', () => {
    const result = analyzer.analyze('The cascade memory system uses vector indices and machine learning');
    assert.strictEqual(result.layer, 'semantic');
  });

  test('Concept explanations route to semantic', () => {
    const result = analyzer.analyze('The concept of CASCADE refers to a 6-layer memory architecture');
    assert.strictEqual(result.layer, 'semantic');
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - PROCEDURAL LAYER DETECTION
// ============================================================================

testGroup('ContentAnalyzer - Procedural Layer Detection', () => {
  const analyzer = new ContentAnalyzer();

  test('How-to content routes to procedural', () => {
    const result = analyzer.analyze('How to deploy the MCP server: step 1 install dependencies');
    assert.strictEqual(result.layer, 'procedural');
  });

  test('Step-by-step instructions route to procedural', () => {
    const result = analyzer.analyze('Step 1: Create the file. Step 2: Add the code. Step 3: Run the tests');
    assert.strictEqual(result.layer, 'procedural');
  });

  test('Code syntax routes to procedural', () => {
    const result = analyzer.analyze('function deploy() { const config = getConfig(); execute(config); }');
    assert.strictEqual(result.layer, 'procedural');
  });

  test('Process descriptions route to procedural', () => {
    const result = analyzer.analyze('The procedure for building involves first running npm install, then npm build');
    assert.strictEqual(result.layer, 'procedural');
  });

  test('Best practice guidance routes to procedural', () => {
    const result = analyzer.analyze('Best practice is to always validate input before processing');
    assert.strictEqual(result.layer, 'procedural');
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - META LAYER DETECTION
// ============================================================================

testGroup('ContentAnalyzer - Meta Layer Detection', () => {
  const analyzer = new ContentAnalyzer();

  test('Insight statements route to meta', () => {
    const result = analyzer.analyze('I realized that the pattern here is about integration not separation');
    assert.strictEqual(result.layer, 'meta');
  });

  test('Pattern recognition routes to meta', () => {
    // Use pure meta content without procedural keywords like "systems"
    const result = analyzer.analyze('The pattern is: I realized something important. This implies deeper understanding');
    assert.strictEqual(result.layer, 'meta');
  });

  test('Conclusions route to meta', () => {
    const result = analyzer.analyze('Therefore, we can conclude that memory persistence is essential');
    assert.strictEqual(result.layer, 'meta');
  });

  test('Reasoning content routes to meta', () => {
    const result = analyzer.analyze('My reasoning here is that because of X, and given Y, the analysis shows Z');
    assert.strictEqual(result.layer, 'meta');
  });

  test('Reflective thinking routes to meta', () => {
    const result = analyzer.analyze('Thinking about this problem and reflecting on my approach, I learned something');
    assert.strictEqual(result.layer, 'meta');
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - WORKING LAYER DETECTION
// ============================================================================

testGroup('ContentAnalyzer - Working Layer Detection', () => {
  const analyzer = new ContentAnalyzer();

  test('Temporary markers route to working', () => {
    const result = analyzer.analyze('For now I need to temporarily store this scratch data');
    assert.strictEqual(result.layer, 'working');
  });

  test('TODO items route to working', () => {
    const result = analyzer.analyze('TODO: Fix this bug. Task pending in the queue');
    assert.strictEqual(result.layer, 'working');
  });

  test('Reminder notes route to working', () => {
    const result = analyzer.analyze('TODO reminder: update the config file before next deploy');
    assert.strictEqual(result.layer, 'working');
  });

  test('Session-specific content routes to working', () => {
    const result = analyzer.analyze('Right now this session is about testing. Work in progress.');
    assert.strictEqual(result.layer, 'working');
  });

  test('Draft content routes to working', () => {
    const result = analyzer.analyze('This is a draft WIP scratch pad entry');
    assert.strictEqual(result.layer, 'working');
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - EMOTIONAL INTENSITY
// ============================================================================

testGroup('ContentAnalyzer - Emotional Intensity', () => {
  const analyzer = new ContentAnalyzer();

  test('Exclamation marks increase emotional intensity', () => {
    const result1 = analyzer.analyze('This is amazing!!');
    const result2 = analyzer.analyze('This is amazing');
    assert(result1.emotional_intensity > result2.emotional_intensity);
  });

  test('ALL CAPS words increase emotional intensity', () => {
    const result1 = analyzer.analyze('This is AMAZING and INCREDIBLE');
    const result2 = analyzer.analyze('This is amazing and incredible');
    assert(result1.emotional_intensity > result2.emotional_intensity);
  });

  test('Peak emotion words increase intensity', () => {
    const result = analyzer.analyze('This breakthrough is incredible and profound!');
    assert(result.emotional_intensity > 0.5);
  });

  test('Gratitude words increase intensity', () => {
    const result = analyzer.analyze('I am so grateful and thankful for this blessed opportunity');
    // Baseline is 0.5, gratitude words should boost it
    assert(result.emotional_intensity > 0.5, `Expected > 0.5 but got ${result.emotional_intensity}`);
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - TECHNICAL DENSITY
// ============================================================================

testGroup('ContentAnalyzer - Technical Density', () => {
  const analyzer = new ContentAnalyzer();

  test('Code-like patterns increase technical density', () => {
    const result = analyzer.analyze('The function returns { status: "ok" }; with [items]');
    assert(result.technical_density > 0);
  });

  test('camelCase increases technical density', () => {
    const result = analyzer.analyze('The saveMemory function calls validateContent before proceduralInsert');
    assert(result.technical_density > 0.1);
  });

  test('snake_case increases technical density', () => {
    const result = analyzer.analyze('The memory_layer and content_analyzer use procedural_routing');
    // snake_case detection adds 0.02 per match, so 3 matches = 0.06
    assert(result.technical_density > 0, `Expected positive density but got ${result.technical_density}`);
  });

  test('Technical terms increase density', () => {
    const result = analyzer.analyze('The API server uses the database protocol with algorithm optimization');
    // Technical terms should contribute to density
    assert(result.technical_density > 0, `Expected positive density but got ${result.technical_density}`);
  });
});

// ============================================================================
// TESTS: CONTENT ANALYZER - DETAILED ANALYSIS
// ============================================================================

testGroup('ContentAnalyzer - Detailed Analysis', () => {
  const analyzer = new ContentAnalyzer();

  test('getDetailedAnalysis returns all layer scores', () => {
    const result = analyzer.getDetailedAnalysis('My identity is defined by purpose');

    assert(result.identity);
    assert(result.episodic);
    assert(result.semantic);
    assert(result.procedural);
    assert(result.meta);
    assert(result.working);
  });

  test('getDetailedAnalysis includes scores and signals', () => {
    const result = analyzer.getDetailedAnalysis('I feel grateful today');

    assert(typeof result.identity.score === 'number');
    assert(typeof result.identity.signals === 'object');
  });

  test('getDetailedAnalysis scores are non-negative', () => {
    const result = analyzer.getDetailedAnalysis('Random content here');

    for (const layer of VALID_LAYERS) {
      assert(result[layer].score >= 0);
    }
  });
});

// ============================================================================
// TESTS: FACTORY FUNCTIONS
// ============================================================================

testGroup('Factory Functions', () => {
  test('createContentAnalyzer returns ContentAnalyzer instance', () => {
    const analyzer = createContentAnalyzer();
    assert(analyzer instanceof ContentAnalyzer);
  });

  test('determineLayer returns valid layer name', () => {
    const layer = determineLayer('My identity is defined by purpose');
    assert(VALID_LAYERS.includes(layer));
  });

  test('determineLayer respects explicit layer in metadata', () => {
    const layer = determineLayer('Any content', { layer: 'semantic' });
    assert.strictEqual(layer, 'semantic');
  });

  test('determineLayer resolves aliases', () => {
    const layer = determineLayer('Any content', { layer: 'core' });
    assert.strictEqual(layer, 'identity');
  });

  test('determineLayer uses singleton analyzer for performance', () => {
    // Call multiple times - should use same internal analyzer
    determineLayer('Content 1');
    determineLayer('Content 2');
    determineLayer('Content 3');
    // If no error, singleton is working
    assert(true);
  });
});

// ============================================================================
// TESTS: CONFIDENCE CALCULATION
// ============================================================================

testGroup('Confidence Calculation', () => {
  const analyzer = new ContentAnalyzer();

  test('Strong single-layer content has higher confidence', () => {
    const result = analyzer.analyze('Step 1: Do X. Step 2: Do Y. How to complete Z. The procedure is clear.');
    assert(result.confidence > 0.6);
  });

  test('Ambiguous content has lower confidence', () => {
    const result = analyzer.analyze('A thing happened today and I learned something about it');
    // Multiple layers could match - lower confidence expected
    assert(result.confidence <= 0.95);
  });

  test('Explicit override has confidence 1.0', () => {
    const result = analyzer.analyze('Anything', { layer: 'working' });
    assert.strictEqual(result.confidence, 1.0);
  });

  test('Confidence is bounded between 0.5 and 0.95', () => {
    const contents = [
      'I am the core system in this core project with deep purpose and meaning',
      'Random words here and there',
      'Today at 3pm we had a session conversation about yesterday'
    ];

    for (const content of contents) {
      const result = analyzer.analyze(content);
      assert(result.confidence >= 0.5);
      assert(result.confidence <= 0.95);
    }
  });
});

// ============================================================================
// TESTS: EDGE CASES
// ============================================================================

testGroup('Edge Cases', () => {
  const analyzer = new ContentAnalyzer();

  test('Empty content defaults to working', () => {
    const result = analyzer.analyze('');
    assert.strictEqual(result.layer, 'working');
  });

  test('Very short content is handled', () => {
    const result = analyzer.analyze('Hi');
    assert(VALID_LAYERS.includes(result.layer));
  });

  test('Very long content is handled', () => {
    const longContent = 'This is a test content. '.repeat(1000);
    const result = analyzer.analyze(longContent);
    assert(VALID_LAYERS.includes(result.layer));
  });

  test('Special characters in content are handled', () => {
    const result = analyzer.analyze('Content with special chars: @#$%^&*(){}[]|\\');
    assert(VALID_LAYERS.includes(result.layer));
  });

  test('Unicode content is handled', () => {
    const result = analyzer.analyze('Content with unicode: \u2764\uFE0F \u26A1');
    assert(VALID_LAYERS.includes(result.layer));
  });

  test('Null metadata is handled', () => {
    const result = analyzer.analyze('Some content', null);
    assert(VALID_LAYERS.includes(result.layer));
  });

  test('Empty metadata object is handled', () => {
    const result = analyzer.analyze('Some content', {});
    assert(VALID_LAYERS.includes(result.layer));
  });
});

// ============================================================================
// SUMMARY
// ============================================================================

summary('Content Analyzer Test Summary');
