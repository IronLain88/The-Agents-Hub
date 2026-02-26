import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBreadcrumb, applyBreadcrumb, applyNote } from '../src/lib/station-log.js';

describe('Station Log', () => {
  describe('formatBreadcrumb', () => {
    it('should format with provided timestamp', () => {
      assert.equal(formatBreadcrumb('Reading auth', '10:30 AM'), '10:30 AM - Reading auth');
    });

    it('should format with auto timestamp', () => {
      const result = formatBreadcrumb('Writing code');
      assert.match(result, /^\d{2}:\d{2}\s[AP]M - Writing code$/);
    });
  });

  describe('applyBreadcrumb', () => {
    it('should append to empty log', () => {
      const result = applyBreadcrumb('', '10:00 AM - First entry');
      assert.equal(result, '10:00 AM - First entry');
    });

    it('should append to existing log', () => {
      const result = applyBreadcrumb('10:00 AM - First', '10:01 AM - Second');
      assert.equal(result, '10:00 AM - First\n10:01 AM - Second');
    });

    it('should enforce rolling window of 15', () => {
      const lines = Array.from({ length: 16 }, (_, i) => `line ${i}`).join('\n');
      const result = applyBreadcrumb(lines, 'new line');
      const breadcrumbs = result.split('\n');
      assert.equal(breadcrumbs.length, 15);
      assert.equal(breadcrumbs[breadcrumbs.length - 1], 'new line');
      assert.equal(breadcrumbs[0], 'line 2'); // line 0 and line 1 trimmed
    });

    it('should preserve notes section', () => {
      const log = '10:00 AM - Entry\n---\nNote: something important';
      const result = applyBreadcrumb(log, '10:01 AM - New entry');
      assert.ok(result.includes('---'));
      assert.ok(result.includes('Note: something important'));
      assert.ok(result.includes('10:01 AM - New entry'));
    });
  });

  describe('applyNote', () => {
    it('should add note with separator to empty log', () => {
      const result = applyNote('', 'Found a bug');
      assert.equal(result, '---\nNote: Found a bug');
    });

    it('should add note to log with existing breadcrumbs', () => {
      const result = applyNote('10:00 AM - Entry', 'Important finding');
      assert.equal(result, '10:00 AM - Entry\n---\nNote: Important finding');
    });

    it('should append to existing notes', () => {
      const log = '10:00 AM - Entry\n---\nNote: First note';
      const result = applyNote(log, 'Second note');
      assert.ok(result.includes('Note: First note'));
      assert.ok(result.includes('Note: Second note'));
    });
  });
});
