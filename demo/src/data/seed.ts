// Entirely generated demo data — no real companies or people. Built
// programmatically from name-part lists rather than hand-typed so the
// demo has a realistic-feeling volume of rows (matches the request's
// "normal amount of data," not a 3-row toy table) without ever touching
// production data of any kind.
import type { Column, DemoTable, Row } from '../types';
import { randomUUID } from '../utils/uuid';
import { serializeContacts } from '../utils/contacts';
import { serializeNoteHistory, type NoteEntry } from '../utils/noteHistory';

const COMPANY_PREFIXES = [
  'Baltic', 'Nordic', 'Vilnius', 'Kaunas', 'Amber', 'Pine', 'Summit', 'Bright',
  'Clear', 'Prime', 'Swift', 'Metro', 'Horizon', 'Bridge', 'River', 'Union',
  'Alpine', 'Coastal', 'Nova', 'Delta', 'Apex', 'Vertex', 'Meridian', 'Anchor',
];
const COMPANY_SUFFIXES = [
  'Logistics', 'Digital', 'Solutions', 'Systems', 'Trading', 'Media', 'Foods',
  'Textiles', 'Consulting', 'Manufacturing', 'Retail', 'Analytics', 'Robotics',
  'Energy', 'Print', 'Freight', 'Studio', 'Works', 'Group', 'Partners', 'Labs',
];
const LEGAL_FORMS = ['UAB', 'MB', 'AB'];

const FIRST_NAMES = [
  'Jonas', 'Rūta', 'Mindaugas', 'Aistė', 'Tomas', 'Ieva', 'Darius', 'Gabija',
  'Vytautas', 'Kristina', 'Paulius', 'Milda', 'Andrius', 'Eglė', 'Rokas',
  'Justina', 'Karolis', 'Viktorija', 'Marius', 'Laura',
];
const LAST_NAMES = [
  'Kazlauskas', 'Petrauskienė', 'Jankauskas', 'Butkutė', 'Urbonas', 'Šimkutė',
  'Balčiūnas', 'Petrauskaitė', 'Vasiliauskas', 'Norkutė', 'Stankevičius',
  'Paulauskaitė', 'Žukauskas', 'Rimkutė', 'Baranauskas',
];
const TITLES = ['CEO', 'CFO', 'Sales Director', 'Marketing Manager', 'Procurement Lead', 'COO', 'Head of Operations'];

const INDUSTRIES = [
  'Logistics & Freight', 'Digital Marketing', 'Manufacturing', 'Food & Beverage',
  'Retail', 'IT Consulting', 'Textiles', 'Energy', 'Construction', 'Wholesale Trade',
];
const STATUSES = ['New', 'Contacted', 'In Progress', 'Won', 'Rejected'];
const STATUS_COLORS: Record<string, string> = {
  New: '#e5e7eb',
  Contacted: '#dbeafe',
  'In Progress': '#fef3c7',
  Won: '#d7f0da',
  Rejected: '#fdecec',
};

function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

function companyName(i: number): string {
  const legal = pick(LEGAL_FORMS, i);
  const prefix = pick(COMPANY_PREFIXES, i * 7 + 1);
  const suffix = pick(COMPANY_SUFFIXES, i * 13 + 3);
  return `${legal} "${prefix} ${suffix}"`;
}

function domain(i: number): string {
  const prefix = pick(COMPANY_PREFIXES, i * 7 + 1).toLowerCase();
  const suffix = pick(COMPANY_SUFFIXES, i * 13 + 3).toLowerCase();
  return `${prefix}${suffix}.lt`;
}

function personName(seed: number): { first: string; last: string } {
  return { first: pick(FIRST_NAMES, seed), last: pick(LAST_NAMES, seed * 3 + 2) };
}

// Spread relative to the *actual* current date (not a fixed year) so the
// Calendar tab's Overdue/Today/Upcoming grouping always has something
// real to show regardless of when the demo happens to be opened — a
// fixed-year date range would eventually drift entirely into the past.
function relativeDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const COMPANY_COUNT = 180;

