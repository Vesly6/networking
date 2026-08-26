/** Content for the "Pamokos" (Lessons) tab — plain data, no CMS/backend.
 * Text-only for now; `image` fields point at real, in-app-captured
 * screenshots under app/public/lessons/ (see LessonsView.tsx for how
 * they're rendered) — a video walkthrough per lesson was also asked for,
 * but recording/narrating screen-capture video isn't something this tool
 * can produce; `videoUrl` is left here, always undefined today, as the
 * slot to fill in later if a real video gets recorded and hosted
 * somewhere (see LessonsView's own doc comment on why a bare field is
 * enough — no video player needs building until there's an actual URL to
 * point it at). */

export interface LessonSection {
  heading?: string;
  body: string[];
  image?: string;
}

export interface Lesson {
  id: string;
  title: string;
  category: string;
  summary: string;
  videoUrl?: string;
  sections: LessonSection[];
}

export const LESSON_CATEGORIES = ['Pradžia', 'Lentelė', 'Kalendorius', 'Skambučiai', 'Paieška', 'Paštas', 'LinkedIn'] as const;

export const LESSONS: Lesson[] = [
  {
    id: 'getting-started',
    title: 'Pirmi žingsniai',
    category: 'Pradžia',
    summary: 'Kas yra „darbo sritis", kaip sukurti/atidaryti lentelę, ir kaip programa apskritai sudėliota.',
    sections: [
      {
        body: [
          'Programa nėra vienas didelis bendras sąrašas — ji sudaryta iš atskirų „lentelių" (pvz., viena lentelė vienai kampanijai ar vienam rinkos segmentui). Kai atsidarote programą, pirmiausia matote „Darbo sritį" — visų jūsų lentelių sąrašą.',
          'Norėdami sukurti naują lentelę, spauskite „+ Nauja lentelė". Nauja lentelė iš karto turi 1000 tuščių eilučių ir 50 stulpelių — tam, kad iškart galėtumėte įklijuoti didelį kiekį duomenų, nereikėtų pirma rankiniu būdu kurti stulpelių.',
          'Spustelėję ant lentelės kortelės, patenkate į pačią lentelę — ten ir vyksta didžioji dalis kasdienio darbo (skambučiai, užrašai, statusai).',
        ],
        image: 'workspace.png',
      },
      {
        heading: 'Naršymas tarp lentelių',
        body: [
          'Apačioje, virš pat ekrano krašto, matote korteles su kiekvienos atidarytos lentelės pavadinimu — panašiai kaip Excel lapų kortelės. Paspaudus ant kortelės — persijungiate į tą lentelę. Dešiniu pelės mygtuku paspaudus ant kortelės — atsiveria meniu: pervadinti, sukurti naują, dublikuoti arba ištrinti lentelę.',
          '„← Darbo sritis" viršuje kairėje visada grąžina atgal į visų lentelių sąrašą.',
        ],
      },
    ],
  },
  {
    id: 'table-basics',
    title: 'Lentelės pagrindai: langeliai, stulpeliai, eilutės',
    category: 'Lentelė',
    summary: 'Kaip redaguoti langelius, pridėti stulpelius/eilutes, ir kokie stulpelių tipai yra.',
    sections: [
      {
        body: [
          'Norėdami redaguoti langelį — tiesiog spustelėkite ant jo vieną kartą, jis iškart tampa redaguojamas. Baigus rašyti — spauskite Enter arba spustelėkite kitur, ir pakeitimas išsaugomas automatiškai (jokio atskiro „Išsaugoti" mygtuko nereikia).',
          'Formulos juosta viršuje (po langelio nuoroda, pvz. „A1") visada rodo pilną pasirinkto langelio turinį — patogu, kai tekstas ilgas ir netelpa į vieną eilutę lentelėje.',
        ],
      },
      {
        heading: 'Stulpelių tipai',
        body: [
          '„Tekstas", „Telefonas", „Įmonė" — paprasti vienos eilutės laukai, redaguojami vienodai.',
          '„Nuoroda" — kaip tekstas, bet šalia rodomas 🔗 mygtukas, kuris nuorodą atidaro naujoje kortelėje.',
          '„Data" — pasirenkate datą iš kalendoriaus. Vienas iš datos stulpelių gali būti pažymėtas kaip „Kito veiksmo data" — būtent jis vėliau naudojamas Kalendoriaus skiltyje.',
          '„Išskleidžiamasis sąrašas" (dropdown) — statusui ir panašiems laukams, kur reikšmes galima nuspalvinti (pvz., žalia — „susitarta", raudona — „atsisakė").',
          '„Užrašas" (note) ir „Kontaktas" (contact) — specialūs tipai, kurie kaupia istoriją, o ne tik vieną reikšmę. Apie juos plačiau kitoje pamokoje.',
        ],
        image: 'table-columns.png',
      },
      {
        heading: 'Naujo stulpelio/eilutės pridėjimas',
        body: [
          'Naujam stulpeliui pridėti — lentelės dešiniajame krašte spauskite „+". Naujai eilutei — apačioje spauskite „+ Pridėti eilutę".',
          'Dešiniu pelės mygtuku paspaudę ant stulpelio pavadinimo ar eilutės numerio, gaunate Excel stiliaus meniu: įterpti stulpelį/eilutę prieš arba po, ištrinti, kopijuoti, įklijuoti, ar paslėpti.',
          'Stulpelio ar eilutės pavadinimą/numerį galite pažymėti (paspausti ir tempti pelę) — tada tas kelias eilutes/stulpelius galima ištrinti, nuspalvinti ar perkelti visus iš karto.',
        ],
      },
      {
        heading: 'Paslėpti stulpeliai ir eilutės',
        body: [
          'Jeigu stulpelis ar eilutė šiuo metu nereikalinga, bet duomenų trinti nenorite — paslėpkite (dešiniu klavišu → „Slėpti"). Duomenys niekur nedingsta, jie tiesiog nerodomi.',
          'Kai turite paslėptų stulpelių ar eilučių, viršutinėje mygtukų juostoje atsiranda mygtukas „🔒 Paslėpta: N" — paspaudus jį, matote sąrašą, ką galite vėl parodyti.',
        ],
      },
    ],
  },
  {
    id: 'notes-and-contacts',
    title: 'Užrašai ir kontaktai',
    category: 'Lentelė',
    summary: 'Kaip veikia užrašų istorija, greiti žymos mygtukai, kontaktų sąrašas ir balso žinutės.',
    sections: [
      {
        body: [
          'Spustelėję ant „Užrašas" tipo langelio, atsidaro platesnis langas su visa to įrašo istorija (naujausi viršuje). Kiekvienas įrašas turi savo datą ir laiką.',
          'Viršuje esantis laukelis „Pridėti komentarą…" — čia rašote naują pastabą, Enter arba ✓ mygtukas ją išsaugo.',
          'Po juo — greiti mygtukai („Laiškas", „Skambutis", ir kt.) — vienu paspaudimu prideda standartinę žymą, pasirinkus, su kuriuo kontaktu tai susiję.',
        ],
        image: 'note-editor.png',
      },
      {
        heading: '🎤 Balso žinutė (naujiena)',
        body: [
          'Šalia ✓ mygtuko yra 🎤 mikrofono mygtukas. Paspaudus jį, telefonas/kompiuteris paprašys leidimo naudoti mikrofoną — leiskite.',
          'Kalbėkite lietuviškai. Baigę — dar kartą paspauskite mygtuką (jis tuo metu raudonas ir mirksi — reiškia, kad įrašinėja). Įrašas automatiškai atpažįstamas į tekstą ir įrašomas į komentaro laukelį — dar galite jį peržiūrėti ir pataisyti prieš išsaugant.',
          'Pats garso įrašas niekur nesaugomas — lieka tik atpažintas tekstas.',
        ],
      },
      {
        heading: 'Kontaktų sąrašas',
        body: [
          '„Kontaktas" tipo langelyje galima laikyti kelis žmones vienoje eilutėje (pvz., kelis skirtingus įmonės kontaktinius asmenis). Kiekvienas turi vardą, pareigas, el. paštą, telefoną.',
          'Prie telefono/el. pašto yra kopijavimo mygtukai, o prie telefono — mygtukas paskambinti tiesiai iš skambučio žadinimo (jei ši funkcija įjungta).',
          'Galite tiesiog įklijuoti nutvarkytą (net kelių eilučių) tekstą iš kitos sistemos ar LinkedIn — programa pati per DI išvalys ir atskirs vardą/pareigas/el. paštą/telefoną.',
        ],
      },
    ],
  },
  {
    id: 'search-filter-paste',
    title: 'Paieška, žymėjimas ir kopijavimas',
    category: 'Lentelė',
    summary: 'Kaip ieškoti lentelėje, žymėti kelias eilutes/stulpelius, kopijuoti ir įklijuoti iš Excel.',
    sections: [
      {
        body: [
          'Viršuje esanti paieškos juostelė ieško per visus matomus stulpelius vienu metu (įskaitant telefono numerius, net jei jie skirtingai suformatuoti).',
          'Norėdami pažymėti kelias eilutes ar stulpelius vienu metu — paspauskite ir tempkite pelę per eilučių numerius arba stulpelių raides. Pažymėjimas dabar tęsiasi ir už matomo ekrano ribų — lentelė pati slenka, kol vedate pelę prie krašto.',
          'Kopijuoti/įklijuoti veikia lygiai kaip Excel: pažymėkite langelius (Ctrl/Cmd+C), persijunkite (ar ne) į kitą vietą, ir įklijuokite (Ctrl/Cmd+V) — veikia ir tarp šios programos ir tikro Excel/Google Sheets.',
        ],
      },
      {
        heading: 'Stulpelių pavadinimų įklijavimas iš karto',
        body: [
          'Jei Excel turite paruoštą stulpelių pavadinimų eilutę (pvz., „Įmonė, Telefonas, Kontaktas, Statusas"), nebūtina kiekvieną pervadinti atskirai: nukopijuokite tą eilutę Excel, atidarykite pirmo stulpelio meniu (⋮ → „Pavadinimas" laukelis) ir įklijuokite — automatiškai pervadins tiek stulpelių, kiek reikšmių įklijuota.',
        ],
      },
    ],
  },
  {
    id: 'csv-import-export',
    title: 'CSV importas ir eksportas',
    category: 'Lentelė',
    summary: 'Kaip įkelti duomenis iš Excel/CSV failo ir kaip išsaugoti lentelę atgal į CSV.',
    sections: [
      {
        body: [
          '„Importuoti CSV" mygtukas viršuje leidžia įkelti CSV failą. Programa pirma parodys, kaip kiekvieną CSV stulpelį susieti su esamu ar nauju lentelės stulpeliu — galite pasirinkti praleisti nereikalingus stulpelius.',
          '„Eksportuoti CSV" išsaugo visą (ne tik matomą po paieškos) lentelės turinį į CSV failą — jį galima atsidaryti Excel programoje.',
        ],
      },
    ],
  },
  {
    id: 'calendar',
    title: 'Kalendorius ir sekantys veiksmai',
    category: 'Kalendorius',
    summary: 'Kaip veikia „Kito veiksmo data" stulpelis ir kalendoriaus/užduočių sąrašo vaizdas.',
    sections: [
      {
        body: [
          'Lentelėje pažymėję vieną „Data" tipo stulpelį kaip „Kito veiksmo data" (per stulpelio meniu), tos datos automatiškai atsiranda Kalendoriaus skiltyje.',
          'Kalendoriaus skiltis turi du vaizdus: sąrašo (suskirstyta į „Vėluojama", „Šiandien", „Artimiausi") ir mėnesio tinklelio.',
          'Paspaudus ant įrašo kalendoriuje — „Atidaryti lentelėje" nukelia tiesiai į tą eilutę lentelėje ir trumpam ją paryškina, kad būtų lengva rasti.',
        ],
        image: 'calendar.png',
      },
      {
        heading: 'Laikas ir konkretus kontaktas',
        body: [
          'Prie datos galima papildomai nustatyti tikslų laiką (🕐 mygtukas) arba pasirinkti, su kuriuo konkrečiai kontaktu (jei jų kelios) susijęs šis veiksmas (👤 mygtukas).',
        ],
      },
    ],
  },
  {
    id: 'calls',
    title: 'Skambučiai',
    category: 'Skambučiai',
    summary: 'Skambučių sąrašas, įrašai, atpažinimas į tekstą ir statistika.',
    sections: [
      {
        body: [
          '„Skambučiai" skiltis rodo šios dienos skambučių sąrašą (spauskite „Load calls", kad įkeltumėte).',
          'Jei skambutis buvo įrašytas, prie jo matote 📝 „Transcribe" mygtuką — jį paspaudus, įrašas automatiškai atpažįstamas į tekstą (lietuviškai).',
          'Po atpažinimo atsiranda ir 🤖 „Summary" mygtukas — trumpa 3–5 sakinių santrauka, kas per pokalbį buvo aptarta.',
        ],
        image: 'calls.png',
      },
      {
        heading: 'Statistika',
        body: [
          'Antra pastraipa toje pačioje skiltyje rodo bendrą statistiką (kiek skambučių, kiek atsiliepta, pokalbio trukmė) savaitės/mėnesio pjūviu — ši istorija saugoma vietoje, tad nedings, net jei skambučių paslauga savo pusėje ją ištrintų po tam tikro laiko.',
        ],
      },
    ],
  },
  {
    id: 'apollo-search',
    title: 'Kontaktų paieška',
    category: 'Paieška',
    summary: 'Kaip ieškoti įmonių/žmonių ir pridėti juos su telefonu/el. paštu tiesiai į lentelę.',
    sections: [
      {
        body: [
          '„Paieška" skiltyje (arba paspaudus 🔍 ties Kontaktų langeliu lentelėje) galite ieškoti žmonių pagal pareigas, įmonę, šalį ir kt.',
          'Radę tinkamą žmogų — spauskite „+ Pridėti" — jis iškart atsiranda lentelėje su vardu ir el. paštu, o telefono numeris (jei jį pavyksta rasti) prisijungia po kelių sekundžių automatiškai, fone.',
          'Viršuje, šalia teminio mygtuko, gali atsirasti ženkliukas „🕐 N" — tai reiškia, kad fone dar ieškoma N telefono numerio/-ių; galite ramiai dirbti toliau kitose skiltyse, radus — gausite pranešimą.',
        ],
        image: 'apollo-search.png',
      },
    ],
  },
  {
    id: 'instantly-unibox',
    title: 'Paštas (Unibox)',
    category: 'Paštas',
    summary: 'Šalto pašto susirašinėjimų peržiūra, atsakymai ir analitika.',
    sections: [
      {
        body: [
          '„Paštas" → „Unibox" rodo visus laiškų pokalbius iš prijungtų pašto dėžučių. Kairėje — filtrai pagal statusą ir kampaniją.',
          'Paspaudus ant pokalbio, jis atsidaro per visą ekraną (sąrašas laikinai pasislepia — ☰ mygtukas jį grąžina). Apačioje visada matomi „↩ Atsakyti" / „↪ Persiųsti" mygtukai.',
          '„Analitika" skiltyje matote išsiuntimų/atsakymų grafiką ir pagrindinius rodiklius — galima rinktis laikotarpį, įskaitant „Visas laikotarpis".',
        ],
        image: 'instantly-unibox.png',
      },
    ],
  },
  {
    id: 'linkedin-overview',
    title: 'LinkedIn automatizavimas — apžvalga',
    category: 'LinkedIn',
    summary: 'Kas tai yra, kodėl reikia atskiro Chrome lango, ir kodėl viskas veikia lėtai/atsargiai.',
    sections: [
      {
        body: [
          'LinkedIn skiltis siunčia ryšio užklausas ir žinutes automatiškai, pagal iš anksto paruoštą seką — bet, priešingai nei kitos šios programos dalys, tai daroma imituojant realaus žmogaus veiksmus per naršyklę, ne per oficialų LinkedIn API (jo tokiems veiksmams tiesiog nėra).',
          'Todėl viskas veikia sąmoningai lėtai ir su dienos/savaitės limitais — tai apsaugo paskyrą. Viršuje visada matomas „⏸ Sustabdyti viską" mygtukas — juo galima akimirksniu sustabdyti visus automatinius veiksmus.',
          'Prieš naudojant, reikia atskirai paleisti Chrome su specialiu profiliu (žr. techninę dokumentaciją) ir vieną kartą jame prisijungti prie LinkedIn.',
        ],
      },
    ],
  },
];
