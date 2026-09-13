import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPicksApi } from '../picks-api.mjs';

test('no token means no request', async () => {
  const api = createPicksApi({baseUrl:'https://api.example.test', getAccessToken:()=>null,
    fetchImpl:()=>assert.fail('must not send unauthenticated request')});
  await assert.rejects(api.listPicks(2026, 1), /Sign in/);
});

test('server save must succeed before returning a pick', async () => {
  const api = createPicksApi({baseUrl:'https://api.example.test', getAccessToken:()=> 'test-only',
    fetchImpl:async (url, options) => {
      assert.equal(url, 'https://api.example.test/picks/123');
      assert.equal(options.headers.Authorization, 'Bearer test-only');
      assert.deepEqual(JSON.parse(options.body), {seasonYear:2026,weekNumber:1,selectionHomeAway:'away'});
      return {ok:false,json:async()=>({error:'Picks are locked for this game.'})};
    }});
  await assert.rejects(api.savePick({eventId:'123',seasonYear:2026,weekNumber:1,selectionHomeAway:'away',spread:-99,userId:'other'}), /locked/);
});