function buildCompaniesTable(): { table: DemoTable; rows: Row[] } {
  const col = (name: string, type: Column['type'], extra: Partial<Column> = {}): Column => ({
    id: randomUUID(),
    name,
    type,
    ...extra,
  });

  const nameCol = col('Company', 'company');
  const industryCol = col('Industry', 'text');
  const icpCol = col('ICP', 'text');
  const contactsCol = col('Decision Makers', 'contact');
  const statusCol = col('Status', 'dropdown', {
    options: STATUSES,
    optionColors: STATUS_COLORS,
    isStatusColumn: true,
  });
  const websiteCol = col('Website', 'link');
  const phoneCol = col('Phone', 'phone');
  const employeesCol = col('Employees', 'text');
  const notesCol = col('Call Notes', 'note');
  const nextCallCol = col('Next Call', 'date', { isNextActionDate: true });

  const columns = [nameCol, industryCol, icpCol, contactsCol, statusCol, websiteCol, phoneCol, employeesCol, notesCol, nextCallCol];

  const CALL_NOTE_TEMPLATES = [
    'Initial call went well, interested in a demo',
    'Left a voicemail, will try again next week',
    'Requested pricing information by email',
    'Not the right time — follow up next quarter',
  ];

  const rows: Row[] = Array.from({ length: COMPANY_COUNT }, (_, i) => {
    const p1 = personName(i);
    const p2 = personName(i + 41);
    const contact1Id = randomUUID();
    const contacts = serializeContacts([
      {
        id: contact1Id,
        text: `${p1.first} ${p1.last}, ${pick(TITLES, i)}, ${p1.first.toLowerCase()}.${p1.last.toLowerCase()}@${domain(i)}, +370 6${(10000000 + i * 37) % 90000000}`,
      },
      {
        id: randomUUID(),
        text: `${p2.first} ${p2.last}, ${pick(TITLES, i + 5)}, ${p2.first.toLowerCase()}.${p2.last.toLowerCase()}@${domain(i)}`,
      },
    ]);
    const daysAgo = (n: number) => Date.now() - n * 24 * 60 * 60 * 1000;
    const noteEntries: NoteEntry[] = [
      { id: randomUUID(), text: pick(CALL_NOTE_TEMPLATES, i), createdAt: daysAgo(1 + (i % 10)) },
      ...(i % 3 === 0 ? [{ id: randomUUID(), text: 'Email', createdAt: daysAgo(2 + (i % 14)) }] : []),
    ];
    // Only a fraction of rows get a next-call date at all (matches
    // production's own "most rows never touch this" reality) — every 3rd
    // row, spread across a realistic overdue/today/upcoming window. A
    // fraction of *those* also get a linked contact and/or a next-action
    // note, so both the 👤 and 📝 buttons are visible somewhere without
    // every row looking identical.
    const hasNextCall = i % 3 === 0;
    const nextCallOffset = i < 6 ? i - 2 : ((i * 5 + 2) % 40) - 15;
    return {
      id: randomUUID(),
      tableId: nameCol.id, // placeholder, replaced below once tableId is known
      linkedContactId: hasNextCall && i % 2 === 0 ? contact1Id : undefined,
      nextActionNote: hasNextCall && i % 4 === 0 ? 'Ask about budget approval timeline' : undefined,
      cells: {
        [nameCol.id]: companyName(i),
        [industryCol.id]: pick(INDUSTRIES, i),
        [icpCol.id]: `${pick(['SMB', 'Mid-market', 'Enterprise'], i)} companies needing ${pick(INDUSTRIES, i + 2).toLowerCase()} services`,
        [contactsCol.id]: contacts,
        [statusCol.id]: pick(STATUSES, i * 5 + 1),
        [websiteCol.id]: domain(i),
        [phoneCol.id]: `+370 5${(2000000 + i * 91) % 8000000}`,
        [nextCallCol.id]: hasNextCall ? relativeDate(nextCallOffset) : '',
        [employeesCol.id]: `${10 + (i % 12) * 15}-${50 + (i % 12) * 20}`,
        [notesCol.id]: serializeNoteHistory(noteEntries),
      },
      order: i,
    };
  });

  const table: DemoTable = { id: randomUUID(), name: 'Companies', columns };
  const finalRows = rows.map((r) => ({ ...r, tableId: table.id }));
  return { table, rows: finalRows };
}

function buildPipelineTable(): { table: DemoTable; rows: Row[] } {
  const col = (name: string, type: Column['type'], extra: Partial<Column> = {}): Column => ({
    id: randomUUID(),
    name,
    type,
    ...extra,
  });

  const nameCol = col('Company', 'company');
  const dealCol = col('Deal Value (€)', 'text');
  const stageCol = col('Stage', 'dropdown', {
    options: ['Prospecting', 'Qualified', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Closed Lost'],
    optionColors: {
      Prospecting: '#e5e7eb',
      Qualified: '#dbeafe',
      'Proposal Sent': '#fef3c7',
      Negotiation: '#fde4c8',
      'Closed Won': '#d7f0da',
      'Closed Lost': '#fdecec',
    },
    isStatusColumn: true,
  });
  const ownerCol = col('Owner', 'text');
  const nextStepCol = col('Next Step', 'text');
  const dateCol = col('Next Action', 'date', { isNextActionDate: true });

  const columns = [nameCol, dealCol, stageCol, ownerCol, nextStepCol, dateCol];
  const owners = ['Jonas K.', 'Rūta P.', 'Tomas B.', 'Ieva N.'];
  const nextSteps = ['Send follow-up email', 'Schedule demo call', 'Prepare proposal', 'Confirm contract terms', 'Check in after trial'];

  // A few rows land exactly on today/tomorrow so the Calendar's
  // Overdue/Today sections are never empty on a fresh load.
  const rows: Row[] = Array.from({ length: 60 }, (_, i) => {
    const offsetDays = i < 3 ? i : ((i * 7 + 3) % 45) - 20;
    return {
      id: randomUUID(),
      tableId: nameCol.id,
      cells: {
        [nameCol.id]: companyName(i + 200),
        [dealCol.id]: String(1000 * (5 + (i % 40))),
        [stageCol.id]: pick(['Prospecting', 'Qualified', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Closed Lost'], i * 3 + 1),
        [ownerCol.id]: pick(owners, i),
        [nextStepCol.id]: pick(nextSteps, i * 2 + 1),
        [dateCol.id]: relativeDate(offsetDays),
      },
      order: i,
    };
  });

  const table: DemoTable = { id: randomUUID(), name: 'Sales Pipeline', columns };
  const finalRows = rows.map((r) => ({ ...r, tableId: table.id }));
  return { table, rows: finalRows };
}

export interface SeedResult {
  tables: DemoTable[];
  rowsByTable: Record<string, Row[]>;
}

/** Called fresh on every page load (see useDemoTableStore.ts) — a brand
 * new object graph every time, never the same array/row-id twice across
 * sessions, so there's nothing any prior visitor's session could ever
 * leak into a new one even if some reference were accidentally held
 * onto. */
export function buildSeedData(): SeedResult {
  const companies = buildCompaniesTable();
  const pipeline = buildPipelineTable();
  return {
    tables: [companies.table, pipeline.table],
    rowsByTable: {
      [companies.table.id]: companies.rows,
      [pipeline.table.id]: pipeline.rows,
    },
  };
}
