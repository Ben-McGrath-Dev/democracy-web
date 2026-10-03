export function createStartingLaws(now = new Date().toISOString()) {
  const defs = [
    ['LAW-001','No Fraud','Players must not deliberately falsify votes, election records, committee records, case evidence, or official Democracy records.'],
    ['LAW-002','No Impersonation','Players must not deliberately impersonate the Host, Deputy Host, another player, a committee, the government, or another official institution. Satire or parody that a reasonable participant would understand is not impersonation.'],
    ['LAW-003','No Vote Interference','Players must not deliberately prevent or materially interfere with another eligible player\'s legitimate ability to vote. Political persuasion is not vote interference.'],
    ['LAW-004','No Serious Harassment','Players must not use Democracy as a means of serious harassment, threats or targeted abuse. Ordinary political criticism, disagreement, satire and campaigning do not by themselves constitute serious harassment.'],
    ['LAW-005','No Retaliation','A player must not threaten or punish another player merely for exercising a constitutional political right. This does not prevent lawful political criticism or constitutionally authorised consequences for actual misconduct.']
  ];
  return Object.fromEntries(defs.map(([id,title,text]) => [id, { id, title, text, reason:'Starting law established by the Constitution.', status:'in-force', version:1, enactedAt:now, updatedAt:now, sourceProposalId:null, startingLaw:true, history:[{type:'starting-law',at:now}] }]));
}
