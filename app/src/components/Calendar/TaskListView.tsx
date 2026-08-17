import { useMemo } from 'react';
import { useTableStore } from '../../store/useTableStore';
import { getNextActionColumn, getPrimaryLabel } from '../../utils/row';
import { formatDisplayDate, getTimePart, isDueToday, isOverdue } from '../../utils/date';
import type { Row } from '../../types';

interface TaskListViewProps {
  onJumpToRow: (rowId: string) => void;
}

export function TaskListView({ onJumpToRow }: TaskListViewProps) {
  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);

  const dateColumn = getNextActionColumn(columns);

  const groups = useMemo(() => {
    if (!dateColumn) return null;
    const withDate = rows
      .map((row) => ({ row, date: row.cells[dateColumn.id] ?? '' }))
      .filter((entry) => entry.date);

    const overdue = withDate.filter((e) => isOverdue(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    const today = withDate.filter((e) => isDueToday(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    const upcoming = withDate.filter((e) => !isOverdue(e.date) && !isDueToday(e.date)).sort((a, b) => a.date.localeCompare(b.date));

    return { overdue, today, upcoming };
  }, [rows, dateColumn]);

  if (!dateColumn) {
    return (
      <div className="empty-state">
        No date column is marked as the "next action date". Open the menu (⋮) on the date column in the
        table and turn on "Use in calendar / task list".
      </div>
    );
  }

  const renderItem = (row: Row) => {
    const dateValue = row.cells[dateColumn.id] ?? '';
    const time = getTimePart(dateValue);
    return (
      <li key={row.id} className="task-row">
        <span className="task-row-label">{getPrimaryLabel(row, columns)}</span>
        <span className="task-row-date">{formatDisplayDate(dateValue)}</span>
        {time && <span className="task-row-time">{time}</span>}
        <button type="button" className="task-open" onClick={() => onJumpToRow(row.id)}>
          Open in table →
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
        {today.length === 0 ? (
          <p className="task-section-empty">No calls scheduled for today.</p>
        ) : (
          <ul>{today.map((e) => renderItem(e.row))}</ul>
        )}
      </section>
      {upcoming.length > 0 && (
        <section className="task-section">
          <h3>Upcoming ({upcoming.length})</h3>
          <ul>{upcoming.map((e) => renderItem(e.row))}</ul>
        </section>
      )}
      {overdue.length === 0 && today.length === 0 && upcoming.length === 0 && (
        <div className="empty-state">No company has a next action date yet.</div>
      )}
    </div>
  );
}
