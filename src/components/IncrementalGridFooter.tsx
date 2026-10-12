import { Spin } from "antd";
import { useTranslation } from "react-i18next";
import type { RefCallback } from "react";

export function IncrementalGridFooter({ sentinelRef, hasMore, loadingMore }: {
  sentinelRef: RefCallback<HTMLDivElement>; hasMore: boolean; loadingMore: boolean;
}) {
  const { t } = useTranslation();
  if (!hasMore) return null;
  return <div ref={sentinelRef} className="collection-grid-sentinel" role="status" aria-live="polite" aria-busy={loadingMore}>
    {loadingMore ? <><Spin size="small" /><span>{t("library.loadingMore")}</span></> : null}
  </div>;
}
