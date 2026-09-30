import { CustomerServiceOutlined } from "@ant-design/icons";
import { Avatar } from "antd";
import { memo, useEffect, useRef, useState } from "react";
import type { AudioTrack } from "../app/types";
import { useImageDimensions } from "../hooks/useImageDimensions";
import { useTrackCover } from "../hooks/useTrackCovers";

type ArtworkTrack = Pick<AudioTrack, "coverDataUrl"> & Partial<Pick<AudioTrack, "path" | "hasCover">>;

export const TrackArtwork = memo(function TrackArtwork({ track, size, showDimensions = false }: { track?: ArtworkTrack; size: number; showDimensions?: boolean }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    const element = containerRef.current;
    if (!element || nearViewport || track?.coverDataUrl || !track?.path || !track.hasCover) return;
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport, track?.coverDataUrl, track?.hasCover, track?.path]);
  const lazyCover = useTrackCover(track?.path, nearViewport && Boolean(track?.hasCover));
  const coverDataUrl = track?.coverDataUrl ?? lazyCover;
  const dimensions = useImageDimensions(showDimensions ? coverDataUrl : undefined);

  if (coverDataUrl) {
    return (
      <span ref={containerRef} className="artwork-frame">
        <Avatar shape="square" src={coverDataUrl} size={size} className="artwork" />
        {dimensions ? <span className="cover-dimensions">{dimensions.width} × {dimensions.height}</span> : null}
      </span>
    );
  }

  return (
    <span ref={containerRef}>
      <Avatar shape="square" size={size} className="artwork fallback-artwork">
        <CustomerServiceOutlined />
      </Avatar>
    </span>
  );
});
