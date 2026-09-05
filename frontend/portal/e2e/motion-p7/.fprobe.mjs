import { chromium } from 'playwright';
const BASE='http://localhost:5173/';
const SITE=process.env.S||'00000000-0000-0000-0000-000000000002';
const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:375,height:812}});
const p=await ctx.newPage();
await p.goto(BASE,{waitUntil:'domcontentloaded'});
await p.getByRole('button',{name:'Anmelden'}).first().click();
await p.waitForSelector('#username',{timeout:30000});await p.fill('#username','demo');await p.fill('#password','demo');await p.click('#kc-login');
await p.waitForTimeout(4000);
for (const [n,h] of [['Cockpit',`/anlage/${SITE}`],['Erlöse',`/anlage/${SITE}/erloese`],['Messwerte',`/anlage/${SITE}/messwerte`],['Fahrplan',`/anlage/${SITE}/fahrplan`]]) {
  await p.evaluate(x=>{location.hash=x},h); await p.waitForTimeout(7000);
  console.log(n,'chart-motion',await p.evaluate(()=>document.querySelectorAll('.vp-chart-motion').length),
   'canvas',await p.evaluate(()=>document.querySelectorAll('canvas').length),
   'mini-col',await p.evaluate(()=>document.querySelectorAll('.vp-mini-col').length),
   'mini-wrap',await p.evaluate(()=>document.querySelectorAll('.vp-mini-wrap').length));
}
await b.close();process.exit(0);
