// Adapted from app/src/utils/columnTypeLabels.ts — English labels,
// matching the demo's own established English-UI convention (see
// DemoToolbar.tsx's "Add row"/"Import CSV"/etc.) rather than production's
// Lithuanian ones.
import type { ColumnType } from '../types';

export const TYPE_LABELS: Record<ColumnType, string> = {
  text: 'Text',
  phone: 'Phone',
  company: 'Company',
  note: 'Note',
  contact: 'Contacts',
  dropdown: 'Dropdown (status)',
  date: 'Date',
  link: 'Link (website, LinkedIn…)',
};
