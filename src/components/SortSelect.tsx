import { Flex, Select } from "antd";
import { useTranslation } from "react-i18next";
import { defaultSortDirection, type SortDirection, type SortState } from "../domain/sort";

export type SortFieldOption<K extends string = string> = {
  key: K;
  label: string;
};

export function SortSelect<K extends string>({
  fields,
  value,
  onChange,
  fieldWidth = 156,
  directionWidth = 112,
}: {
  fields: SortFieldOption<K>[];
  value?: SortState<K>;
  onChange: (next?: SortState<K>) => void;
  fieldWidth?: number;
  directionWidth?: number;
}) {
  const { t } = useTranslation();
  const fallbackKey = fields[0]?.key;
  return (
    <Flex gap={8} align="center">
      <Select
        allowClear
        aria-label={t("sort.fieldLabel")}
        placeholder={t("sort.fieldLabel")}
        style={{ width: fieldWidth }}
        value={value?.key}
        options={fields.map((field) => ({ value: field.key, label: field.label }))}
        onChange={(key?: K) => {
          if (key == null) {
            onChange(undefined);
            return;
          }
          onChange({ key, direction: value?.direction ?? defaultSortDirection(key) });
        }}
      />
      <Select
        aria-label={t("sort.directionLabel")}
        placeholder={t("sort.directionLabel")}
        style={{ width: directionWidth }}
        value={value?.direction}
        options={[
          { value: "asc" satisfies SortDirection, label: t("sort.asc") },
          { value: "desc" satisfies SortDirection, label: t("sort.desc") },
        ]}
        onChange={(direction: SortDirection) => {
          onChange({ key: value?.key ?? (fallbackKey as K), direction });
        }}
      />
    </Flex>
  );
}
