import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ExpandedState,
  type GroupingState,
  type SortingState
} from "@tanstack/react-table";
import type { Data } from "../data.js";
import { formatValue, humanize, isTone, keyOf, toText, type Tone, type ValueFormat } from "../format.js";
import { EmptyState, Frame, Withheld, useOverride, type NodeProps } from "../states.js";

export interface ColumnSpec {
  readonly field: string;
  readonly label?: string;
  readonly format?: ValueFormat;
  /** Value → tone, for a badge. */
  readonly tone?: Readonly<Record<string, Tone>>;
}

export interface RowAction<R> {
  readonly label: string;
  /** Shown for a row only when this holds for it. */
  readonly when?: (row: R) => boolean;
  readonly onClick: (row: R) => void;
}

export interface TableProps<R extends object> extends NodeProps {
  readonly data: Data<readonly R[]>;
  readonly columns: readonly ColumnSpec[];
  readonly selected?: string | null;
  readonly onSelect?: (row: R) => void;
  readonly groupBy?: string;
  readonly filters?: readonly string[];
  readonly search?: boolean;
  readonly pageSize?: number;
  readonly rowActions?: readonly RowAction<R>[];
  readonly empty?: string;
}

/** A cell as the runtime returned it: a value, a badge, or withheld when the row lacks it. */
export function Cell(props: { readonly row: Readonly<Record<string, unknown>>; readonly column: ColumnSpec }) {
  const { row, column } = props;
  const v = row[column.field];
  if (v === undefined && !Object.hasOwn(row, column.field)) return <Withheld />;
  const text = formatValue(v, column.format);
  const tone = column.tone && typeof v === "string" ? column.tone[v] : undefined;
  if (column.format === "badge" || tone) return <span className="ts-badge" data-tone={isTone(tone) ? tone : "neutral"}>{text}</span>;
  return <>{text}</>;
}

