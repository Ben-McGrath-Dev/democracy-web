const PREF_KEY = 'democracy-web-attention-v1';

function prefs(){try{return JSON.parse(localStorage.getItem(PREF_KEY)||'{}')}catch{return {}}}
function save(p){localStorage.setItem(PREF_KEY,JSON.stringify(p))}
export function notificationPrefs(){return {browser:false,seen:{},dismissed:{},snoozed:{},...prefs()}}
export function setBrowserNotifications(value){const p=notificationPrefs();p.browser=!!value;save(p);return p}
export function markAttentionSeen(ids=[]){const p=notificationPrefs();for(const id of ids)p.seen[id]=Date.now();save(p)}
export function dismissAttention(id){const p=notificationPrefs();p.dismissed[id]=Date.now();delete p.snoozed?.[id];save(p)}
export function snoozeAttention(id, until=Date.now()+3600000){const p=notificationPrefs();p.snoozed[id]=Number(until)||Date.now()+3600000;save(p)}
export function clearDismissed(){const p=notificationPrefs();p.dismissed={};p.snoozed={};save(p)}
export function deriveAttention(state, localPlayerId=null, now=Date.now()){
  if(!state)return[];
  const items=[];
  for(const vote of Object.values(state.votes??{})){
    if(vote.status!=='open')continue;
    const close=Date.parse(vote.closesAt); const ms=close-now;
    const voted=localPlayerId && (vote.secretBallotMode==='sealed-v1'?!!vote.submittedVoters?.[localPlayerId]:!!vote.ballots?.[localPlayerId]);
    if(localPlayerId && vote.electorateSnapshot?.includes?.(localPlayerId) && !voted) items.push({id:`vote-unvoted:${vote.id}`,kind:'vote',priority:ms<=3*3600000?'urgent':'normal',title:`Vote: ${vote.title}`,message:ms>0?`You have not voted. Closes ${new Date(close).toLocaleString()}.`:'Voting deadline reached.',route:vote.electionKind?'elections':'votes',targetId:vote.id,dueAt:vote.closesAt,actionLabel:'Vote now',why:'You were in the electorate when this vote opened and no ballot from your player is currently recorded.'});
    else if(ms>0 && ms<=3*3600000) items.push({id:`vote-closing:${vote.id}`,kind:'deadline',priority:'urgent',title:`${vote.title} closes soon`,message:`Closes ${new Date(close).toLocaleString()}.`,route:vote.electionKind?'elections':'votes',targetId:vote.id,dueAt:vote.closesAt,actionLabel:'Open vote',why:'This open vote is approaching its deadline.'});
  }
  if(state.government?.status==='caretaker') items.push({id:`caretaker:${state.government.caretakerSince||'active'}`,kind:'government',priority:'urgent',title:'Caretaker government',message:'A replacement majority may need to be formed.',route:'government',dueAt:state.government.caretakerDeadline||null,actionLabel:'Open government',why:'The current government is in caretaker status, so government formation may require attention.'});
  if(state.government?.earlyElectionRequired) items.push({id:'early-election-required',kind:'government',priority:'urgent',title:'Early election required',message:'The government-formation deadline has expired.',route:'elections',actionLabel:'Open elections',why:'The government-formation deadline expired without a replacement majority.'});
  for (const request of Object.values(state.partyMembershipRequests ?? {})) {
    if (request.status !== 'pending' || !localPlayerId) continue;
    const party = state.parties?.[request.partyId];
    const player = state.players?.[request.playerId];
    if (!party || !player) continue;
    if (request.kind === 'invite' && request.playerId === localPlayerId) {
      items.push({id:`party-invite:${request.id}`,kind:'party',priority:'normal',title:`Invitation: ${party.name}`,message:`${state.players?.[request.createdBy]?.displayName ?? 'The party leader'} invited you to join ${party.name}.`,route:'actions',requestId:request.id,responseRole:'invitee',actionLabel:'Review invitation',why:'This party invited your player to become a member.'});
    }
    if (request.kind === 'join-request' && party.leaderId === localPlayerId) {
      items.push({id:`party-request:${request.id}`,kind:'party',priority:'normal',title:`Join request: ${party.name}`,message:`${player.displayName} asked to join ${party.name}.`,route:'actions',requestId:request.id,responseRole:'leader',actionLabel:'Review request',why:'You are the leader of this party and can accept or reject the membership request.'});
    }
  }
  for(const c of Object.values(state.cases??{})){
    if(['closed','dismissed','not-guilty'].includes(c.status))continue;
    if(localPlayerId && c.accusedId===localPlayerId && !c.accusedResponse) items.push({id:`case-response:${c.id}`,kind:'case',priority:'urgent',title:`Response required: ${c.id}`,message:'You are the accused player and a response has not been recorded.',route:'cases',targetId:c.id,actionLabel:'Respond to case',why:'You are the accused player in this open case and no response has been recorded yet.'});
  }
  return items.sort((a,b)=>(a.priority==='urgent'?0:1)-(b.priority==='urgent'?0:1));
}
export async function requestBrowserPermission(){if(!('Notification' in window))return 'unsupported';return Notification.requestPermission()}
export function maybeSendBrowserNotifications(items){const p=notificationPrefs();if(!p.browser||!('Notification' in window)||Notification.permission!=='granted')return;for(const item of items){if(p.seen?.[item.id]||p.dismissed?.[item.id])continue;try{new Notification(item.title,{body:item.message,tag:item.id,icon:'./assets/icon-192.png'})}catch{}p.seen[item.id]=Date.now()}save(p)}
