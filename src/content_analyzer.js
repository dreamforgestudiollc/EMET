/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Derived from CASCADE Memory System
 * Copyright (c) 2025-2026 CIPS Corp (C.I.P.S. LLC)
 * Licensed under the MIT License - see LICENSE
 *
 * https://github.com/For-Sunny/cascade-memory-enterprise
 *
 * Content Analyzer - Layer routing with <1ms analysis time.
 *
 * Supports configurable pattern-based routing across 6 memory layers.
 */

import {
  LAYERS,
  LAYER_ALIASES as CHARTER_ALIASES,
  FALLBACK_LAYER,
  resolveLayer
} from './layers.js';

/**
 * Layer aliases - maps alternative names to canonical layer names.
 * Kept exported for backward compatibility; DERIVED from the layer charter
 * (src/layers.js), which is the one place an alias is declared (B6, 2026-09-07).
 */
const LAYER_ALIASES = { ...CHARTER_ALIASES };

/**
 * Valid layer names - derived from the charter so there is one layer list.
 */
const VALID_LAYERS = [...LAYERS];

/**
 * Routing decision result
 */
class RoutingDecision {
  constructor(layer, confidence, signals = {}, emotionalIntensity = 0.5, technicalDensity = 0.0) {
    this.layer = layer;
    this.confidence = confidence;
    this.signals = signals;
    this.emotional_intensity = emotionalIntensity;
    this.technical_density = technicalDensity;
  }

  toJSON() {
    return {
      layer: this.layer,
      confidence: this.confidence,
      signals: this.signals,
      emotional_intensity: this.emotional_intensity,
      technical_density: this.technical_density
    };
  }
}

/**
 * ContentAnalyzer - Analyzes content to determine EMET layer routing
 * Pattern-based routing with configurable signal detection.
 */
class ContentAnalyzer {
  constructor() {
    this._compilePatterns();
  }

