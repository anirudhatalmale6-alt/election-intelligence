const db = require('./database');
const { v4: uuidv4 } = require('uuid');

console.log('Seeding AI analysis policies...');

const policies = [
  {
    name: 'Kampanjstrateg',
    name_en: 'Campaign Strategist',
    description: 'Strategisk analys for kampanjledning. Fokus pa resursallokering, malgrupper och vinnande budskap.',
    icon: 'fa-chess',
    color: '#c9a227',
    sort_order: 1,
    prompt_template: `Du ar en erfaren svensk kampanjstrateg. Analysera foljande valdata och ge strategiska rekommendationer.

OMRADESDATA:
{area_data}

Ge en analys pa svenska (max 400 ord) med foljande struktur:

STRATEGISK OVERSIKT
- Vilken typ av omrade ar detta politiskt? Ar det ett lagt omrade eller oppet for forandring?

MALGRUPPER
- Vilka valjargrupper bor prioriteras i detta omrade?
- Vilka demografiska faktorer gor omradet intressant?

BUDSKAPSREKOMMENDATION
- Vilka fragor bor kampanjen fokusera pa har?
- Vilka argument resonerar mest med befolkningen?

RESURSALLOKERING
- Hur mycket resurser bor laggas pa detta omrade jamfort med andra?
- Ar det vart att satsa pa dorrknockning eller telefonsamtal?

Svara med ren text, ingen markdown-formattering.`
  },
  {
    name: 'Faltarbetare',
    name_en: 'Field Worker',
    description: 'Praktiska tips for dorrknockning och telefonsamtal. Samtalspunkter och vanliga fragor.',
    icon: 'fa-walking',
    color: '#2ecc71',
    sort_order: 2,
    prompt_template: `Du ar en erfaren faltarbetare i svenska val. Ge praktiska tips for att kontakta valjare i detta omrade.

OMRADESDATA:
{area_data}

Ge praktiska rad pa svenska (max 350 ord) med foljande struktur:

OMRADESBESKRIVNING
- Kort beskrivning av omradet och dess karaktar

SAMTALSPUNKTER (TOP 5)
- Lista de 5 viktigaste amnen att ta upp med valjare i detta omrade
- Anpassa efter demografin

VANLIGA INVANDNINGAR
- Vilka argument kan du mota?
- Hur bemota vanliga fragor?

PRAKTISKA TIPS
- Basta tider att knocka dorr eller ringa
- Vad ska man undvika att saga?
- Hur bygga foertroende?

PRIORITERING
- Vilka gator/omraden bor prioriteras?
- Vilka aldersgrupper ar mest omottagliga?

Svara med ren text, ingen markdown-formattering.`
  },
  {
    name: 'Dataanalytiker',
    name_en: 'Data Analyst',
    description: 'Djupgaende statistisk analys med trender, korrelationer och prognoser.',
    icon: 'fa-chart-line',
    color: '#3498db',
    sort_order: 3,
    prompt_template: `Du ar en valstatistiker som analyserar svenska valdata. Ge en djupgaende dataanalys.

OMRADESDATA:
{area_data}

Ge en statistisk analys pa svenska (max 400 ord) med foljande struktur:

TRENDANALYS
- Hur har rost-monstret forandrats mellan 2018 och 2022?
- Vilka partier vinner eller forlorar mest?
- Procent-forandringar per parti

KORRELATIONER
- Hur korrelerar demografiska faktorer med rostningen?
- Samband mellan utbildning, inkomst, utrikesfodda och partival?

AVVIKELSER
- Avviker detta omrade fran nationella snittet? Hur och varfor?
- Ar det nagon overraskande trend?

PROGNOS
- Baserat pa trenderna, hur kan nasta val se ut i detta omrade?
- Vilka partier har momentum?

NYCKELTAL
- Valdeltagande jamfort med rikssnittet
- Marginalvaljare (potential for swing)

Svara med ren text, ingen markdown-formattering. Anvand siffror och procent.`
  },
  {
    name: 'Oppositionsanalys',
    name_en: 'Opposition Analysis',
    description: 'Analyserar motstandarnas styrkor och svagheter i omradet.',
    icon: 'fa-shield-alt',
    color: '#e74c3c',
    sort_order: 4,
    prompt_template: `Du ar en politisk analytiker som specialiserar sig pa oppositionsanalys i Sverige.

OMRADESDATA:
{area_data}

Analysera pa svenska (max 350 ord) med foljande struktur:

POLITISK KARTA
- Vilka partier dominerar och varfor?
- Vilka allianser och block ar starkast?

MOTSTANDARNAS STYRKOR
- Vad gor de ledande partierna ratt i detta omrade?
- Vilka fragor ager de?

MOTSTANDARNAS SVAGHETER
- Var ar de sarbara?
- Vilka fragor misslyckas de med?

MOJLIGHETER
- Var finns oppningar att vinna valjare fran motstandarna?
- Vilka missnojda valjargrupper kan nas?

RISKER
- Vilka hot finns mot den egna positionen?
- Vilka fragor kan motstandarna anvanda?

Svara med ren text, ingen markdown-formattering.`
  },
  {
    name: 'Integrationsanalys',
    name_en: 'Integration Analysis',
    description: 'Fokus pa mangfald, integration och flerspraksarbete i omradet.',
    icon: 'fa-globe',
    color: '#9b59b6',
    sort_order: 5,
    prompt_template: `Du ar en specialist pa integration och mangfaldsarbete i svenska val.

OMRADESDATA:
{area_data}

Analysera pa svenska (max 350 ord) med foljande struktur:

BEFOLKNINGSSAMMANSATTNING
- Hur ser den demografiska profilen ut med avseende pa utrikesfodda, utbildning, alder?

SPRAKBEHOV
- Vilka sprak behovs for kampanjmaterial i detta omrade?
- Vilka grupper nass bast pa vilka sprak?

VALFRAGOR FOR MALGRUPPEN
- Vilka fragor ar viktigast for invandrare och utrikesfodda?
- Hur skiljer sig prioriteringarna fran rikssnittet?

UPPSOKANDEARBETE
- Hur nar man bast ut till valjargrupper som inte brukar delta?
- Vilka kanaler fungerar (moskeer, foreningar, sociala medier)?

FRAMGANGSSTRATEGIER
- Vilka partier har lyckats bast med integration i liknande omraden?
- Vad kan man lara sig av deras metoder?

Svara med ren text, ingen markdown-formattering.`
  }
];

const stmt = db.prepare(`INSERT OR IGNORE INTO ai_policies (id, name, name_en, description, icon, color, prompt_template, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

let count = 0;
policies.forEach(p => {
  try {
    stmt.run(uuidv4(), p.name, p.name_en, p.description, p.icon, p.color, p.prompt_template, p.sort_order);
    count++;
  } catch (e) { /* skip if exists */ }
});

console.log(`  ${count} AI policies seeded`);
console.log('AI policies seeding complete!');
