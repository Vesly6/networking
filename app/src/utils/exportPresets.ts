// Device-local export settings persistence — same defensive
// try/catch-on-every-access, lenient-JSON-parse-falls-back-to-default
// convention TableView.tsx's own loadPersistedViewState/saveViewState
// already establishes for per-table view state (search/filters). Chosen
// over a server-side company setting because the account owner's own spec
// describes this as remembering "между сессиями пользователя" (this
// user's own sessions), not a shared company default — a genuinely
// different, simpler shape than e.g. LinkedIn's company-wide `settings`
// table.
import type { ExportMode, AxisLimits } from './exportFlatten';
import { DEFAULT_AXIS_LIMITS } from './exportFlatten';

export interface ExportSettings {
  mode: ExportMode;
  format: 'csv' | 'xlsx';
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
  prettyFormat: boolean;
  contactsCell: boolean;
  contactsColumns: boolean;
  notesCell: boolean;
  notesColumns: boolean;
  repliesCell: boolean;
  repliesColumns: boolean;
  limits: AxisLimits;
}

export const BASE_DEFAULT_SETTINGS: ExportSettings = {
  mode: 'companies_only',
  format: 'xlsx',
  includeCompaniesWithoutContacts: false,
  onlyContactsWithEmail: false,
  prettyFormat: false,
  contactsCell: false,
  contactsColumns: false,
  notesCell: false,
  notesColumns: false,
  repliesCell: false,
  repliesColumns: false,
  limits: DEFAULT_AXIS_LIMITS,
};

export interface ExportPreset {
  name: string;
  settings: ExportSettings;
}

// The account owner's own three explicit examples (section 11) — always
// listed first in the dialog's preset picker, ahead of any user-saved one.
export const BUILT_IN_PRESETS: ExportPreset[] = [
  {
    name: 'Trumpai',
    settings: BASE_DEFAULT_SETTINGS,
  },
  {
    name: 'Rašyklai',
    settings: {
      ...BASE_DEFAULT_SETTINGS,
      mode: 'with_contacts',
      onlyContactsWithEmail: true,
      notesCell: true,
    },
  },
  {
    name: 'Pilnas ataskaita',
    settings: {
      ...BASE_DEFAULT_SETTINGS,
      contactsCell: true,
      contactsColumns: true,
      notesCell: true,
      notesColumns: true,
      repliesCell: true,
      repliesColumns: true,
      prettyFormat: true,
    },
  },
];

const PRESETS_KEY = 'export-dialog:presets:v1';
const LAST_USED_KEY = 'export-dialog:last-used:v1';

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadUserPresets(): ExportPreset[] {
  const parsed = safeParse<ExportPreset[]>(localStorage.getItem(PRESETS_KEY));
  return Array.isArray(parsed) ? parsed : [];
}

export function saveUserPreset(preset: ExportPreset): void {
  try {
    const rest = loadUserPresets().filter((p) => p.name !== preset.name);
    localStorage.setItem(PRESETS_KEY, JSON.stringify([...rest, preset]));
  } catch {
    // Private window / blocked storage — the export itself still works,
    // it just won't remember this preset next time.
  }
}

export function deleteUserPreset(name: string): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(loadUserPresets().filter((p) => p.name !== name)));
  } catch {
    // Nothing to do — see saveUserPreset's own comment.
  }
}

export function loadLastUsedSettings(): ExportSettings | null {
  return safeParse<ExportSettings>(localStorage.getItem(LAST_USED_KEY));
}

export function saveLastUsedSettings(settings: ExportSettings): void {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(settings));
  } catch {
    // See saveUserPreset's own comment.
  }
}
