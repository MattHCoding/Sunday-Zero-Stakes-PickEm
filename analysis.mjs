import { demoRows, filterRows, summarize } from './analysis-model.mjs';
import { loadHistory } from './analysis-data.mjs';
import { createAppPicksApi } from './picks-api.mjs';
let tokenProvider = () => null;
export function connectAnalysis(provider) { tokenProvider = provider; reload(); }
const root = document.getElementById('analysisView');
const year = new Date().getUTCFullYear();
root.innerHTML = `
  <div class="eyebrow">Your season, in perspective</div><h1>Pick analysis</h1>
  <p>Find where your picks are working—and which teams are fooling you.</p>
  <div class="analysis-filters">
    <label>Data<select id="aSource"><option value="account">My picks</option><option value="demo">Demo · fictional picks</option></select></label>
    <label>Season<select id="aSeason">${Array.from({length:Math.max(3,year-2023)},(_,i)=>`<option>${year-i}</option>`).join('')}</select></label>
    <label>From week<select id="aFrom">${Array.from({length:18},(_,i)=>`<option>${i+1}</option>`).join('')}</select></label>
    <label>Through week<select id="aTo">${Array.from({length:18},(_,i)=>`<option ${i===17?'selected':''}>${i+1}</option>`).join('')}</select></label>
    <label>Team involved<select id="aTeam"><option value="">All teams</option></select></label>
    <label>Picked side<select id="aSide"><option value="">Home & away</option><option value="home">Home</option><option value="away">Away</option></select></label>
    <button id="aReload" type="button">Load picks</button>
  </div>
  <div id="aNotice" class="analysis-banner" role="status"></div>
  <div id="aKpis" class="analysis-kpis"></div>
  <div class="analysis-charts">
    <article class="chart-card"><h2>Overall accuracy</h2><p class="legend">Correct picks ÷ decided picks</p><div id="aDonut"></div></article>
    <article class="chart-card"><h2>Accuracy through the season</h2><p class="legend">Blue: weekly · Teal: cumulative within the selected range</p><div id="aLine"></div></article>
    <article class="chart-card wide"><h2>How well do you read each team?</h2><p class="legend">Upper left is better. Each logo compares your picks with whether that team covered the saved spread.</p><div id="aScatter"></div><p id="aScatterNote" class="legend"></p>
      <details><summary>Team rates and sample sizes</summary><div id="aTeams" class="analysis-table"></div></details>
    </article>
  </div>
  <details><summary>How these results are calculated</summary><p>Accuracy is against the spread saved when you made the pick, using final scores. Pushes, pending games and ungradable picks are excluded from accuracy and team rates. Cumulative accuracy is weighted by the number of decided picks, starting at your selected first week.</p><p>For each team, a positive prediction means you picked it to cover; picking its opponent is a negative prediction. True-positive rate = TP / (TP + FN). False-positive rate = FP / (FP + TN). Only games you picked are counted. A team needs at least one cover and one non-cover to appear on the plot. Logos sharing a position are listed together in the tooltip; the table shows every team.</p><p>Older device-only picks have no saved spread and cannot be graded reliably. They are not included in account history.</p></details>
  <details><summary>Weekly results</summary><div id="aWeeks" class="analysis-table"></div></details>`;
