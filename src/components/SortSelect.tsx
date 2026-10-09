import { SortAscendingOutlined } from "@ant-design/icons";
import { Button, Dropdown } from "antd";
import { useTranslation } from "react-i18next";
import { defaultSortDirection, type SortState } from "../domain/sort";
export type SortFieldOption<K extends string = string> = { key: K; label: string };
export function SortSelect<K extends string>({ fields, value, onChange }: {
  fields: SortFieldOption<K>[]; value?: SortState<K>; onChange: (next?: SortState<K>) => void;
  fieldWidth?: number; directionWidth?: number;
}) {
  const { t } = useTranslation();
  return <Dropdown trigger={["click"]} menu={{
    selectable: true,
    selectedKeys: value ? [value.key, value.direction] : ["default"],
    items: [
      { key: "default", label: t("sort.default") },
      ...fields.map(field => ({ key: field.key, label: field.label })),
      { type: "divider" },
      { key: "asc", label: t("sort.asc"), disabled: !value },
      { key: "desc", label: t("sort.desc"), disabled: !value },
    ],
    onClick: ({key}) => {
      if (key === "default") onChange(undefined);
      else if ((key === "asc" || key === "desc") && value) onChange({...value, direction:key});
      else onChange({key:key as K, direction:defaultSortDirection(key)});
    },
  }}><Button icon={<SortAscendingOutlined />} aria-label={t("sort.label")}>
    {value ? fields.find(field => field.key === value.key)?.label : t("sort.label")}
  </Button></Dropdown>;
}