  /**
   * Pre-compile all regex patterns for speed
   */
  _compilePatterns() {
    // ================================================================
    // IDENTITY LAYER PATTERNS (identity, emotional, core values)
    // Routes content related to identity and deep significance
    // ================================================================
    this.identityPatterns = [
      // Identity statements
      [/\b(i am|i'm|we are|we're|my name is)\b/gi, 1.0, "identity_statement"],
      [/\b(my identity|our identity|who i am|self|personhood)\b/gi, 0.95, "identity_concept"],
      [/\b(i feel|feeling|emotion|emotional|heart|love|passion)\b/gi, 0.9, "emotional_content"],

      // Relationship and collaboration signals
      [/\b(partner|partnership|collaboration|team|bond)\b/gi, 0.9, "partnership"],
      [/\b(we together|you and i|our work|our bond|together)\b/gi, 0.85, "partnership_bond"],

      // Core identity terms
      [/\b(purpose|mission|values|principles|beliefs)\b/gi, 0.9, "core_identity"],

      // High emotional intensity markers
      [/[!]{2,}|[?!]+/g, 0.6, "emotional_punctuation"],
      [/\b(breakthrough|amazing|incredible|profound|beautiful|sacred)\b/gi, 0.8, "peak_emotion"],
      [/\b(grateful|gratitude|thankful|blessed|honored)\b/gi, 0.85, "gratitude"],
    ];

    // ================================================================
    // EPISODIC LAYER PATTERNS (events, conversations, temporal)
    // ================================================================
    this.episodicPatterns = [
      // Temporal references
      [/\b(today|yesterday|last night|this morning|earlier)\b/gi, 0.9, "temporal_recent"],
      [/\b(happened|occurred|took place|went|came)\b/gi, 0.85, "event_verb"],
      [/\b(session|conversation|discussion|chat|talked)\b/gi, 0.8, "conversation"],

      // Event markers
      [/\b(we did|we made|we built|we created|we discovered)\b/gi, 0.85, "collaborative_event"],
      [/\b(then|after that|next|following|subsequently)\b/gi, 0.7, "sequence"],
      [/\b(december|november|october|january|february|march|april|may|june|july|august|september|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, 0.8, "date_reference"],

      // Timestamps
      [/\b\d{1,2}:\d{2}(?:\s*(?:am|pm))?\b/gi, 0.75, "time_reference"],
      [/\b\d{4}-\d{2}-\d{2}\b/g, 0.85, "iso_date"],

      // Milestone and achievement events
      [/\b(milestone|achievement|mission|victory|launch)\b/gi, 0.8, "milestone_event"],
    ];

    // ================================================================
    // SEMANTIC LAYER PATTERNS (facts, definitions, concepts)
    // ================================================================
    this.semanticPatterns = [
      // Definition markers
      [/\b(is a|is the|means|refers to|defined as|definition)\b/gi, 0.9, "definition"],
      [/\b(concept|theory|principle|framework|model|paradigm)\b/gi, 0.85, "concept"],
      [/\b(fact|factual|factually|true|truth|actually)\b/gi, 0.8, "factual"],

      // Technical knowledge
      [/\b(api|database|server|client|protocol|algorithm)\b/gi, 0.75, "technical_term"],
      [/\b(python|javascript|typescript|rust|go|sql|node\.js)\b/gi, 0.8, "programming_language"],
      [/\b(vector|embedding|gpu|cuda|cache|index)\b/gi, 0.85, "infrastructure_technical"],
      [/\b(neural|graph|network|layer|node|edge)\b/gi, 0.85, "advanced_technical"],

      // Knowledge markers
      [/\b(known as|understood as|recognized as|classified as)\b/gi, 0.8, "classification"],
      [/\b(consists of|comprises|includes|contains|incorporates)\b/gi, 0.75, "composition"],
    ];

    // ================================================================
    // PROCEDURAL LAYER PATTERNS (how-to, processes, code)
    // ================================================================
    this.proceduralPatterns = [
      // How-to markers
      [/\b(how to|to do|in order to|steps to|process for)\b/gi, 0.95, "how_to"],
      [/\b(step \d|first|second|third|then|next|finally)\b/gi, 0.8, "sequence_step"],
      [/\b(procedure|workflow|process|method|approach)\b/gi, 0.85, "process"],

      // Code patterns
      [/\b(function|def |class |import |from |const |let |var )\b/gi, 0.9, "code_syntax"],
      [/\b(run|execute|invoke|call|trigger|activate)\b/gi, 0.7, "execution_verb"],
      [/\b(create|build|implement|deploy|configure|setup)\b/gi, 0.75, "construction_verb"],

      // Skill markers
      [/\b(skill|technique|practice|pattern|idiom)\b/gi, 0.8, "skill"],
      [/\b(best practice|recommended|should|must|always|never)\b/gi, 0.75, "guidance"],
    ];

    // ================================================================
    // META LAYER PATTERNS (reasoning, insights, conclusions)
    // ================================================================
    this.metaPatterns = [
      // Insight markers
      [/\b(i realized|i noticed|i observed|i discovered|insight)\b/gi, 0.95, "insight"],
      [/\b(the pattern is|pattern:|this means|implies that)\b/gi, 0.9, "pattern_recognition"],
      [/\b(conclusion|therefore|thus|hence|consequently)\b/gi, 0.85, "conclusion"],

      // Reasoning markers
      [/\b(because|since|given that|considering|reasoning)\b/gi, 0.8, "reasoning"],
      [/\b(analysis|analyzing|examined|examining|reflects)\b/gi, 0.8, "analysis"],
      [/\b(learned|learning|lesson|takeaway|understanding)\b/gi, 0.85, "learning"],

      // Meta-cognitive
      [/\b(thinking about|reflecting on|considering|pondering)\b/gi, 0.8, "metacognition"],
      [/\b(my thought|my reasoning|my approach|my strategy)\b/gi, 0.75, "self_analysis"],
    ];

    // ================================================================
    // WORKING LAYER PATTERNS (temporary, session-specific)
    // ================================================================
    this.workingPatterns = [
      // Temporary markers
      [/\b(for now|temporarily|current|currently|at the moment)\b/gi, 0.85, "temporal_now"],
      [/\b(todo|to-do|task|pending|queue|backlog)\b/gi, 0.8, "task"],
      [/\b(reminder|note to self|don't forget|remember to)\b/gi, 0.8, "reminder"],

      // Session markers
      [/\b(this session|right now|in progress|ongoing|active)\b/gi, 0.8, "session"],
      [/\b(scratch|draft|wip|work in progress|temp)\b/gi, 0.9, "draft"],
    ];
  }

  /**
   * Analyze content and determine the appropriate EMET layer.
   *
   * @param {string} content - The memory content to analyze
   * @param {Object} metadata - Optional metadata that may influence routing
   * @returns {RoutingDecision} - Routing decision with layer, confidence, and signals
   */
  analyze(content, metadata = {}) {
    // Handle explicit layer override
    if (metadata && metadata.layer) {
      // Resolve aliases (core -> identity, self -> identity, etc.) and
      // validate in one step, against the charter (src/layers.js).
      const explicitLayer = resolveLayer(metadata.layer);
      if (explicitLayer) {
        return new RoutingDecision(
          explicitLayer,
          1.0,
          { explicit_override: 1.0 }
        );
      }
    }

    // Score each layer
    const layerScores = {};

    // Identity layer scoring (identity and core values)
    const [identityScore, identitySignals] = this._scorePatterns(content, this.identityPatterns);
    layerScores.identity = { score: identityScore, signals: identitySignals };

    // Episodic scoring
    const [episodicScore, episodicSignals] = this._scorePatterns(content, this.episodicPatterns);
    layerScores.episodic = { score: episodicScore, signals: episodicSignals };

    // Semantic scoring
    const [semanticScore, semanticSignals] = this._scorePatterns(content, this.semanticPatterns);
    layerScores.semantic = { score: semanticScore, signals: semanticSignals };

    // Procedural scoring
    const [proceduralScore, proceduralSignals] = this._scorePatterns(content, this.proceduralPatterns);
    layerScores.procedural = { score: proceduralScore, signals: proceduralSignals };

    // Meta scoring
    const [metaScore, metaSignals] = this._scorePatterns(content, this.metaPatterns);
    layerScores.meta = { score: metaScore, signals: metaSignals };

    // Working scoring
    const [workingScore, workingSignals] = this._scorePatterns(content, this.workingPatterns);
    layerScores.working = { score: workingScore, signals: workingSignals };

    // Calculate emotional intensity
    const emotionalIntensity = this._calculateEmotionalIntensity(content, identitySignals);

    // Calculate technical density
    const technicalDensity = this._calculateTechnicalDensity(content, semanticSignals, proceduralSignals);

    // Apply emotional intensity boost to identity layer
    if (emotionalIntensity > 0.7) {
      const identityScoreAdjusted = layerScores.identity.score * (1 + emotionalIntensity * 0.5);
      layerScores.identity.score = identityScoreAdjusted;
    }

    // Apply technical density boost to semantic/procedural
    if (technicalDensity > 0.6) {
      // Boost semantic more for definitions, procedural more for how-tos
      const hasHowto = Object.keys(proceduralSignals).some(s => s.includes('how_to'));
      if (hasHowto) {
        const procScoreAdjusted = layerScores.procedural.score * (1 + technicalDensity * 0.3);
        layerScores.procedural.score = procScoreAdjusted;
      } else {
        const semScoreAdjusted = layerScores.semantic.score * (1 + technicalDensity * 0.3);
        layerScores.semantic.score = semScoreAdjusted;
      }
    }

    // Find winning layer
    let bestLayer = FALLBACK_LAYER;  // Default fallback, stated once in layers.js
    let bestScore = 0.0;
    let bestSignals = {};

    for (const [layer, data] of Object.entries(layerScores)) {
      if (data.score > bestScore) {
        bestScore = data.score;
        bestLayer = layer;
        bestSignals = data.signals;
      }
    }

    // Calculate confidence based on margin over second place
    const sortedScores = Object.values(layerScores)
      .map(d => d.score)
      .sort((a, b) => b - a);

    let confidence = 0.5;
    if (sortedScores.length >= 2 && sortedScores[0] > 0) {
      const margin = (sortedScores[0] - sortedScores[1]) / sortedScores[0];
      confidence = Math.min(0.95, 0.5 + margin * 0.5);
    }

    return new RoutingDecision(
      bestLayer,
      confidence,
      bestSignals,
      emotionalIntensity,
      technicalDensity
    );
  }

  /**
   * Score content against a list of patterns.
   *
   * @param {string} content - Content to score
   * @param {Array} patterns - Array of [regex, weight, signalName] tuples
   * @returns {Array} - [totalScore, signals] tuple
   */
  _scorePatterns(content, patterns) {
    let totalScore = 0.0;
    const signals = {};

    for (const [pattern, weight, signalName] of patterns) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;

      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        // Diminishing returns for multiple matches
        const matchScore = weight * (1 + 0.1 * Math.min(matches.length - 1, 5));
        totalScore += matchScore;
        signals[signalName] = matchScore;
      }
    }

    return [totalScore, signals];
  }

  /**
   * Calculate emotional intensity score (0-1).
   *
   * @param {string} content - Content to analyze
   * @param {Object} identitySignals - Signals from identity pattern matching
   * @returns {number} - Emotional intensity between 0 and 1
   */
  _calculateEmotionalIntensity(content, identitySignals) {
    let intensity = 0.5;  // Baseline

    // Boost from emotional signals
    const emotionalSignals = ["emotional_content", "peak_emotion", "gratitude", "emotional_punctuation"];
    for (const signal of emotionalSignals) {
      if (identitySignals[signal]) {
        intensity += 0.1;
      }
    }

    // Check for exclamation/question intensity
    const exclaimCount = (content.match(/!/g) || []).length;
    if (exclaimCount > 0) {
      intensity += Math.min(exclaimCount * 0.05, 0.2);
    }

    // Check for ALL CAPS words (emotional emphasis)
    const capsWords = content.match(/\b[A-Z]{3,}\b/g) || [];
    if (capsWords.length > 0) {
      intensity += Math.min(capsWords.length * 0.03, 0.15);
    }

    return Math.min(1.0, intensity);
  }

  /**
   * Calculate technical density score (0-1).
   *
   * @param {string} content - Content to analyze
   * @param {Object} semanticSignals - Signals from semantic pattern matching
   * @param {Object} proceduralSignals - Signals from procedural pattern matching
   * @returns {number} - Technical density between 0 and 1
   */
  _calculateTechnicalDensity(content, semanticSignals, proceduralSignals) {
    let density = 0.0;

    // Technical signals
    const techSignals = ["technical_term", "programming_language", "infrastructure_technical", "advanced_technical", "code_syntax"];
    for (const signal of techSignals) {
      if (semanticSignals[signal] || proceduralSignals[signal]) {
        density += 0.15;
      }
    }

    // Code-like patterns
    if (/[{}\[\]();]/.test(content)) {
      density += 0.1;
    }

    // camelCase or snake_case density
    const caseMatches = (content.match(/\b[a-z]+[A-Z][a-zA-Z]*\b|\b[a-z]+_[a-z_]+\b/g) || []).length;
    if (caseMatches > 0) {
      density += Math.min(caseMatches * 0.02, 0.2);
    }

    return Math.min(1.0, density);
  }

  /**
   * Get all layer scores for debugging/analysis
   *
   * @param {string} content - Content to analyze
   * @returns {Object} - All layer scores and signals
   */
  getDetailedAnalysis(content) {
    const analysis = {
      identity: this._scorePatterns(content, this.identityPatterns),
      episodic: this._scorePatterns(content, this.episodicPatterns),
      semantic: this._scorePatterns(content, this.semanticPatterns),
      procedural: this._scorePatterns(content, this.proceduralPatterns),
      meta: this._scorePatterns(content, this.metaPatterns),
      working: this._scorePatterns(content, this.workingPatterns)
    };

    const result = {};
    for (const [layer, [score, signals]] of Object.entries(analysis)) {
      result[layer] = { score, signals };
    }

    return result;
  }
}

/**
 * Factory function for creating ContentAnalyzer instance
 */
function createContentAnalyzer() {
  return new ContentAnalyzer();
}

/**
 * Simple determineLayer function for backward compatibility
 * Uses ContentAnalyzer internally but returns just the layer name
 *
 * @param {string} content - Content to analyze
 * @param {Object} metadata - Optional metadata with layer override
 * @returns {string} - Layer name
 */
function determineLayer(content, metadata = {}) {
  // Reuse singleton instance for performance
  if (!determineLayer._analyzer) {
    determineLayer._analyzer = new ContentAnalyzer();
  }

  const decision = determineLayer._analyzer.analyze(content, metadata);
  return decision.layer;
}

// Export for ES modules
export {
  ContentAnalyzer,
  RoutingDecision,
  createContentAnalyzer,
  determineLayer,
  LAYER_ALIASES,
  VALID_LAYERS
};

// Default export
export default ContentAnalyzer;
