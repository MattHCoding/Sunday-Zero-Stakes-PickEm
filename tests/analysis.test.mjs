import test from 'node:test';
import assert from 'node:assert/strict';
import { gradePick, summarize, filterRows } from '../analysis-model.mjs';
import { loadHistory } from '../analysis-data.mjs';
const pick={eventId:'1',seasonYear:2026,weekNumber:1,homeTeam:'BUF',awayTeam:'KC',selectionHomeAway:'home',spread:-3};
const game=(home,away,completed=true)=>({competitions:[{status:{type:{state:completed?'post':'in',completed}},competitors:[{homeAway:'home',score:home,team:{abbreviation:'BUF'}},{homeAway:'away',score:away,team:{abbreviation:'KC'}}]}]});
test('saved spread grades home and away, pushes, pending and missing scores',()=>{
 assert.equal(gradePick(pick,game(24,20)).result,'win');
 assert.equal(gradePick(pick,game(23,20)).result,'push');
 assert.equal(gradePick(pick,game(21,20)).result,'loss');
 assert.equal(gradePick({...pick,selectionHomeAway:'away',spread:3},game(21,20)).result,'win');
 assert.equal(gradePick(pick,game(24,20,false)).result,'pending');
 assert.equal(gradePick(pick,game('',20)).result,'ungraded');
 assert.equal(gradePick({...pick,spread:null},game(24,20)).result,'ungraded');
});
test('team confusion counts include picks against a team and exclude pushes',()=>{
 const rows=['win','loss','loss','win','push'].map((result,i)=>({...pick,result,selectionHomeAway:i<2?'home':'away'}));
 const summary=summarize(rows);const team=summary.teams.find(t=>t.team==='BUF');
 assert.deepEqual([team.tp,team.fp,team.fn,team.tn],[1,1,1,1]);
 assert.equal(team.tpr,.5);assert.equal(team.fpr,.5);assert.equal(summary.accuracy,.5);
});
test('cumulative accuracy uses decided counts, not mean weekly rates; filters apply',()=>{
 const rows=[{...pick,result:'win'},...Array.from({length:3},()=>({...pick,weekNumber:2,result:'loss'})),{...pick,weekNumber:3,result:'pending'}];
 assert.equal(summarize(rows).weekly[1].cumulative,.25);
 assert.equal(summarize([{...pick,result:'win'}]).teams[0].fpr,null);
 assert.equal(filterRows(rows,{season:2026,from:2,to:2,team:'KC',side:'home'}).length,3);
 assert.equal(filterRows(rows,{season:2025,from:1,to:18}).length,0);
 assert.equal(summarize([]).accuracy,null);
});
test('history never fabricates scores and rejects partial load failures',async()=>{
 let calls=0;
 await assert.rejects(loadHistory({listPicks:async()=>{if(++calls===2)throw Error('expired');return [];}},2026),/expired/);
 const rows=await loadHistory({listPicks:async(_,week)=>week===1?[pick]:[]},2026,{fetchImpl:async()=>({ok:true,json:async()=>({season:{year:2026},week:{number:1},events:[]})})});
 assert.equal(rows[0].result,'ungraded');
});
