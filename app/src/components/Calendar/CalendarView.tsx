import { useState } from 'react';
import { TaskListView } from './TaskListView';
import { CalendarGridView } from './CalendarGridView';

interface CalendarViewProps {
  onJumpToRow: (rowId: string) => void;
}

type Mode = 'list' | 'grid';

export function CalendarView({ onJumpToRow }: CalendarViewProps) {
  const [mode, setMode] = useState<Mode>('list');

  return (
    <div className="calendar-view">
      <div className="calendar-mode-switch">
        <button type="button" className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>
          Task list
        </button>
        <button type="button" className={mode === 'grid' ? 'active' : ''} onClick={() => setMode('grid')}>
          Calendar
        </button>
      </div>
      {mode === 'list' ? <TaskListView onJumpToRow={onJumpToRow} /> : <CalendarGridView onJumpToRow={onJumpToRow} />}
    </div>
  );
}
