import { useMemo } from 'react';
import { useTableStore } from '../../store/useTableStore';
import { getLinkedContactName, getNextActionColumn, getNextActionPhone, getPrimaryLabel } from '../../utils/row';
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
        Joks datos stulpelis nepažymėtas kaip „kito veiksmo data“. Atidarykite datos stulpelio meniu (⋮)
        lentelėje ir įjunkite „Naudoti kalendoriuje / užduočių sąraše“.
      </div>
    );
  }

  const renderItem = (row: Row) => {
    const dateValue = row.cells[dateColumn.id] ?? '';
    const time = getTimePart(dateValue);
    // Name AND number, not just one or the other — showing only the phone
    // (an earlier version of this) was a real, reported regression: a
    // bare number looks identical whether or not a specific contact was
    // ever picked via the date cell's 👤 button, so there was no visible
    // sign the pick actually took effect. The name answers "who did I
    // choose," the number is still what a call queue needs to act on.
    const contactName = getLinkedContactName(row, columns);
    const phone = getNextActionPhone(row, columns);
    const whoLabel = contactName && phone ? `${contactName} · ${phone}` : contactName || phone;
    return (
      <li key={row.id} className="task-row">
        <span className="task-row-label">
          {getPrimaryLabel(row, columns)}
          {whoLabel && <span className="task-row-contact"> | {whoLabel}</span>}
        </span>
        {row.nextActionNote && (
          <span className="task-row-note" title={row.nextActionNote}>
            {row.nextActionNote}
          </span>
        )}
        <span className="task-row-date">{formatDisplayDate(dateValue)}</span>
        {time && <span className="task-row-time">{time}</span>}
        <button type="button" className="task-open" onClick={() => onJumpToRow(row.id)}>
          Atverti lentelėje →
        </button>
      </li>
    );
  };

  const { overdue, today, upcoming } = groups!;

  return (
    <div className="task-list">
      {overdue.length > 0 && (
        <section className="task-section task-section-overdue">
          <h3>Vėluoja ({overdue.length})</h3>
          <ul>{overdue.map((e) => renderItem(e.row))}</ul>
        </section>
      )}
      <section className="task-section task-section-today">
        <h3>Šiandien ({today.length})</h3>
        {today.length === 0 ? (
          <p className="task-section-empty">Šiandien skambučių nesuplanuota.</p>
        ) : (
          <ul>{today.map((e) => renderItem(e.row))}</ul>
        )}
      </section>
      {upcoming.length > 0 && (
        <section className="task-section">
          <h3>Artėjantys ({upcoming.length})</h3>
          <ul>{upcoming.map((e) => renderItem(e.row))}</ul>
        </section>
      )}
      {overdue.length === 0 && today.length === 0 && upcoming.length === 0 && (
        <div className="empty-state">Kol kas nė viena įmonė neturi kito veiksmo datos.</div>
      )}
    </div>
  );
}
