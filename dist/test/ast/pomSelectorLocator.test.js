import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findSelectorField } from '../../src/ast/pomSelectorLocator.js';
import { makeSourceFile } from '../helpers/inMemoryProject.js';
function classOf(source) {
    const sf = makeSourceFile(source);
    const cls = sf.getClasses()[0];
    if (!cls)
        throw new Error('test source has no class');
    return cls;
}
describe('findSelectorField — happy path', () => {
    test('finds a `locator(...)` field initializer', () => {
        const cls = classOf(`
      import { Page } from '@playwright/test';
      export class LoginPage {
        emailField = this.page.locator('[data-test=email]');
        constructor(private page: Page) {}
      }
    `);
        const r = findSelectorField(cls, 'emailField');
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.method, 'locator');
        assert.equal(r.locator.currentSelector, '[data-test=email]');
        assert.equal(r.locator.className, 'LoginPage');
    });
    test('finds `getByTestId(...)`', () => {
        const cls = classOf(`
      export class P {
        submitBtn = this.page.getByTestId('submit');
      }
    `);
        const r = findSelectorField(cls, 'submitBtn');
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.method, 'getByTestId');
        assert.equal(r.locator.currentSelector, 'submit');
    });
    test('finds `getByText(...)`', () => {
        const cls = classOf(`export class P { link = this.page.getByText('Continue'); }`);
        const r = findSelectorField(cls, 'link');
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.method, 'getByText');
    });
    test('finds `getByLabel(...)`', () => {
        const cls = classOf(`export class P { name = this.page.getByLabel('Name'); }`);
        const r = findSelectorField(cls, 'name');
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.method, 'getByLabel');
    });
    test('accepts non-substitution template literal as selector', () => {
        const cls = classOf("export class P { x = this.page.locator(`.cls`); }");
        const r = findSelectorField(cls, 'x');
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.currentSelector, '.cls');
    });
});
describe('findSelectorField — refusals', () => {
    test('refuses getByRole', () => {
        const cls = classOf(`export class P { btn = this.page.getByRole('button', { name: 'OK' }); }`);
        const r = findSelectorField(cls, 'btn');
        assert.equal(r.status, 'role_based_selector');
    });
    test('refuses chained locators (.locator().locator())', () => {
        const cls = classOf(`export class P { inner = this.page.locator('.card').locator('button'); }`);
        const r = findSelectorField(cls, 'inner');
        assert.equal(r.status, 'chained_selectors');
    });
    test('refuses unsupported locator method', () => {
        const cls = classOf(`export class P { x = this.page.findByFoo('bar'); }`);
        const r = findSelectorField(cls, 'x');
        assert.equal(r.status, 'unsupported_call');
        if (r.status !== 'unsupported_call')
            return;
        assert.equal(r.callName, 'findByFoo');
    });
    test('refuses non-string first argument (e.g. regex)', () => {
        const cls = classOf(`export class P { x = this.page.getByText(/hello/); }`);
        const r = findSelectorField(cls, 'x');
        assert.equal(r.status, 'non_string_selector');
    });
    test('refuses field whose initializer is not a call', () => {
        const cls = classOf(`export class P { x = 'raw-string'; }`);
        const r = findSelectorField(cls, 'x');
        assert.equal(r.status, 'not_a_selector_field');
    });
});
describe('findSelectorField — misses', () => {
    test('not_found returns field candidates', () => {
        const cls = classOf(`
      export class P {
        foo = this.page.locator('.a');
        bar = this.page.locator('.b');
      }
    `);
        const r = findSelectorField(cls, 'missing');
        assert.equal(r.status, 'not_found');
        if (r.status !== 'not_found')
            return;
        assert.deepEqual(r.fieldCandidates.sort(), ['bar', 'foo']);
    });
});
//# sourceMappingURL=pomSelectorLocator.test.js.map