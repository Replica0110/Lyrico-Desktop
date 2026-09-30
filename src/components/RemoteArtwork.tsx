import { Avatar } from "antd";
import { useRemoteImage } from "../hooks/useRemoteImage";

export function RemoteArtwork({ url, size }: { url?: string; size: number }) {
  const { dataUrl } = useRemoteImage(url, 128);
  return <Avatar shape="square" size={size} src={dataUrl} />;
}
