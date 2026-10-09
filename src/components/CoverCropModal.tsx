import { Alert, Modal, Select, Space, Typography } from "antd";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useImageDimensions } from "../hooks/useImageDimensions";
import { createCenteredCrop, cropImage, resizeCrop, type CropHandle, type CropRect } from "../utils/coverCrop";

const { Text } = Typography;

type DragState = {
  handle: CropHandle;
  pointerX: number;
  pointerY: number;
  rect: CropRect;
  bounds: DOMRect;
};

const ratioOptions = [
  { value: "free", ratio: null },
  { value: "1", ratio: 1 },
  { value: "1.3333333333", ratio: 4 / 3 },
  { value: "1.7777777778", ratio: 16 / 9 },
] as const;

export function CoverCropModal({
  open,
  source,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  source?: string;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const dimensions = useImageDimensions(open ? source : undefined);
  const [ratio, setRatio] = useState<number | null>(1);
  const [crop, setCrop] = useState<CropRect>({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !dimensions) return;
    setRatio(1);
    setCrop(createCenteredCrop(dimensions.width, dimensions.height, 1));
    setError(undefined);
  }, [dimensions, open, source]);

  function changeRatio(value: string) {
    const nextRatio = ratioOptions.find((option) => option.value === value)?.ratio ?? null;
    setRatio(nextRatio);
    if (dimensions) setCrop(createCenteredCrop(dimensions.width, dimensions.height, nextRatio));
  }

  function beginDrag(handle: CropHandle, event: ReactPointerEvent<HTMLElement>) {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      handle,
      pointerX: event.clientX,
      pointerY: event.clientY,
      rect: crop,
      bounds,
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    const dx = (event.clientX - drag.pointerX) / drag.bounds.width;
    const dy = (event.clientY - drag.pointerY) / drag.bounds.height;
    const imageAspect = dimensions ? dimensions.width / dimensions.height : drag.bounds.width / drag.bounds.height;
    setCrop(resizeCrop(drag.rect, drag.handle, dx, dy, ratio, imageAspect, drag.bounds));
  }

  function endDrag() {
    dragRef.current = undefined;
  }

  async function confirm() {
    if (!source) return;
    setSaving(true);
    setError(undefined);
    try {
      onConfirm(await cropImage(source, crop));
      onCancel();
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setSaving(false);
    }
  }

  const ratioValue = ratioOptions.find((option) => option.ratio === ratio)?.value ?? "free";
  const handles: CropHandle[] = ratio == null
    ? ["topLeft", "top", "topRight", "right", "bottomRight", "bottom", "bottomLeft", "left"]
    : ["topLeft", "topRight", "bottomRight", "bottomLeft"];

  return (
    <Modal centered
      title={t("cover.crop")}
      open={open}
      width={760}
      okText={t("cover.applyCrop")}
      confirmLoading={saving}
      okButtonProps={{ disabled: !source || !dimensions }}
      destroyOnHidden
      onOk={() => void confirm()}
      onCancel={onCancel}
    >
      <Space orientation="vertical" size={12} className="full-width">
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <Select
          value={ratioValue}
          className="full-width"
          options={ratioOptions.map((option) => ({
            value: option.value,
            label: option.ratio == null ? t("cover.ratioFree") : option.ratio === 1 ? "1:1" : option.ratio === 4 / 3 ? "4:3" : "16:9",
          }))}
          onChange={changeRatio}
        />
        <div className="cover-crop-viewport">
          {source ? (
            <div
              ref={stageRef}
              className="cover-crop-stage"
              style={dimensions ? {
                aspectRatio: `${dimensions.width} / ${dimensions.height}`,
                width: `min(100%, ${(520 * dimensions.width) / dimensions.height}px)`,
              } : undefined}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <img src={source} alt="" draggable={false} />
              {dimensions ? (
                <div
                  className="cover-crop-selection"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                  onPointerDown={(event) => beginDrag("center", event)}
                >
                  <i className="cover-crop-grid vertical one" />
                  <i className="cover-crop-grid vertical two" />
                  <i className="cover-crop-grid horizontal one" />
                  <i className="cover-crop-grid horizontal two" />
                  {handles.map((handle) => (
                    <i
                      key={handle}
                      className={`cover-crop-handle ${handle}`}
                      onPointerDown={(event) => beginDrag(handle, event)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {dimensions ? (
          <Text type="secondary">
            {t("cover.cropSourceSize", { width: dimensions.width, height: dimensions.height })}
          </Text>
        ) : null}
      </Space>
    </Modal>
  );
}
