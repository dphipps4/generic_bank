// Generic Bank CoreLink Branch Console crawler.

function lastFour(s){ const m=String(s).match(/\d{4,}/g); return m? m[m.length-1] : String(s); }

async function ensureSignedIn(site){
  for(let i=0;i<10;i++){
    const p = await site.look();
    const lines = p.lines.join('\n');
    // Signed-in indicator: left nav has Member Search, or a Sign Out link
    if (site.shows('Member Search') || site.shows('Sign Out') || site.shows('Branch notice')) return;
    if (/Operator ID/i.test(lines) && /Password/i.test(lines)) {
      await site.type({field:0}, 'user_id');
      await site.type({field:1}, 'password');
      await site.press('Sign In');
      await site.wait(2);
      continue;
    }
    if (/code/i.test(lines)) {
      const hasSend = p.controls.some(c=>/send code/i.test(c.name||''));
      if (hasSend) { await site.press('Send code'); await site.wait(2); }
      await site.type({field:0}, 'code');
      await site.press('Verify');
      await site.wait(2);
      continue;
    }
    await site.wait(2);
  }
}

async function openMember(site, task){
  await site.open();
  await ensureSignedIn(site);
  await site.press('Member Search');
  await site.wait(1);
  await site.type({field:0}, 'member');
  await site.press('Search');
  await site.wait(1);
  await site.press('Open');
  await site.wait(1);
}

async function balance(site, task){
  await openMember(site, task);
  const p = await site.look();
  const lines = p.lines;
  const from = lastFour(task.from);
  let idx = -1;
  for(let i=0;i<lines.length;i++){ if (lines[i].includes(from)) { idx=i; break; } }
  let available=null, current=null, account=from;
  for(let i=idx; i<Math.min(idx+8, lines.length); i++){
    const l = lines[i];
    if (/available/i.test(l)) { const m=l.match(/[\d,]+\.?\d*/g); if(m) available=m[m.length-1]; }
    if (/current/i.test(l))   { const m=l.match(/[\d,]+\.?\d*/g); if(m) current=m[m.length-1]; }
  }
  return { account, available, current };
}

async function transfer(site, task){
  await openMember(site, task);
  await site.press('Transfer Funds');
  await site.wait(1);
  await site.choose({x:483,y:202}, 'from');
  await site.wait(1);
  await site.choose({x:483,y:239}, 'to');
  await site.wait(1);
  await site.type({field:0}, 'amount');
  await site.type({field:1}, 'memo');
  await site.press('Continue');
  await site.wait(1);
}

async function review(site, task){
  const p = await site.look();
  const lines = p.lines;
  function after(label){
    for(let i=0;i<lines.length;i++){
      if (new RegExp('^\\s*'+label+':?\\s*$','i').test(lines[i])) return (lines[i+1]||'').trim();
      const m = lines[i].match(new RegExp(label+':?\\s*(.+)$','i'));
      if (m) return m[1].trim();
    }
    return null;
  }
  return { from: after('From'), to: after('To'), amount: after('Amount'), memo: after('Memo') };
}

async function history(site, task){
  await openMember(site, task);
  const from = lastFour(task.from);
  await site.press({name:'Activity', near:from});
  await site.wait(1);
}

function name(lines, member){
  for(const l of lines){
    const m2 = l.match(/Member[^\n]*·\s*([A-Za-z][^·\n]*)/);
    if (m2) return m2[1].trim();
    const m = l.match(/·\s*([A-Za-z][^·\n]*?)\s*$/);
    if (m && /Member/i.test(l)) return m[1].trim();
  }
  return null;
}

const send = 'Submit transfer';
