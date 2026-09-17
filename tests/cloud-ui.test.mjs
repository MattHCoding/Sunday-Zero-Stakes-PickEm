import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('init();', '');
function setup(api) {
  const elements = new Map();
  const context = vm.createContext({
    createAppPicksApi: () => api, getAccessToken: () => 'token', getSession: () => ({ userId: 'one' }),
    signIn() {}, signOut() {}, finishSignIn() {},
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { addEventListener() {} }); return elements.get(id); }, querySelectorAll: () => [] },
    localStorage: { getItem() { throw Error('Must not read guest picks'); } }, console,
  });
  vm.runInContext(source, context);
  vm.runInContext('accountMode = true; cloudReady = true; state.seasonYear = 2026; state.week = 2; refreshLive = async () => {}; isPickOpen = () => true;', context);
  return { context, elements };
}
test('account picks never inherit guest picks and successful save confirms account', async () => {
  const { context, elements } = setup({ savePick: async () => ({ selectionHomeAway: 'home' }) });
  assert.equal(vm.runInContext("readSelection({id:'123'})", context), '');
  await vm.runInContext("recordPick({id:'123'}, '', 'home')", context);
  assert.equal(vm.runInContext("readSelection({id:'123'})", context), 'home');
  assert.equal(elements.get('statusBar').textContent, 'Pick saved to your account.');
});
test('unconfirmed save does not overwrite the confirmed pick and blocks further saves', async () => {
  const { context, elements } = setup({ savePick: async () => { throw Error('network failed'); } });
  vm.runInContext("cloudSelections.set('123', 'away')", context);
  await vm.runInContext("recordPick({id:'123'}, '', 'home')", context);
  assert.equal(vm.runInContext("readSelection({id:'123'})", context), 'away');
  assert.equal(vm.runInContext('cloudReady', context), false);
  assert.match(elements.get('statusBar').textContent, /not confirmed/);
});
