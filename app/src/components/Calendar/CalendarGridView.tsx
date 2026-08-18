import { useMemo, useState } from 'react';
import { useTableStore } from '../../store/useTableStore';
import { getLinkedContactName, getNextActionColumn, getPrimaryLabel } from '../../utils/row';
import { getDatePart, getMonthGrid, getTimePart, monthLabel, nextMonth, prevMonth, todayISO } from '../../utils/date';

interface CalendarGridViewProps {
  onJumpToRow: (rowId: string) => void;
}

const WEEKDAYS = ['Pr', 'An', 'Tr', 'Kt', 'Pn', 'Št', 'Sk'];
const MAX_VISIBLE_PER_DAY = 3;
// A single long unbroken word (no spaces) in a chip can force the whole
// calendar grid wider (see .calendar-day's min-width: 0 in App.css) — cap
// the label itself too so the chip stays a fixed size no matter what's typed.
const CHIP_LABEL_LIMIT = 15;

function truncateLabel(label: string): string {
  return label.length > CHIP_LABEL_LIMIT ? `${label.slice(0, CHIP_LABEL_LIMIT)}…` : label;
}

export function CalendarGridView({ onJumpToRow }: CalendarGridViewProps) {
  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);
  const [month, setMonth] = useState(() => new Date());

  const dateColumn = getNextActionColumn(columns);
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
        Joks datos stulpelis nepažymėtas kaip „kito veiksmo data“. Atidarykite datos stulpelio meniu (⋮)
        lentelėje ir įjunkite „Naudoti kalendoriuje / užduočių sąraše“.
      </div>
    );
  }

  return (
    <div className="calendar-grid-view">
      <div className="calendar-nav">
        <button type="button" onClick={() => setMonth((m) => prevMonth(m))}>
          ←
        </button>
        <strong className="calendar-month-label">{monthLabel(month)}</strong>
        <button type="button" onClick={() => setMonth((m) => nextMonth(m))}>
          →
        </button>
        <button type="button" className="calendar-today-btn" onClick={() => setMonth(new Date())}>
          Šiandien
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
              className={[
                'calendar-day',
                !day.inCurrentMonth && 'calendar-day-outside',
                day.iso === today && 'calendar-day-today',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="calendar-day-number">{day.date.getDate()}</div>
              <div className="calendar-day-tasks">
                {dayEntries.slice(0, MAX_VISIBLE_PER_DAY).map(({ row, value }) => {
                  const time = getTimePart(value);
                  const label = getPrimaryLabel(row, columns);
                  const contactName = getLinkedContactName(row, columns);
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className="calendar-chip"
                      onClick={() => onJumpToRow(row.id)}
                      title={contactName ? `${label} | ${contactName}` : label}
                    >
                      {time && <span className="calendar-chip-time">{time}</span>}
                      {truncateLabel(label)}
                    </button>
                  );
                })}
                {dayEntries.length > MAX_VISIBLE_PER_DAY && (
                  <span className="calendar-chip-more">+{dayEntries.length - MAX_VISIBLE_PER_DAY} daugiau</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
