import { CustomerServiceOutlined } from "@ant-design/icons";
import { Avatar } from "antd";
import { memo } from "react";
import type { AudioTrack } from "../app/types";
import { useImageDimensions } from "../hooks/useImageDimensions";
import { useTrackCover } from "../hooks/useTrackCovers";
import { useNearViewport } from "../hooks/useNearViewport";
import { useArtistPoster } from "../hooks/useArtistPoster";

type ArtworkTrack = Pick<AudioTrack, "coverDataUrl"> & Partial<Pick<AudioTrack, "path" | "hasCover">>;

export const TrackArtwork = memo(function TrackArtwork({ track, size, showDimensions = false, posterFolder = "", artist = "" }: { track?: ArtworkTrack; size: number; showDimensions?: boolean; posterFolder?: string; artist?: string }) {
  const { ref: containerRef, nearViewport } = useNearViewport(JSON.stringify([track?.path, posterFolder, artist]), !track?.coverDataUrl);
  const poster = useArtistPoster(posterFolder, artist, nearViewport);
  const lazyCover = useTrackCover(track?.path, nearViewport && Boolean(track?.hasCover), size > 128);
  const coverDataUrl = track?.coverDataUrl ?? poster ?? lazyCover;
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
