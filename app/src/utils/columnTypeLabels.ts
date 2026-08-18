import type { ColumnType } from '../types';

export const TYPE_LABELS: Record<ColumnType, string> = {
  text: 'Tekstas',
  phone: 'Telefonas',
  company: 'Įmonė',
  note: 'Komentaras',
  contact: 'Kontaktai',
  dropdown: 'Išskleidžiamasis sąrašas (būsena)',
  date: 'Data',
  link: 'Nuoroda (svetainė, LinkedIn…)',
};
