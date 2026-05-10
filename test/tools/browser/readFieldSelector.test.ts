import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFieldSelector } from '../../../src/tools/browser/extractElements.js';

/**
 * readFieldSelector parses POM files to extract the selector string for a named
 * field. Used by config-driven setupFlows to resolve `{ pom, field }` step refs
 * into actual selectors at runtime.
 *
 * The regex must handle both quote styles:
 *   readonly checkoutButton = this.loc("[data-test='checkout']");   ← double outer, single inner
 *   readonly checkoutButton = this.loc('[data-test="checkout"]');   ← single outer, double inner
 *
 * The original `[^"']+` character class broke for any selector mixing quote
 * styles — it stopped at the first inner quote and returned null. Fixed in the
 * 2026-05-08 hardening pass to use alternation: (?:"([^"]+)"|'([^']+)').
 *
 * These tests pin the fix.
 */

async function setup(): Promise<{ repoRoot: string; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'qa-agent-readField-'));
  await mkdir(join(repoRoot, 'src', 'pages', 'common'), { recursive: true });
  return {
    repoRoot,
    cleanup: () => rm(repoRoot, { recursive: true, force: true }),
  };
}

async function writePom(repoRoot: string, pomName: string, body: string): Promise<void> {
  const filePath = join(repoRoot, 'src', 'pages', 'common', `${pomName}.ts`);
  await writeFile(filePath, body, 'utf8');
}

describe('readFieldSelector — quote style handling', () => {
  test('double outer quotes with single inner quotes: this.loc("[data-test=\'x\']")', async () => {
    const { repoRoot, cleanup } = await setup();
    try {
      await writePom(repoRoot, 'CartPage', [
        'export class CartPage {',
        `  readonly checkoutButton = this.loc("[data-test='checkout']");`,
        '}',
      ].join('\n'));

      const selector = await readFieldSelector(repoRoot, 'CartPage', 'checkoutButton');
      assert.equal(selector, "[data-test='checkout']");
    } finally {
      await cleanup();
    }
  });

  test("single outer quotes with double inner quotes: this.loc('[data-test=\"x\"]')", async () => {
    const { repoRoot, cleanup } = await setup();
    try {
      await writePom(repoRoot, 'CartPage', [
        'export class CartPage {',
        `  readonly checkoutButton = this.loc('[data-test="checkout"]');`,
        '}',
      ].join('\n'));

      const selector = await readFieldSelector(repoRoot, 'CartPage', 'checkoutButton');
      assert.equal(selector, '[data-test="checkout"]');
    } finally {
      await cleanup();
    }
  });

  test('plain selector with no inner quotes still works', async () => {
    const { repoRoot, cleanup } = await setup();
    try {
      await writePom(repoRoot, 'InventoryPage', [
        'export class InventoryPage {',
        `  readonly cartIcon = this.loc(".shopping-cart-link");`,
        '}',
      ].join('\n'));

      const selector = await readFieldSelector(repoRoot, 'InventoryPage', 'cartIcon');
      assert.equal(selector, '.shopping-cart-link');
    } finally {
      await cleanup();
    }
  });
});

describe('readFieldSelector — missing cases return null', () => {
  test('returns null when POM file does not exist', async () => {
    const { repoRoot, cleanup } = await setup();
    try {
      const selector = await readFieldSelector(repoRoot, 'NonExistentPage', 'someField');
      assert.equal(selector, null);
    } finally {
      await cleanup();
    }
  });

  test('returns null when field is not declared on the POM', async () => {
    const { repoRoot, cleanup } = await setup();
    try {
      await writePom(repoRoot, 'CartPage', [
        'export class CartPage {',
        `  readonly checkoutButton = this.loc("[data-test='checkout']");`,
        '}',
      ].join('\n'));

      const selector = await readFieldSelector(repoRoot, 'CartPage', 'fieldThatDoesNotExist');
      assert.equal(selector, null);
    } finally {
      await cleanup();
    }
  });
});
