import { HolderOutlined } from "@ant-design/icons";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import "./SortableList.css";

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

const dropAnimation: DropAnimation = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: "0.4" } },
  }),
};

/** Pure drop resolution: same math for the live draft and the final commit. */
export function resolveDropOrder(items: string[], active: string, over: string | null): string[] {
  if (!over || over === active) return items;
  const from = items.indexOf(active);
  const to = items.indexOf(over);
  if (from < 0 || to < 0) return items;
  return moveItem(items, from, to);
}

/**
 * dnd-kit pointer sorting. Native HTML5 drag/drop is intercepted by the desktop
 * webview, so this uses dnd-kit's own pointer + keyboard sensors with a
 * DragOverlay that follows the cursor.
 */
export function SortableList({ items, onChange, label, renderItem, labelFor }: {
  items: string[]; onChange: (items: string[]) => void; label: string;
  renderItem: (key: string) => ReactNode; labelFor: (key: string) => string;
}) {
  const { t } = useTranslation();
  const itemsRef = useRef(items);
  const itemKeys = items.join("\u0000");
  itemsRef.current = items;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const activeIdRef = useRef<string | null>(null);
  const draftRef = useRef<string[] | null>(null);
  const baselineRef = useRef<string[]>(items);
  const lastAnnounceRef = useRef<{ key: string; at: number } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // External updates (settings reload / plugin refresh) win while no drag is in flight.
  useEffect(() => {
    if (activeIdRef.current === null) {
      baselineRef.current = itemsRef.current;
      draftRef.current = null;
      setDraft(null);
    }
  }, [itemKeys]);

  const rendered = draft ?? items;
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;
  const activeKey = activeId && rendered.includes(activeId) ? activeId : null;

  function positionOf(key: string) {
    return renderedRef.current.indexOf(key) + 1;
  }

  function announce(key: string, order: string[]) {
    const at = Date.now();
    const last = lastAnnounceRef.current;
    // Keyboard drags emit onDragOver synchronously per key press; one live message per move.
    if (last && last.key === key && at - last.at < 60) return;
    lastAnnounceRef.current = { key, at };
    setLiveMessage(t("common.reorderPosition", {
      name: labelFor(key),
      position: order.indexOf(key) + 1,
      total: order.length,
    }));
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    activeIdRef.current = id;
    const baseline = [...itemsRef.current];
    baselineRef.current = baseline;
    draftRef.current = baseline;
    setDraft(baseline);
    setActiveId(id);
  }

  function handleDragOver(event: DragOverEvent) {
    const active = String(event.active.id);
    const over = event.over ? String(event.over.id) : null;
    const current = draftRef.current ?? itemsRef.current;
    const next = resolveDropOrder(current, active, over);
    if (next === current) return;
    draftRef.current = next;
    setDraft(next);
    announce(active, next);
  }

  function handleDragEnd(event: DragEndEvent) {
    const active = String(event.active.id);
    const over = event.over ? String(event.over.id) : null;
    const baseline = baselineRef.current;
    const current = draftRef.current ?? baseline;
    // Resolve from the drop target rather than the last onDragOver render:
    // key events can queue several moves before React commits the draft.
    const next = resolveDropOrder(current, active, over);

    activeIdRef.current = null;
    draftRef.current = null;
    setActiveId(null);
    setDraft(null);

    // Commit once, on drop only: callers persist the order (Plugins writes to disk).
    const changed = next.length === baseline.length && next.some((key, index) => key !== baseline[index]);
    if (!changed) return;
    baselineRef.current = next;
    onChange(next);
    announce(active, next);
  }

  function handleDragCancel() {
    activeIdRef.current = null;
    draftRef.current = null;
    setActiveId(null);
    setDraft(null);
  }

  const screenReaderInstructions: ScreenReaderInstructions = {
    draggable: t("common.reorderHint"),
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => t("common.reorderPosition", {
      name: labelFor(String(active.id)),
      position: positionOf(String(active.id)),
      total: renderedRef.current.length,
    }),
    onDragMove: ({ active }) => t("common.reorderPosition", {
      name: labelFor(String(active.id)),
      position: positionOf(String(active.id)),
      total: renderedRef.current.length,
    }),
    onDragOver: ({ active }) => t("common.reorderPosition", {
      name: labelFor(String(active.id)),
      position: positionOf(String(active.id)),
      total: renderedRef.current.length,
    }),
    onDragEnd: ({ active }) => t("common.reorderPosition", {
      name: labelFor(String(active.id)),
      position: positionOf(String(active.id)),
      total: renderedRef.current.length,
    }),
    onDragCancel: ({ active }) => t("common.reorderPosition", {
      name: labelFor(String(active.id)),
      position: positionOf(String(active.id)),
      total: renderedRef.current.length,
    }),
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      accessibility={{ announcements, screenReaderInstructions }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="reorder-list" role="list" aria-label={label}>
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {rendered.map(key => (
            <SortableRow
              key={key}
              id={key}
              dragging={activeKey === key}
              reorderLabel={t("common.reorderItem", { name: labelFor(key) })}
              reorderHint={t("common.reorderHint")}
            >
              {renderItem(key)}
            </SortableRow>
          ))}
        </SortableContext>
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeKey
          ? <div className="reorder-overlay">
            <span className="reorder-handle is-overlay" aria-hidden="true"><HolderOutlined /></span>
            <div className="reorder-content">{renderItem(activeKey)}</div>
          </div>
          : null}
      </DragOverlay>
      <span className="sr-only" role="status" aria-live="polite">{liveMessage}</span>
    </DndContext>
  );
}

function SortableRow({ id, dragging, reorderLabel, reorderHint, children }: {
  id: string; dragging: boolean;
  reorderLabel: string; reorderHint: string; children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    // dnd-kit hands out its own transition string while sorting/settling; keep it.
    transition,
    opacity: dragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className={`reorder-row${dragging ? " is-dragging" : ""}`}>
      <button
        type="button"
        className="reorder-handle"
        data-reorder-handle="true"
        aria-label={reorderLabel}
        title={reorderHint}
        {...attributes}
        {...listeners}
      >
        <HolderOutlined />
      </button>
      <div className="reorder-content">{children}</div>
    </div>
  );
}
