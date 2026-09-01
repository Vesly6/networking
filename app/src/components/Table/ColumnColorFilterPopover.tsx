import { Popover } from '../Popover';

// Sentinel for "filter to cells with NO color set" — on explicit request
// ("нам нужно добавить Default цвет... уберать все цвета"), distinct from
// any real hex color a user could actually paint a cell (those are always
// real "#rrggbb" strings from ColorInput, never this literal). Exported so
// TableView's filter-matching logic and this popover agree on the exact
// same value.
export const NO_COLOR_FILTER_VALUE = '__no_color__';

interface ColumnColorFilterPopoverProps {
  anchor: HTMLElement;
  columnName: string;
  /** Every distinct color actually painted somewhere in this column right
   * now (see TableView's own computation) — on explicit request, this is
   * not a fixed palette, only whatever colors genuinely appear in the
   * table, same as Excel's own "Filter by Cell Color" only ever lists
   * colors present in the range. The NO_COLOR_FILTER_VALUE swatch is
   * always shown in addition to these (see below), not included here. */
  availableColors: string[];
  current: string | undefined;
  onApply: (color: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** Additive alongside sort and the numeric range filter (see
 * NumericRangeFilterPopover's own doc comment for that one's reasoning —
 * this is the same "a genuinely different operation from sorting, hides
 * rows rather than reordering them" idea, applied to cell color instead
 * of a numeric range). One color at a time, same one-click-applies
 * simplicity as A→Z/Z→A — click a swatch to filter to just that color,
 * click it again (or "Išvalyti") to clear. TableView tracks these as a
 * map (colorFilters), so filters on several columns can be active
 * together, same as the numeric range filters already are.
 *
 * The first swatch is always "Numatytoji" (Default/no color) — this menu
 * item is only ever reachable when the column has at least one colored
 * cell (ColumnHeaderMenu's own gate), which means it can ALSO have
 * uncolored ones worth filtering to separately ("отфильтровать и цвета
 * зеленого не было бы" — show rows that AREN'T green). Rendered with a
 * diagonal-stripe pattern instead of a solid fill, the same convention
 * design tools use for "no fill" — a plain white/transparent square would
 * be easy to mistake for an actual pale color, especially against this
 * app's own zebra-striped row background (a real, distinct thing from
 * this per-cell paint — see App.css's row-striping rules — the stripe
 * pattern here is deliberately unrelated to that, just a visual "empty"
 * marker). */
export function ColumnColorFilterPopover({ anchor, columnName, availableColors, current, onApply, onClear, onClose }: ColumnColorFilterPopoverProps) {
  const apply = (color: string) => {
    onApply(color);
    onClose();
  };
  return (
    <Popover anchor={anchor}>
      <div className="popover-field-label">Filtruoti „{columnName}“ (spalva)</div>
      <div className="column-color-filter-swatches">
        <button
          type="button"
          className={`column-color-filter-swatch column-color-filter-swatch-none ${current === NO_COLOR_FILTER_VALUE ? 'active' : ''}`}
          title="Numatytoji (be spalvos)"
          onClick={() => apply(NO_COLOR_FILTER_VALUE)}
        />
        {availableColors.map((color) => (
          <button
            key={color}
            type="button"
            className={`column-color-filter-swatch ${current === color ? 'active' : ''}`}
            style={{ backgroundColor: color }}
            title={color}
            onClick={() => apply(color)}
          />
        ))}
      </div>
      <div className="popover-footer">
        <button
          type="button"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          Išvalyti
        </button>
      </div>
    </Popover>
  );
}
