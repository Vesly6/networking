import { useMemo, useState } from 'react';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { getNextActionColumn, getPrimaryLabel } from '../utils/row';
import { getDatePart, getMonthGrid, getTimePart, monthLabel, nextMonth, prevMonth, todayISO } from '../utils/date';
import type { DemoTable } from '../types';
import { ArrowLeft, ArrowRight } from 'lucide-react';

interface DemoCalendarGridViewProps {
  table: DemoTable;
  onJumpToRow: (rowId: string) => void;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_VISIBLE_PER_DAY = 3;
const CHIP_LABEL_LIMIT = 15;

function truncateLabel(label: string): string {
  return label.length > CHIP_LABEL_LIMIT ? `${label.slice(0, CHIP_LABEL_LIMIT)}…` : label;
}

/** A right-sized port of production's CalendarGridView.tsx — same month
 * grid + day-chip approach, minus the linked-contact/next-action-note
 * detail in each chip's tooltip (neither concept exists in this demo). */
export function DemoCalendarGridView({ table, onJumpToRow }: DemoCalendarGridViewProps) {
  const rows = useDemoTableStore((s) => s.rowsByTable[table.id] ?? []);
  const [month, setMonth] = useState(() => new Date());

  const dateColumn = getNextActionColumn(table.columns);
  const today = todayISO();

  const rowsByDay = useMemo(() => {
    const map = new Map<string, { row: (typeof rows)[number]; value: string }[]>();
    if (!dateColumn) return map;
    for (const row of rows) {
      const value = row.cells[dateColumn.id];
      if (!value) continue;
      const day = getDatePart(value);
      const list = map.get(day) ?? [];
      list.push({ row, value });
      map.set(day, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.value.localeCompare(b.value));
    return map;
  }, [rows, dateColumn]);

  const grid = useMemo(() => getMonthGrid(month), [month]);

  if (!dateColumn) {
    return (
      <div className="empty-state">
        No date column is flagged for the calendar yet. Right-click a date column's header and choose "Use in
        Calendar".
      </div>
    );
  }

  return (
    <div className="calendar-grid-view">
      <div className="calendar-nav">
        <button type="button" onClick={() => setMonth((m) => prevMonth(m))}>
          <ArrowLeft size={16} />
        </button>
        <strong className="calendar-month-label">{monthLabel(month)}</strong>
        <button type="button" onClick={() => setMonth((m) => nextMonth(m))}>
          <ArrowRight size={16} />
        </button>
        <button type="button" className="calendar-today-btn" onClick={() => setMonth(new Date())}>
          Today
        </button>
      </div>
      <div className="calendar-weekdays">
        {WEEKDAYS.map((d) => (
          <div key={d} className="calendar-weekday">
            {d}
          </div>
        ))}
      </div>
      <div className="calendar-grid">
        {grid.map((day) => {
          const dayEntries = rowsByDay.get(day.iso) ?? [];
          return (
            <div
              key={day.iso}
              className={['calendar-day', !day.inCurrentMonth && 'calendar-day-outside', day.iso === today && 'calendar-day-today']
                .filter(Boolean)
                .join(' ')}
            >
              <div className="calendar-day-number">{day.date.getDate()}</div>
              <div className="calendar-day-tasks">
                {dayEntries.slice(0, MAX_VISIBLE_PER_DAY).map(({ row, value }) => {
                  const time = getTimePart(value);
                  const label = getPrimaryLabel(row, table.columns);
                  return (
                    <button key={row.id} type="button" className="calendar-chip" onClick={() => onJumpToRow(row.id)} title={label}>
                      {time && <span className="calendar-chip-time">{time}</span>}
                      {truncateLabel(label)}
                    </button>
                  );
                })}
                {dayEntries.length > MAX_VISIBLE_PER_DAY && (
                  <span className="calendar-chip-more">+{dayEntries.length - MAX_VISIBLE_PER_DAY} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
