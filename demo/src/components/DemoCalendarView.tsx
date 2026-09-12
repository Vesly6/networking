import { useState } from 'react';
import { DemoTaskListView } from './DemoTaskListView';
import { DemoCalendarGridView } from './DemoCalendarGridView';
import type { DemoTable } from '../types';

interface DemoCalendarViewProps {
  table: DemoTable;
  onJumpToRow: (rowId: string) => void;
}

type Mode = 'list' | 'grid';

/** Copied structure from production's CalendarView.tsx — a plain
 * List/Grid mode switch over the same underlying data. */
export function DemoCalendarView({ table, onJumpToRow }: DemoCalendarViewProps) {
  const [mode, setMode] = useState<Mode>('list');

  return (
    <div className="calendar-view">
      <div className="calendar-mode-switch">
        <button type="button" className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>
          Task List
        </button>
        <button type="button" className={mode === 'grid' ? 'active' : ''} onClick={() => setMode('grid')}>
          Calendar
        </button>
      </div>
      {mode === 'list' ? (
        <DemoTaskListView table={table} onJumpToRow={onJumpToRow} />
      ) : (
        <DemoCalendarGridView table={table} onJumpToRow={onJumpToRow} />
      )}
    </div>
  );
}
