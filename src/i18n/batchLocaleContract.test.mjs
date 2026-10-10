import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
describe("batch translation contract", () => {
  it("resolves literal page, field and result labels in both languages", () => {
    const sources = ["../pages/TasksPage.tsx", "../components/BatchTable.tsx"].map(read);
    for (const locale of ["zh-CN", "en-US"]) {
      const resource = Object.assign({}, ...["common", "library", "editor", "settings", "plugins", "tasks"].map(file => JSON.parse(read(`./locales/${locale}/${file}.json`))));
      for (const source of sources) {
        for (const [, key] of source.matchAll(/"((?:tasks|common|details|lyrics|table|selection|songs)\.[a-zA-Z0-9.]+)"/g)) {
          let value = key.split(".").reduce((value, part) => value?.[part], resource);
          if (value === undefined) value = `${key}_other`.split(".").reduce((value, part) => value?.[part], resource);
          expect(typeof value, `${locale}: ${key}`).toBe("string");
        }
      }
    }
  });
});
