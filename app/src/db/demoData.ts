// The in-memory data source for db.ts's DEMO_MODE branch — see
// utils/demoMode.ts. Every function here mirrors the signature of its
// db.ts counterpart exactly (same name, same params, same return shape)
// so db.ts's own bodies stay a one-line `if (DEMO_MODE) return
// demoData.xxx(...)` and nothing else in the app (useTableStore.ts,
// useWorkspaceStore.ts, every component) needs to know this exists.
//
// State lives in plain module-level variables, not a class or store —
// this module is only ever imported from db.ts, so there's exactly one
// instance per page load, which is also exactly the lifetime we want:
// buildSeed() runs once when this module first loads (a hard refresh, a
// new tab, a different browser) and there is nowhere for a change to be
// written that would outlive that load. This is what makes "every demo
// visitor always starts from the same clean dataset, and nothing one
// visitor does is ever visible to another" true with zero extra code.
import type { Column, Row, TableFolder, TableMeta } from '../types';
import { randomUUID } from '../utils/uuid';

// --- Seed data generator ---------------------------------------------
// Entirely generated — no real companies or people. Ported from the
// standalone demo project's own data/seed.ts (proven over several
// rounds of review this session), adapted to this app's real
// TableMeta/Row/Column shapes (order/createdAt/updatedAt on both Row and
// TableMeta, which the standalone project's simplified types omitted).

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

// Spread relative to the actual current date (not a fixed year) so the
// Calendar tab's Overdue/Today/Upcoming grouping always has something
// real to show regardless of when the demo happens to be opened.
function relativeDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function serializeContacts(entries: { id: string; text: string }[]): string {
  return JSON.stringify(entries);
}

function serializeNoteHistory(entries: { id: string; text: string; createdAt: number }[]): string {
  return JSON.stringify(entries);
}

const COMPANY_COUNT = 180;

function buildCompaniesTable(): { table: TableMeta; rows: Row[] } {
  const now = Date.now();
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
  const statusCol = col('Status', 'dropdown', { options: STATUSES, optionColors: STATUS_COLORS, isStatusColumn: true });
  const websiteCol = col('Website', 'link', { isWebsiteColumn: true });
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

  const tableId = randomUUID();
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
    const daysAgo = (n: number) => now - n * 24 * 60 * 60 * 1000;
    const noteEntries = [
      { id: randomUUID(), text: pick(CALL_NOTE_TEMPLATES, i), createdAt: daysAgo(1 + (i % 10)) },
      ...(i % 3 === 0 ? [{ id: randomUUID(), text: `Call ${p1.first} ${p1.last}`, createdAt: daysAgo(2 + (i % 14)) }] : []),
      ...(i % 5 === 0 ? [{ id: randomUUID(), text: `${p2.first} ${p2.last} Didn't answer`, createdAt: daysAgo(3 + (i % 9)) }] : []),
    ];
    const hasNextCall = i % 3 === 0;
    const nextCallOffset = i < 6 ? i - 2 : ((i * 5 + 2) % 40) - 15;
    return {
      id: randomUUID(),
      tableId,
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
      createdAt: now,
      updatedAt: now,
    };
  });

  const table: TableMeta = { id: tableId, name: 'Companies', columns, order: 0, createdAt: now, updatedAt: now };
  return { table, rows };
}

