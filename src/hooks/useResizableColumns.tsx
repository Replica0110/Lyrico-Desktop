import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type ThHTMLAttributes } from "react";
import type { TableColumnsType, TableColumnType } from "antd";

export type BoundedColumn<T> = TableColumnType<T> & {
  minWidth?: number;
  maxWidth?: number;
};

type ResizableHeaderProps = ThHTMLAttributes<HTMLTableCellElement> & {
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  onResize?: (width: number) => void;
  children?: ReactNode;
};

export function useResizableColumns<T>(source: BoundedColumn<T>[]) {
  const [widths, setWidths] = useState<Record<string, number>>(() => Object.fromEntries(
    source.map((column, index) => [columnId(column, index), numericWidth(column.width, column.minWidth ?? 80)]),
  ));
  const columns = source.map((column, index) => {
    const id = columnId(column, index);
    const minWidth = column.minWidth ?? 64;
    const maxWidth = column.maxWidth ?? 720;
    const width = clamp(widths[id] ?? numericWidth(column.width, minWidth), minWidth, maxWidth);
    return {
      ...column,
      width,
      onHeaderCell: () => ({
        width,
        minWidth,
        maxWidth,
        onResize: (nextWidth: number) => setWidths((current) => ({ ...current, [id]: nextWidth })),
      }),
    };
  }) as TableColumnsType<T>;

  return { columns, components: { header: { cell: ResizableHeaderCell } } };
}

function ResizableHeaderCell({ width, minWidth = 64, maxWidth = 720, onResize, children, style, ...rest }: ResizableHeaderProps) {
  const startResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!width || !onResize) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => onResize(clamp(startWidth + moveEvent.clientX - startX, minWidth, maxWidth));
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  const resizeByKeyboard = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (!width || !onResize) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 8;
    onResize(clamp(width + (event.key === "ArrowRight" ? step : -step), minWidth, maxWidth));
  };
  return (
    <th {...rest} style={{ ...style, width, minWidth, maxWidth, position: "relative" }}>
      {children}
      {onResize && (
        <span
          className="column-resize-handle"
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeByKeyboard}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </th>
  );
}

function columnId<T>(column: BoundedColumn<T>, index: number) {
  if (column.key != null) return String(column.key);
  if (Array.isArray(column.dataIndex)) return column.dataIndex.join(".");
  return column.dataIndex != null ? String(column.dataIndex) : `column-${index}`;
}

function numericWidth(width: TableColumnType<unknown>["width"], fallback: number) {
  return typeof width === "number" ? width : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}
