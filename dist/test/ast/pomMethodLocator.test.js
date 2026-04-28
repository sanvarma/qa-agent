import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findMethod } from '../../src/ast/pomMethodLocator.js';
import { makeSourceFile } from '../helpers/inMemoryProject.js';
function classOf(source) {
    const sf = makeSourceFile(source);
    const cls = sf.getClasses()[0];
    if (!cls)
        throw new Error('test source has no class');
    return cls;
}
describe('findMethod — happy path', () => {
    test('finds a regular method', () => {
        const cls = classOf(`
      export class LoginPage {
        async login(email: string) { return email; }
      }
    `);
        const r = findMethod(cls, 'login');
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.name, 'login');
        assert.equal(r.locator.className, 'LoginPage');
        assert.equal(r.locator.isAsync, true);
        assert.equal(r.locator.isStatic, false);
    });
    test('flags static methods', () => {
        const cls = classOf(`export class P { static helper() {} }`);
        const r = findMethod(cls, 'helper');
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.isStatic, true);
    });
});
describe('findMethod — refusals', () => {
    test('returns is_accessor for a getter', () => {
        const cls = classOf(`export class P { get field() { return 1; } }`);
        const r = findMethod(cls, 'field');
        assert.equal(r.status, 'is_accessor');
        if (r.status !== 'is_accessor')
            return;
        assert.equal(r.kind, 'getter');
    });
    test('returns is_accessor for a setter', () => {
        const cls = classOf(`export class P { set field(v: number) {} }`);
        const r = findMethod(cls, 'field');
        assert.equal(r.status, 'is_accessor');
        if (r.status !== 'is_accessor')
            return;
        assert.equal(r.kind, 'setter');
    });
    test('returns is_constructor for constructor name', () => {
        const cls = classOf(`export class P { constructor() {} }`);
        const r = findMethod(cls, 'constructor');
        assert.equal(r.status, 'is_constructor');
    });
    test('returns overloaded when multiple signatures exist', () => {
        const cls = classOf(`
      export class P {
        login(email: string): void;
        login(email: string, password: string): void;
        login(email: string, password?: string) { /* impl */ }
      }
    `);
        const r = findMethod(cls, 'login');
        assert.equal(r.status, 'overloaded');
        if (r.status !== 'overloaded')
            return;
        assert.ok(r.signatureLines.length >= 2);
        assert.ok(r.implementationLine !== undefined);
    });
    test('returns abstract for abstract methods', () => {
        const cls = classOf(`
      export abstract class P {
        abstract doThing(): void;
      }
    `);
        const r = findMethod(cls, 'doThing');
        assert.equal(r.status, 'abstract');
    });
});
describe('findMethod — miss', () => {
    test('returns not_found with candidates', () => {
        const cls = classOf(`
      export class P {
        foo() {}
        bar() {}
      }
    `);
        const r = findMethod(cls, 'missing');
        assert.equal(r.status, 'not_found');
        if (r.status !== 'not_found')
            return;
        assert.deepEqual(r.methodCandidates.sort(), ['bar', 'foo']);
    });
});
//# sourceMappingURL=pomMethodLocator.test.js.map