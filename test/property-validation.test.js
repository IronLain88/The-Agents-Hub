import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureV2, isValidV2Property, migratePropertyV1toV2 } from '../src/lib/property-validation.js';

describe('Property Validation', () => {
  describe('isValidV2Property', () => {
    it('should validate a valid v2 property', () => {
      const property = {
        version: 2,
        width: 24,
        height: 32,
        floor: [],
        assets: []
      };
      assert.equal(isValidV2Property(property), true);
    });

    it('should reject property without version', () => {
      const property = {
        width: 24,
        height: 32,
        assets: []
      };
      assert.equal(isValidV2Property(property), false);
    });

    it('should reject property with wrong version', () => {
      const property = {
        version: 1,
        width: 24,
        height: 32,
        assets: []
      };
      assert.equal(isValidV2Property(property), false);
    });

    it('should reject property without width', () => {
      const property = {
        version: 2,
        height: 32,
        assets: []
      };
      assert.equal(isValidV2Property(property), false);
    });

    it('should reject property without height', () => {
      const property = {
        version: 2,
        width: 24,
        assets: []
      };
      assert.equal(isValidV2Property(property), false);
    });

    it('should reject property without assets array', () => {
      const property = {
        version: 2,
        width: 24,
        height: 32
      };
      assert.equal(isValidV2Property(property), false);
    });

    it('should reject property with assets as non-array', () => {
      const property = {
        version: 2,
        width: 24,
        height: 32,
        assets: {}
      };
      assert.equal(isValidV2Property(property), false);
    });

    it('should reject null', () => {
      assert.equal(isValidV2Property(null), false);
    });

    it('should reject undefined', () => {
      assert.equal(isValidV2Property(undefined), false);
    });
  });

  describe('ensureV2', () => {
    it('should return valid v2 property as-is', () => {
      const property = {
        version: 2,
        width: 24,
        height: 32,
        floor: [],
        assets: []
      };
      const result = ensureV2(property);
      assert.deepEqual(result, property);
    });

    it('should return null for invalid property', () => {
      const property = { invalid: 'data' };
      const result = ensureV2(property);
      assert.equal(result, null);
    });

    it('should return null for null input', () => {
      const result = ensureV2(null);
      assert.equal(result, null);
    });

    it('should return null for undefined input', () => {
      const result = ensureV2(undefined);
      assert.equal(result, null);
    });

    it('should migrate v1 property with ground field', () => {
      const v1Property = {
        ground: [[0, 0], [1, 0]],
        width: 20,
        height: 30,
        stations: [],
        objects: []
      };
      const result = ensureV2(v1Property);
      assert.equal(result.version, 2);
      assert.equal(result.width, 20);
      assert.equal(result.height, 30);
      assert.ok(Array.isArray(result.assets));
    });

    it('should migrate v1 property with objects field', () => {
      const v1Property = {
        objects: [{ x: 5, y: 5, src: 'interiors', ax: 0, ay: 0 }],
        width: 20,
        height: 30
      };
      const result = ensureV2(v1Property);
      assert.equal(result.version, 2);
      assert.ok(Array.isArray(result.assets));
      assert.equal(result.assets.length, 1);
    });
  });

  describe('migratePropertyV1toV2', () => {
    it('should migrate empty v1 property', () => {
      const v1 = {
        width: 20,
        height: 30,
        ground: [],
        stations: [],
        objects: []
      };
      const result = migratePropertyV1toV2(v1);
      assert.equal(result.version, 2);
      assert.equal(result.width, 20);
      assert.equal(result.height, 30);
      assert.deepEqual(result.floor, []);
      assert.deepEqual(result.assets, []);
    });

    it('should use default dimensions when not specified', () => {
      const v1 = {};
      const result = migratePropertyV1toV2(v1);
      assert.equal(result.version, 2);
      assert.equal(result.width, 24);
      assert.equal(result.height, 32);
    });

    it('should migrate stations to assets', () => {
      const v1 = {
        stations: [
          { x: 5, y: 10, state: 'writing_code', w: 2, h: 1 }
        ],
        objects: []
      };
      const result = migratePropertyV1toV2(v1);
      assert.equal(result.assets.length, 1);
      assert.equal(result.assets[0].station, 'writing_code');
      assert.equal(result.assets[0].position.x, 5);
      assert.equal(result.assets[0].position.y, 10);
      assert.equal(result.assets[0].collision, true);
    });

    it('should migrate objects to assets', () => {
      const v1 = {
        objects: [
          { x: 3, y: 4, src: 'interiors', ax: 1, ay: 2 }
        ]
      };
      const result = migratePropertyV1toV2(v1);
      assert.equal(result.assets.length, 1);
      assert.equal(result.assets[0].sprite.tileset, 'interiors');
      assert.equal(result.assets[0].sprite.tx, 1);
      assert.equal(result.assets[0].sprite.ty, 2);
      assert.equal(result.assets[0].collision, false);
    });

    it('should migrate animated objects to assets', () => {
      const v1 = {
        animated: [
          { x: 7, y: 8, file: 'fire.png', w: 2 }
        ]
      };
      const result = migratePropertyV1toV2(v1);
      assert.equal(result.assets.length, 1);
      assert.equal(result.assets[0].sprite.file, 'fire.png');
      assert.equal(result.assets[0].sprite.width, 2);
    });

    it('should preserve residents field', () => {
      const v1 = {
        residents: ['claude', 'alice']
      };
      const result = migratePropertyV1toV2(v1);
      assert.deepEqual(result.residents, ['claude', 'alice']);
    });

    it('should skip objects that overlap with stations', () => {
      const v1 = {
        stations: [
          { x: 5, y: 5, state: 'reading', w: 2, h: 2 }
        ],
        objects: [
          { x: 5, y: 5, src: 'interiors', ax: 0, ay: 0 }, // Overlaps station
          { x: 10, y: 10, src: 'interiors', ax: 1, ay: 1 } // Doesn't overlap
        ]
      };
      const result = migratePropertyV1toV2(v1);
      // Should have 1 station asset + 1 object asset (second one that doesn't overlap)
      assert.equal(result.assets.length, 2);
    });
  });
});