function buildPipelineTable(): { table: TableMeta; rows: Row[] } {
  const now = Date.now();
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

  const tableId = randomUUID();
  const rows: Row[] = Array.from({ length: 60 }, (_, i) => {
    const offsetDays = i < 3 ? i : ((i * 7 + 3) % 45) - 20;
    return {
      id: randomUUID(),
      tableId,
      cells: {
        [nameCol.id]: companyName(i + 200),
        [dealCol.id]: String(1000 * (5 + (i % 40))),
        [stageCol.id]: pick(['Prospecting', 'Qualified', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Closed Lost'], i * 3 + 1),
        [ownerCol.id]: pick(owners, i),
        [nextStepCol.id]: pick(nextSteps, i * 2 + 1),
        [dateCol.id]: relativeDate(offsetDays),
      },
      order: i,
      createdAt: now,
      updatedAt: now,
    };
  });

  const table: TableMeta = { id: tableId, name: 'Sales Pipeline', columns, order: 1, createdAt: now, updatedAt: now };
  return { table, rows };
}

interface DemoState {
  tables: TableMeta[];
  rowsByTableId: Map<string, Row[]>;
  folders: TableFolder[];
}

function buildSeed(): DemoState {
  const companies = buildCompaniesTable();
  const pipeline = buildPipelineTable();
  const rowsByTableId = new Map<string, Row[]>();
  rowsByTableId.set(companies.table.id, companies.rows);
  rowsByTableId.set(pipeline.table.id, pipeline.rows);
  return { tables: [companies.table, pipeline.table], rowsByTableId, folders: [] };
}

const state: DemoState = buildSeed();

// --- Functions mirroring db.ts's own exported signatures --------------

export async function loadTables(): Promise<TableMeta[]> {
  return state.tables;
}

export async function saveTable(table: TableMeta): Promise<void> {
  const i = state.tables.findIndex((t) => t.id === table.id);
  if (i === -1) {
    state.tables.push(table);
    if (!state.rowsByTableId.has(table.id)) state.rowsByTableId.set(table.id, []);
  } else {
    state.tables[i] = table;
  }
}

export async function getTable(id: string): Promise<TableMeta | null> {
  return state.tables.find((t) => t.id === id) ?? null;
}

export async function updateTableColumns(tableId: string, columns: TableMeta['columns']): Promise<void> {
  const table = state.tables.find((t) => t.id === tableId);
  if (table) table.columns = columns;
}

export async function updateTableName(tableId: string, name: string): Promise<void> {
  const table = state.tables.find((t) => t.id === tableId);
  if (table) table.name = name;
}

export async function setTableOwnerDB(): Promise<void> {
  // No worker/ownership concept in the demo (a single super_admin-like
  // user) — nothing to assign.
}

export async function updateTableBackupFlag(tableId: string, enabled: boolean): Promise<void> {
  const table = state.tables.find((t) => t.id === tableId);
  if (table) table.dailyBackupEnabled = enabled;
}

export async function setTableFolder(tableId: string, folderId: string | null): Promise<void> {
  const table = state.tables.find((t) => t.id === tableId);
  if (table) table.folderId = folderId;
}

export async function reorderTablesDB(updates: { id: string; order: number }[]): Promise<void> {
  for (const u of updates) {
    const table = state.tables.find((t) => t.id === u.id);
    if (table) table.order = u.order;
  }
}

export async function loadTableFolders(): Promise<TableFolder[]> {
  return state.folders;
}

export async function createTableFolderDB(folder: TableFolder): Promise<void> {
  state.folders.push(folder);
}

export async function renameTableFolderDB(id: string, name: string): Promise<void> {
  const folder = state.folders.find((f) => f.id === id);
  if (folder) folder.name = name;
}

export async function deleteTableFolderDB(id: string): Promise<void> {
  state.folders = state.folders.filter((f) => f.id !== id);
}

export async function reorderTableFoldersDB(updates: { id: string; order: number }[]): Promise<void> {
  for (const u of updates) {
    const folder = state.folders.find((f) => f.id === u.id);
    if (folder) folder.order = u.order;
  }
}

export async function countRowsForTable(tableId: string): Promise<number> {
  return state.rowsByTableId.get(tableId)?.length ?? 0;
}

export async function deleteTableDB(id: string): Promise<void> {
  state.tables = state.tables.filter((t) => t.id !== id);
  state.rowsByTableId.delete(id);
}

export async function loadRowsForTable(tableId: string): Promise<Row[]> {
  return state.rowsByTableId.get(tableId) ?? [];
}

export async function saveRow(row: Row): Promise<void> {
  const rows = state.rowsByTableId.get(row.tableId) ?? [];
  const i = rows.findIndex((r) => r.id === row.id);
  if (i === -1) rows.push(row);
  else rows[i] = row;
  state.rowsByTableId.set(row.tableId, rows);
}

export async function saveRows(rows: Row[]): Promise<void> {
  for (const row of rows) await saveRow(row);
}

export async function importRows(rows: Row[]): Promise<void> {
  await saveRows(rows);
}

export async function deleteRowsDB(ids: string[]): Promise<void> {
  const idSet = new Set(ids);
  for (const [tableId, rows] of state.rowsByTableId) {
    state.rowsByTableId.set(tableId, rows.filter((r) => !idSet.has(r.id)));
  }
}
