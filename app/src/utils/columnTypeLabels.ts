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
