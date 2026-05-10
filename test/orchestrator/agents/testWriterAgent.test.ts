import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { inferSpecFile } from '../../../src/orchestrator/agents/testWriterAgent.js';
import type { TestCase } from '../../../src/orchestrator/testCase.js';

/**
 * Resolution order (first match wins):
 *   1. Explicit tc.specFile on the test case JSON.
 *   2. User-defined patterns from qa-agent.config.json#specFileNaming.
 *   3. Built-in SPEC_KEYWORDS defaults.
 *   4. Fallback: 'general'.
 *
 * These tests pin each layer.
 */

function tc(overrides: Partial<TestCase>): TestCase {
  return {
    title: 'sample test',
    steps: ['do thing'],
    expected: 'thing happened',
    localeScope: 'generic',
    ...overrides,
  };
}

describe('inferSpecFile — explicit override (layer 1)', () => {
  test('tc.specFile wins over every other rule', () => {
    const result = inferSpecFile(
      tc({ title: 'user can log in with valid credentials', specFile: 'tests/custom/myfile.spec.ts' }),
      null,
      [{ pattern: 'log.?in', spec: 'auth' }],
    );
    assert.equal(result, 'tests/custom/myfile.spec.ts');
  });
});

describe('inferSpecFile — user-defined patterns (layer 2)', () => {
  test('user pattern matches and wins over built-in default', () => {
    // Title contains "dashboard" — built-in default routes this to 'home.spec.ts'
    // because the default pattern is /home|landing|hero|dashboard/.
    // User pattern should override and route to 'dashboard.spec.ts'.
    const result = inferSpecFile(
      tc({ title: 'user views the sales dashboard' }),
      null,
      [{ pattern: 'dashboard|metric|kpi|report', spec: 'dashboard' }],
    );
    assert.equal(result, 'tests/generic/dashboard.spec.ts');
  });

  test('user patterns are checked in order — first match wins', () => {
    const result = inferSpecFile(
      tc({ title: 'admin views coupon dashboard' }),
      null,
      [
        { pattern: 'coupon|promo', spec: 'promotions' },
        { pattern: 'dashboard', spec: 'dashboard' },
      ],
    );
    assert.equal(result, 'tests/generic/promotions.spec.ts');
  });

  test('user pattern with no match falls through to defaults', () => {
    const result = inferSpecFile(
      tc({ title: 'user can log in with valid credentials' }),
      null,
      [{ pattern: 'dashboard|metric', spec: 'dashboard' }],
    );
    // User pattern doesn't match "log in" — built-in /log.?in/ default kicks in.
    assert.equal(result, 'tests/generic/auth.spec.ts');
  });

  test('user pattern is case-insensitive', () => {
    const result = inferSpecFile(
      tc({ title: 'Admin views the COUPON management page' }),
      null,
      [{ pattern: 'coupon', spec: 'promotions' }],
    );
    assert.equal(result, 'tests/generic/promotions.spec.ts');
  });
});

describe('inferSpecFile — built-in defaults (layer 3)', () => {
  test('login title routes to auth.spec.ts', () => {
    const result = inferSpecFile(tc({ title: 'user can log in with valid credentials' }), null);
    assert.equal(result, 'tests/generic/auth.spec.ts');
  });

  test('cart title routes to cart.spec.ts', () => {
    const result = inferSpecFile(tc({ title: 'user can add a product to cart' }), null);
    assert.equal(result, 'tests/generic/cart.spec.ts');
  });

  test('checkout title routes to checkout.spec.ts', () => {
    const result = inferSpecFile(tc({ title: 'user can complete checkout' }), null);
    assert.equal(result, 'tests/generic/checkout.spec.ts');
  });

  test('dashboard title routes to home.spec.ts (the bundled default)', () => {
    // Documents the current default behavior. Override via specFileNaming if needed.
    const result = inferSpecFile(tc({ title: 'user views the sales dashboard' }), null);
    assert.equal(result, 'tests/generic/home.spec.ts');
  });
});

describe('inferSpecFile — fallback (layer 4)', () => {
  test('title with no matching pattern falls back to general.spec.ts', () => {
    const result = inferSpecFile(tc({ title: 'something completely unrelated' }), null);
    assert.equal(result, 'tests/generic/general.spec.ts');
  });
});

describe('inferSpecFile — locale prefix', () => {
  test('locale routes test under tests/locales/<locale>/', () => {
    const result = inferSpecFile(tc({ title: 'user can log in' }), 'en-gb');
    assert.equal(result, 'tests/locales/en-gb/auth.spec.ts');
  });

  test('locale + user pattern combine correctly', () => {
    const result = inferSpecFile(
      tc({ title: 'admin views dashboard' }),
      'es-pr',
      [{ pattern: 'dashboard', spec: 'dashboard' }],
    );
    assert.equal(result, 'tests/locales/es-pr/dashboard.spec.ts');
  });
});
