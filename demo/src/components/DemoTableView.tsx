import { useMemo, useState } from 'react';
import type { DemoTable } from '../types';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { DemoDataCell } from './DemoDataCell';
import { DemoToolbar } from './DemoToolbar';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface DemoTableViewProps {
  table: DemoTable;
}

type SortState = { columnId: string; direction: 'asc' | 'desc' } | null;

/** A right-sized rebuild of the real TableView.tsx's core spreadsheet
 * interactions (search, sort, single-cell edit, row select+delete,
 * import/export) for the demo's own, much smaller feature scope — no
 * virtualization (row counts here are in the low hundreds, not tens of
 * thousands), no multi-cell range selection/copy-paste, no worker
 * permissions. Every column type click-to-edit follows the exact same
 * DataCell.tsx convention the real app uses (see DemoDataCell). */
export function DemoTableView({ table }: DemoTableViewProps) {
  const rows = useDemoTableStore((s) => s.rowsByTable[table.id] ?? []);
  const updateCell = useDemoTableStore((s) => s.updateCell);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [activeCell, setActiveCell] = useState<{ rowId: string; columnId: string } | null>(null);
  const [openContactsRowId, setOpenContactsRowId] = useState<string | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  const filteredSortedRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows;
    if (q) {
      list = list.filter((r) => Object.values(r.cells).some((v) => v.toLowerCase().includes(q)));
    }
    if (sort) {
      const { columnId, direction } = sort;
      list = [...list].sort((a, b) => {
        const av = a.cells[columnId] ?? '';
        const bv = b.cells[columnId] ?? '';
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
        return direction === 'asc' ? cmp : -cmp;
      });
    } else {
      list = [...list].sort((a, b) => a.order - b.order);
    }
    return list;
  }, [rows, query, sort]);

  const toggleSort = (columnId: string) => {
    setSort((prev) => {
      if (!prev || prev.columnId !== columnId) return { columnId, direction: 'asc' };
      if (prev.direction === 'asc') return { columnId, direction: 'desc' };
      return null;
    });
  };

  const toggleRowSelected = (rowId: string) => {
    setSelectedRowIds((prev) => (prev.includes(rowId) ? prev.filter((id) => id !== rowId) : [...prev, rowId]));
  };

  return (
    <div className="demo-table-view">
      <DemoToolbar
        tableId={table.id}
        tableName={table.name}
        columns={table.columns}
        rows={rows}
        query={query}
        onQueryChange={setQuery}
        selectedRowIds={selectedRowIds}
        onClearSelection={() => setSelectedRowIds([])}
      />
      <div className="demo-table-scroll">
        <table className="demo-sheet">
          <thead>
            <tr>
              <th className="demo-th-checkbox" />
              {table.columns.map((col) => (
                <th key={col.id} onClick={() => toggleSort(col.id)} className="demo-th-sortable">
                  <span>{col.name}</span>
                  {sort?.columnId === col.id && (sort.direction === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredSortedRows.map((row) => (
              <tr key={row.id} className={selectedRowIds.includes(row.id) ? 'demo-row-selected' : ''}>
                <td className="demo-td-checkbox">
                  <input type="checkbox" checked={selectedRowIds.includes(row.id)} onChange={() => toggleRowSelected(row.id)} />
                </td>
                {table.columns.map((col) => (
                  <DemoDataCell
                    key={col.id}
                    row={row}
                    column={col}
                    editable={activeCell?.rowId === row.id && activeCell.columnId === col.id}
                    highlightQuery={query}
                    onSelect={(e) => {
                      // preventDefault matters here, not just convention:
                      // this mousedown swaps the clicked <button> for a
                      // live, auto-focused <input> synchronously, within
                      // this same event — without preventDefault, the
                      // browser's own default mousedown-focus handling
                      // (which still targets the now-removed button)
                      // runs right after and steals focus back to
                      // document.body, firing a spurious blur that
                      // immediately re-collapses the cell before a real
                      // user ever gets a chance to type. Confirmed live.
                      e.preventDefault();
                      setActiveCell({ rowId: row.id, columnId: col.id });
                    }}
                    onCommit={(value) => {
                      updateCell(table.id, row.id, col.id, value);
                      setActiveCell(null);
                    }}
                    onOpenContacts={() => setOpenContactsRowId(row.id)}
                    contactsOpen={openContactsRowId === row.id}
                    onCloseContacts={() => setOpenContactsRowId(null)}
                  />
                ))}
              </tr>
            ))}
            {filteredSortedRows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length + 1} className="demo-empty-state">
                  No rows match "{query}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
