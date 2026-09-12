import { useMemo } from 'react';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { getNextActionColumn, getPrimaryLabel } from '../utils/row';
import { formatDisplayDate, getTimePart, isDueToday, isOverdue } from '../utils/date';
import type { DemoTable, Row } from '../types';
import { ArrowRight } from 'lucide-react';

interface DemoTaskListViewProps {
  table: DemoTable;
  onJumpToRow: (rowId: string) => void;
}

/** A right-sized port of production's TaskListView.tsx — grouped
 * Overdue/Today/Upcoming list derived from whichever date column is
 * flagged isNextActionDate (see DemoColumnHeaderMenu's "Use in
 * Calendar" item). Deliberately dropped: the linked-contact/next-action-
 * note display (👤/📝 on the date cell) and the mobile row-collapse
 * toggle — neither exists in this demo's simpler date-cell UI. */
export function DemoTaskListView({ table, onJumpToRow }: DemoTaskListViewProps) {
  const rows = useDemoTableStore((s) => s.rowsByTable[table.id] ?? []);
  const dateColumn = getNextActionColumn(table.columns);

  const groups = useMemo(() => {
    if (!dateColumn) return null;
    const withDate = rows.map((row) => ({ row, date: row.cells[dateColumn.id] ?? '' })).filter((e) => e.date);
    const overdue = withDate.filter((e) => isOverdue(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    const today = withDate.filter((e) => isDueToday(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    const upcoming = withDate.filter((e) => !isOverdue(e.date) && !isDueToday(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    return { overdue, today, upcoming };
  }, [rows, dateColumn]);

  if (!dateColumn) {
    return (
      <div className="empty-state">
        No date column is flagged for the calendar yet. Right-click a date column's header and choose "Use in
        Calendar".
      </div>
    );
  }

  const renderItem = (row: Row) => {
    const dateValue = row.cells[dateColumn.id] ?? '';
    const time = getTimePart(dateValue);
    return (
      <li key={row.id} className="task-row">
        <span className="task-row-label">{getPrimaryLabel(row, table.columns)}</span>
        <span className="task-row-date">{formatDisplayDate(dateValue)}</span>
        {time && <span className="task-row-time">{time}</span>}
        <button type="button" className="task-open" onClick={() => onJumpToRow(row.id)}>
          Open in table <ArrowRight size={14} />
        </button>
      </li>
    );
  };

  const { overdue, today, upcoming } = groups!;

  return (
    <div className="task-list">
      {overdue.length > 0 && (
        <section className="task-section task-section-overdue">
          <h3>Overdue ({overdue.length})</h3>
          <ul>{overdue.map((e) => renderItem(e.row))}</ul>
        </section>
      )}
      <section className="task-section task-section-today">
        <h3>Today ({today.length})</h3>
        {today.length === 0 ? <p className="task-section-empty">Nothing due today.</p> : <ul>{today.map((e) => renderItem(e.row))}</ul>}
      </section>
      {upcoming.length > 0 && (
        <section className="task-section">
          <h3>Upcoming ({upcoming.length})</h3>
          <ul>{upcoming.map((e) => renderItem(e.row))}</ul>
        </section>
      )}
      {overdue.length === 0 && today.length === 0 && upcoming.length === 0 && (
        <div className="empty-state">No rows have a next-action date yet.</div>
      )}
    </div>
  );
}