const $ = id => document.getElementById(id);
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = n => n===null ? '—' : `${(n*100).toFixed(1)}%`;
const svg = (body, label, width=600,height=300) => `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${body}</svg>`;
let rows = [], sequence = 0;
function teamOptions() {
  $('aTeam').innerHTML = '<option value="">All teams</option>'+[...new Set(rows.flatMap(r=>[r.homeTeam,r.awayTeam]))].sort().map(t=>`<option>${esc(t)}</option>`).join('');
}
function render() {
  const from=Number($('aFrom').value),to=Number($('aTo').value);
  const selected = filterRows(rows,{season:$('aSeason').value,from,to,team:$('aTeam').value,side:$('aSide').value});
  const s = summarize(selected,$('aTeam').value), c=s.counts;
  $('aKpis').innerHTML = [['Decided picks',c.win+c.loss],['Correct / incorrect',`${c.win} / ${c.loss}`],['Pushes',c.push],['Pending / ungraded',`${c.pending} / ${c.ungraded}`]].map(([k,v])=>`<div><span>${k}</span><strong>${v}</strong></div>`).join('');
  const total=c.win+c.loss, circumference=2*Math.PI*75;
  $('aDonut').innerHTML=svg(`<circle cx="150" cy="130" r="75" fill="none" stroke="${total?'#f0b4a8':'#e8edf3'}" stroke-width="24"/>${total?`<circle cx="150" cy="130" r="75" fill="none" stroke="#168e86" stroke-width="24" stroke-dasharray="${circumference*s.accuracy} ${circumference}" transform="rotate(-90 150 130)"/>`:''}<text x="150" y="134" text-anchor="middle" class="big-number">${pct(s.accuracy)}</text><text x="150" y="160" text-anchor="middle">${total?'against the spread':'No decided picks'}</text><text x="150" y="252" text-anchor="middle">${c.win} correct · ${c.loss} incorrect</text>`,`Accuracy ${pct(s.accuracy)}; ${c.win} correct and ${c.loss} incorrect`,300,280);
  const x=w=>55+(w-from)/Math.max(1,to-from)*505, y=v=>240-v*200;
  let line='';
  for(const v of [0,.25,.5,.75,1])line+=`<line x1="55" x2="560" y1="${y(v)}" y2="${y(v)}" stroke="#e5eaf0"/><text x="45" y="${y(v)+4}" text-anchor="end">${v*100}%</text>`;
  const weeklyMap = new Map(s.weekly.map(w=>[w.week,w]));
  let cumulative=null;
  for (const [field,color] of [['accuracy','#0071e3'],['cumulative','#168e86']]) {
    let previous=null;
    for(let week=from;week<=to;week++) {
      const w=weeklyMap.get(week);
      if(field==='cumulative' && w?.cumulative!==null && w?.cumulative!==undefined)cumulative=w.cumulative;
      const value=field==='cumulative'?cumulative:(w?.accuracy??null);
      if(value===null){previous=null;continue;}
      const point=[x(week),y(value)];
      if(previous)line+=`<line x1="${previous[0]}" y1="${previous[1]}" x2="${point[0]}" y2="${point[1]}" stroke="${color}" stroke-width="3"/>`;
      line+=`<circle cx="${point[0]}" cy="${point[1]}" r="4" fill="${color}"><title>Week ${week}: ${field==='accuracy'?'weekly':'cumulative'} ${pct(value)}; ${w?.n||0} decided this week</title></circle>`;
      previous=point;
    }
  }
  for(let w=from;w<=to;w++)if(to-from<10 || (w-from)%2===0 || w===to)line+=`<text x="${x(w)}" y="262" text-anchor="middle">${w}</text>`;
  line+='<text x="310" y="289" text-anchor="middle">Week</text>';
  if(!total)line+='<text x="310" y="138" text-anchor="middle">No decided picks in this selection</text>';
  $('aLine').innerHTML=svg(line,'Weekly and cumulative accuracy; exact values in Weekly results');
  const sx=v=>75+v*490,sy=v=>315-v*260;
  let scatter='';
  for(const v of [0,.25,.5,.75,1])scatter+=`<line x1="75" x2="565" y1="${sy(v)}" y2="${sy(v)}" stroke="#e5eaf0"/><line x1="${sx(v)}" x2="${sx(v)}" y1="55" y2="315" stroke="#e5eaf0"/><text x="62" y="${sy(v)+4}" text-anchor="end">${v*100}%</text><text x="${sx(v)}" y="340" text-anchor="middle">${v*100}%</text>`;
  scatter+='<text x="320" y="378" text-anchor="middle">False-positive rate →</text><text transform="translate(18 190) rotate(-90)" text-anchor="middle">True-positive rate →</text>';
  scatter+=`<line x1="75" y1="315" x2="565" y2="55" stroke="#b7c4d3" stroke-dasharray="5 5"/>`;
  const points=s.teams.filter(t=>t.tpr!==null&&t.fpr!==null);
  const groups=new Map();for(const t of points){const key=`${t.tpr}:${t.fpr}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(t);}
  for(const group of groups.values()){
    const t=group[0],title=group.map(t=>`${t.team}: TPR ${pct(t.tpr)}, FPR ${pct(t.fpr)}; ${t.n} games`).join(' | ');
    const safeLogo=/^https:\/\/a\.espncdn\.com\//.test(t.logo||'')?t.logo:'';
    scatter+=`<g tabindex="0" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><circle cx="${sx(t.fpr)}" cy="${sy(t.tpr)}" r="19" fill="white" stroke="#cbd5e1"/><text x="${sx(t.fpr)}" y="${sy(t.tpr)+4}" text-anchor="middle">${esc(t.team)}</text>${safeLogo?`<image href="${esc(safeLogo)}" x="${sx(t.fpr)-16}" y="${sy(t.tpr)-16}" width="32" height="32"/>`:''}${group.length>1?`<text x="${sx(t.fpr)+20}" y="${sy(t.tpr)-16}">+${group.length-1}</text>`:''}</g>`;
  }
  if(!points.length)scatter+='<text x="320" y="190" text-anchor="middle">Not enough cover / non-cover history yet</text>';
  $('aScatter').innerHTML=svg(scatter,'Team true-positive versus false-positive rates; exact values in team table',640,400);
  $('aScatterNote').textContent=`${points.length} teams plotted · ${s.teams.length-points.length} lack a cover or non-cover observation. Small samples can produce extreme rates.`;
  const table=(headers,data)=>`<table><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${data.map(row=>`<tr>${row.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  $('aTeams').innerHTML=table(['Team','Games','TP','FP','FN','TN','TPR','FPR'],s.teams.map(t=>[t.team,t.n,t.tp,t.fp,t.fn,t.tn,pct(t.tpr),pct(t.fpr)]));
  $('aWeeks').innerHTML=table(['Week','Correct','Incorrect','Weekly','Cumulative'],s.weekly.map(w=>[w.week,w.win,w.loss,pct(w.accuracy),pct(w.cumulative)]));
}
async function reload(){
  const id=++sequence; rows=[];teamOptions();render();
  const demo=$('aSource').value==='demo';
  if(demo){rows=demoRows().map(r=>({...r,seasonYear:Number($('aSeason').value)}));$('aNotice').textContent='DEMO — fictional picks and outcomes, not your results or real game scores.';teamOptions();render();return;}
  if(!await tokenProvider()){$('aNotice').textContent='Account history will be available after sign-in is activated. Choose Demo to explore the dashboard; device-only picks cannot be graded without their saved lines.';return;}
  try{
    const loaded=await loadHistory(createAppPicksApi(tokenProvider),Number($('aSeason').value),{onProgress:week=>{if(id===sequence)$('aNotice').textContent=`Loading account history · Week ${week} of 18…`;}});
    if(id!==sequence)return;
    rows=loaded;
    $('aNotice').textContent=rows.length?`Loaded ${rows.length} account picks. Filters apply to every chart. Scores refreshed ${new Date().toLocaleTimeString()}.`:'No saved account picks for this season.';
    teamOptions();render();
  }catch(error){if(id!==sequence)return;rows=[];$('aNotice').textContent=`History could not be loaded completely. ${error.message}`;render();}
}
for(const id of ['aFrom','aTo','aTeam','aSide'])$(id).addEventListener('change',()=>{if(Number($('aFrom').value)>Number($('aTo').value))$(id==='aFrom'?'aTo':'aFrom').value=$(id).value;render();});
for(const id of ['aSource','aSeason'])$(id).addEventListener('change',reload);
$('aReload').addEventListener('click',reload);
for(const view of ['picks','analysis'])document.getElementById(`${view}Tab`).addEventListener('click',()=>{
  for(const name of ['picks','analysis']){document.getElementById(`${name}View`).hidden=name!==view;document.getElementById(`${name}Tab`).setAttribute('aria-pressed',String(name===view));}
  document.querySelector('.controls').hidden=view==='analysis';
});
reload();