function TableBuiltIn<R extends object>(props: TableProps<R>) {
  const rows = useMemo(() => [...(props.data.value ?? [])], [props.data.value]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [grouping, setGrouping] = useState<GroupingState>(props.groupBy ? [props.groupBy] : []);
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  const columns = useMemo<ColumnDef<R>[]>(
    () =>
      props.columns.map((c) => ({
        id: c.field,
        header: c.label ?? humanize(c.field),
        accessorFn: (row: R) => (row as Record<string, unknown>)[c.field],
        cell: (info) => <Cell row={info.row.original as Record<string, unknown>} column={c} />,
        // A withheld value sorts last and matches no filter: it is not an empty string.
        sortUndefined: "last",
        filterFn: (row, id, want: string) => want === "" || String(row.getValue(id) ?? "\u0000") === want,
        getGroupingValue: (row: R) => toText((row as Record<string, unknown>)[c.field]) ?? "Withheld"
      })),
    [props.columns]
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter, columnFilters, grouping, expanded },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onGroupingChange: setGrouping,
    onExpandedChange: setExpanded,
    getRowId: (r, i) => keyOf(r, i),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: (row, _id, text: string) => {
      const t = text.trim().toLowerCase();
      return t === "" || props.columns.some((c) => (toText((row.original as Record<string, unknown>)[c.field]) ?? "").toLowerCase().includes(t));
    },
    initialState: { pagination: { pageSize: props.pageSize ?? 25 } }
  });
  const options = (field: string) => [...new Set(rows.map((r) => (r as Record<string, unknown>)[field]).filter((v): v is string | number | boolean => v !== undefined && v !== null && typeof v !== "object"))].sort();
  const pages = table.getPageCount();
  const visible = table.getRowModel().rows;
  const hasTools = props.search || (props.filters?.length ?? 0) > 0 || props.groupBy !== undefined;
  const tools = !hasTools ? undefined : (
    <>
      {props.search ? <input className="ts-input ts-search" type="search" placeholder="Search" aria-label={`Search ${props.title ?? "rows"}`} value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} /> : null}
      {(props.filters ?? []).map((f) => (
        <select
          key={f}
          className="ts-input"
          aria-label={`Filter by ${humanize(f)}`}
          value={(columnFilters.find((x) => x.id === f)?.value as string | undefined) ?? ""}
          onChange={(e) => setColumnFilters((fs) => [...fs.filter((x) => x.id !== f), ...(e.target.value ? [{ id: f, value: e.target.value }] : [])])}
        >
          <option value="">{humanize(f)}: all</option>
          {options(f).map((o) => (
            <option key={String(o)} value={String(o)}>
              {formatValue(o, props.columns.find((c) => c.field === f)?.format)}
            </option>
          ))}
        </select>
      ))}
      {props.groupBy ? (
        <button type="button" className="ts-link" aria-pressed={grouping.length > 0} onClick={() => setGrouping((g) => (g.length ? [] : [props.groupBy!]))}>
          {grouping.length ? "Ungroup" : `Group by ${humanize(props.groupBy)}`}
        </button>
      ) : null}
    </>
  );
  return (
    <Frame {...props} kind="table" pending={[props.data, ...(props.pending ?? [])]} actions={tools}>
      {rows.length === 0 ? (
        <EmptyState>{props.empty ?? "No rows you may see."}</EmptyState>
      ) : (
        <div className="ts-table-wrap">
          <table className="ts-table">
            <thead>
              {table.getHeaderGroups().map((g) => (
                <tr key={g.id}>
                  {g.headers.map((h) => {
                    const sorted = h.column.getIsSorted();
                    return (
                      <th key={h.id} aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}>
                        <button type="button" className="ts-th" onClick={h.column.getToggleSortingHandler()}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <span className="ts-sort" aria-hidden="true">
                            {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                  {props.rowActions?.length ? <th aria-label="Actions" /> : null}
                </tr>
              ))}
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={props.columns.length + (props.rowActions?.length ? 1 : 0)}>
                    <EmptyState>No rows match.</EmptyState>
                  </td>
                </tr>
              ) : null}
              {visible.map((row) =>
                row.getIsGrouped() ? (
                  <tr key={row.id} className="ts-group-row">
                    <td colSpan={props.columns.length + (props.rowActions?.length ? 1 : 0)}>
                      <button type="button" className="ts-link" onClick={row.getToggleExpandedHandler()} aria-expanded={row.getIsExpanded()}>
                        {row.getIsExpanded() ? "▾" : "▸"} {formatValue(row.groupingValue, props.columns.find((c) => c.field === row.groupingColumnId)?.format)}
                      </button>
                      <span className="ts-muted"> {row.subRows.length}</span>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={row.id}
                    data-row={row.id}
                    aria-selected={props.onSelect ? props.selected === row.id : undefined}
                    className={props.onSelect ? "ts-selectable" : undefined}
                    tabIndex={props.onSelect ? 0 : undefined}
                    onClick={props.onSelect ? () => props.onSelect!(row.original) : undefined}
                    onKeyDown={props.onSelect ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), props.onSelect!(row.original)) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                    {props.rowActions?.length ? (
                      <td className="ts-row-actions">
                        {props.rowActions
                          .filter((a) => !a.when || a.when(row.original))
                          .map((a) => (
                            <button
                              key={a.label}
                              type="button"
                              className="ts-button ts-small"
                              onClick={(e) => {
                                e.stopPropagation();
                                a.onClick(row.original);
                              }}
                            >
                              {a.label}
                            </button>
                          ))}
                      </td>
                    ) : null}
                  </tr>
                )
              )}
            </tbody>
          </table>
          {pages > 1 ? (
            <nav className="ts-pager" aria-label="Pages">
              <button type="button" className="ts-link" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
                Previous
              </button>
              <span className="ts-muted">
                Page {table.getState().pagination.pageIndex + 1} of {pages}
              </span>
              <button type="button" className="ts-link" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
                Next
              </button>
            </nav>
          ) : null}
        </div>
      )}
    </Frame>
  );
}

/**
 * An interactive table of what the runtime returned (ADR-0082): sorting,
 * search, filters and grouping run in the browser over those rows only, so
 * they never reveal a row the caller was not given.
 */
export function Table<R extends object>(props: TableProps<R>) {
  const C = useOverride("Table", TableBuiltIn<R>);
  return <C {...props} />;
}
